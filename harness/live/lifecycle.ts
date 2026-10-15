import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Cause, Effect, Exit, Option } from "effect";
import { redactLive } from "./redact.ts";

type ResourceKind = "file" | "transfer";

const failureMessage = (cause: Cause.Cause<unknown>) =>
  Cause.prettyErrors(cause)
    .map((error) => redactLive(`${error.name}: ${error.message}`))
    .join("; ");

export interface LiveAttempt {
  files: number[];
  transfers: number[];
  pending: { sequence: number; kind: ResourceKind }[];
  nextSequence: number;
  evidence: Record<string, unknown>;
  /** Private reconciliation hints; written only to the recovery journal. */
  recovery?: Record<string, unknown>;
  outcome?: LiveOutcome;
}

interface CleanupEvidence {
  status: "not-needed" | "acknowledged" | "uncertain";
  count: number;
  error?: string;
}

export interface LiveOutcome {
  status: "passed" | "failed";
  primary: {
    status: "passed" | "failed" | "timed-out" | "cancelled";
    error?: string;
  };
  cleanup: {
    status: "acknowledged" | "uncertain";
    files: CleanupEvidence;
    transfers: CleanupEvidence;
    pendingAcquisitions: number;
    /** Independently checked absence, kept apart from acknowledgement. */
    verification?: Verification;
    reconcileError?: string;
    recoveryError?: string;
  };
}

export type Verification = "not-needed" | "verified" | "present" | "unverified";

export const createLiveAttempt = (): LiveAttempt => ({
  files: [],
  transfers: [],
  pending: [],
  nextSequence: 0,
  evidence: {},
});

export const writeRecoveryJournal = Effect.fn("live.writeRecoveryJournal")(
  function* (attempt: LiveAttempt, path: string) {
    // An interrupted caller still waits for its write, so the write never
    // races the next one on the temporary file.
    yield* Effect.tryPromise(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await chmod(dirname(path), 0o700);
      const temporary = `${path}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify(
          {
            files: attempt.files,
            transfers: attempt.transfers,
            pending: attempt.pending,
            ...(attempt.recovery ? { recovery: attempt.recovery } : {}),
            cleanup: attempt.outcome?.cleanup,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      await chmod(temporary, 0o600);
      await rename(temporary, path);
    }).pipe(Effect.uninterruptible);
  },
);

export const trackAcquisition = Effect.fn("live.trackAcquisition")(function* <
  A extends { id: number },
  E,
  R,
>(
  attempt: LiveAttempt,
  kind: ResourceKind,
  acquire: Effect.Effect<A, E, R>,
  checkpoint: Effect.Effect<void, unknown>,
) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const pending = { sequence: attempt.nextSequence++, kind };
      attempt.pending.push(pending);
      yield* checkpoint;
      const resource = yield* restore(acquire);
      const owned = kind === "file" ? attempt.files : attempt.transfers;
      if (!owned.includes(resource.id)) owned.push(resource.id);
      attempt.pending = attempt.pending.filter((item) => item !== pending);
      yield* checkpoint;
      return resource;
    }),
  );
});

interface LifecycleOperations {
  /** Attributes resources a lost response left pending, before any cleanup. */
  reconcile?: Effect.Effect<void, unknown>;
  cancelTransfers: (ids: readonly number[]) => Effect.Effect<void, unknown>;
  deleteFiles: (ids: readonly number[]) => Effect.Effect<void, unknown>;
  /** Confirms after cleanup that put.io no longer lists the owned resources. */
  verify?: Effect.Effect<Verification, unknown>;
  checkpoint: Effect.Effect<void, unknown>;
  publish: (outcome: LiveOutcome) => Effect.Effect<void, unknown>;
}

const cleanupResource = Effect.fn("live.cleanupResource")(function* (
  ids: readonly number[],
  remove: (ids: readonly number[]) => Effect.Effect<void, unknown>,
) {
  if (ids.length === 0)
    return { status: "not-needed", count: 0 } satisfies CleanupEvidence;
  const result = yield* Effect.exit(
    remove(ids).pipe(Effect.interruptible, Effect.timeout("20 seconds")),
  );
  return Exit.isSuccess(result)
    ? ({ status: "acknowledged", count: ids.length } satisfies CleanupEvidence)
    : ({
        status: "uncertain",
        count: ids.length,
        error: failureMessage(result.cause),
      } satisfies CleanupEvidence);
});

export const withLiveLifecycle = Effect.fn("live.withLiveLifecycle")(function* <
  A,
  E,
  R,
>(
  attempt: LiveAttempt,
  work: Effect.Effect<A, E, R>,
  operations: LifecycleOperations,
) {
  return yield* work.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const error = Exit.isFailure(exit)
          ? Cause.findErrorOption(exit.cause)
          : Option.none();
        const primary: LiveOutcome["primary"] = Exit.isSuccess(exit)
          ? { status: "passed" }
          : {
              status: Cause.hasInterrupts(exit.cause)
                ? "cancelled"
                : Option.isSome(error) && Cause.isTimeoutError(error.value)
                  ? "timed-out"
                  : "failed",
              error: failureMessage(exit.cause),
            };
        const reconciled = operations.reconcile
          ? yield* Effect.exit(
              operations.reconcile.pipe(
                Effect.interruptible,
                Effect.timeout("2 minutes"),
              ),
            )
          : Exit.void;
        const transfers = yield* cleanupResource(
          attempt.transfers,
          operations.cancelTransfers,
        );
        const files = yield* cleanupResource(
          attempt.files,
          operations.deleteFiles,
        );
        const verification = operations.verify
          ? yield* operations.verify.pipe(
              Effect.interruptible,
              Effect.timeout("2 minutes"),
              Effect.orElseSucceed((): Verification => "unverified"),
            )
          : undefined;
        const uncertain =
          Exit.isFailure(reconciled) ||
          transfers.status === "uncertain" ||
          files.status === "uncertain" ||
          attempt.pending.length > 0;
        const outcome: LiveOutcome = {
          status:
            primary.status === "passed" &&
            !uncertain &&
            (verification === undefined || verification === "verified")
              ? "passed"
              : "failed",
          primary,
          cleanup: {
            status: uncertain ? "uncertain" : "acknowledged",
            files,
            transfers,
            pendingAcquisitions: attempt.pending.length,
            ...(verification ? { verification } : {}),
            ...(Exit.isFailure(reconciled)
              ? { reconcileError: failureMessage(reconciled.cause) }
              : {}),
          },
        };
        attempt.outcome = outcome;
        const checkpoint = yield* Effect.exit(operations.checkpoint);
        if (Exit.isFailure(checkpoint)) {
          outcome.status = "failed";
          outcome.cleanup.recoveryError = failureMessage(checkpoint.cause);
        }
        yield* operations.publish(outcome);
      }),
    ),
  );
});
