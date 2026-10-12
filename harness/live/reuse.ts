import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { NodeRuntime } from "@effect/platform-node";
import { Cause, Effect, Option, Schema, Semaphore } from "effect";
import { isCredential, redactCredentials } from "../../src/credential.ts";
import { createEngineRpc, EngineError } from "../../src/engine.ts";
import { reserve } from "./allowance.ts";
import {
  createLiveAttempt,
  trackAcquisition,
  withLiveLifecycle,
  writeRecoveryJournal,
} from "./lifecycle.ts";
import * as putio from "./putio.ts";
import { liveRunnerDirectory } from "./runner.ts";
import { reuseSource } from "./source.ts";
import { liveVersions } from "./versions.ts";

class ReuseProbeFailure extends Schema.TaggedError<ReuseProbeFailure>()(
  "ReuseProbeFailure",
  { stage: Schema.String },
) {}

type ProviderTransfer = typeof putio.Transfer.Type;

export interface ReuseProvider {
  accountInfo: () => Effect.Effect<{ username: string }, unknown>;
  listFolderIds: (id: number) => Effect.Effect<readonly number[], unknown>;
  getTransfer: (id: number) => Effect.Effect<ProviderTransfer, unknown>;
  listTransfers: () => Effect.Effect<readonly ProviderTransfer[], unknown>;
  cancelTransfers: (ids: readonly number[]) => Effect.Effect<void, unknown>;
}

export interface ReuseOptions {
  credential: string;
  engineBaseUrl: string;
  username: string | undefined;
  ledgerDirectory: () => Promise<string>;
  provider: ReuseProvider;
  artifact: string;
  journal: string;
  nonce: string;
  burst?: number;
}

/** Matches Engine's magnet identity: the provider hash or a source topic. */
export function carriesInfoHash(transfer: ProviderTransfer, infoHash: string) {
  if (transfer.hash?.trim().toLowerCase() === infoHash) return true;
  return [transfer.source, transfer.magneturi].some((uri) => {
    if (!uri?.toLowerCase().startsWith("magnet:")) return false;
    return new URLSearchParams(uri.slice(uri.indexOf("?") + 1))
      .getAll("xt")
      .some((topic) => topic.trim().toLowerCase() === `urn:btih:${infoHash}`);
  });
}

export const runTransferReuse = Effect.fn("live.runTransferReuse")(function* (
  options: ReuseOptions,
) {
  const { provider } = options;
  const burst = options.burst ?? 3;
  const creations = 2 + burst;
  const source = reuseSource(options.nonce);
  const attempt = createLiveAttempt();
  const engineTransferIds: string[] = [];
  attempt.recovery = {
    infoHash: source.infoHash,
    name: source.name,
    engineTransferIds,
  };
  // Concurrent acquisitions would otherwise race on the journal's temporary file.
  const journal = Semaphore.makeUnsafe(1);
  const checkpoint = Semaphore.withPermit(journal)(
    writeRecoveryJournal(attempt, options.journal),
  );
  const labels: number[] = [];
  const label = (id: number) => {
    if (!labels.includes(id)) labels.push(id);
    return `t${labels.indexOf(id) + 1}`;
  };
  const calls: { phase: string; transfer: string }[] = [];
  const proof: Record<string, unknown> = {
    source: "generated-unseeded-magnet",
    credential: "designated-account",
    calls,
  };
  let stage = "configuration";
  let baselineClear = false;
  const fail = (at: string) => new ReuseProbeFailure({ stage: at });

  // A transfer is this run's only when put.io lists it under the run's
  // never-before-seen info hash; Engine's reported ID alone is not enough.
  const reconcile = Effect.gen(function* () {
    const listed = (yield* provider.listTransfers()).filter((transfer) =>
      carriesInfoHash(transfer, source.infoHash),
    );
    for (const transfer of listed)
      if (!attempt.transfers.includes(transfer.id))
        attempt.transfers.push(transfer.id);
    yield* checkpoint;
    return listed;
  });

  const work = Effect.gen(function* () {
    if (!isCredential(options.credential)) return yield* fail(stage);
    const rpc = yield* createEngineRpc({
      baseUrl: options.engineBaseUrl,
      credential: options.credential,
    });
    stage = "allowance";
    const ledgerDirectory = yield* Effect.tryPromise(options.ledgerDirectory);
    stage = "account";
    const account = yield* provider.accountInfo();
    if (!options.username || account.username !== options.username)
      return yield* fail(stage);
    stage = "account-binding";
    const [engineRoot, providerRoot] = yield* Effect.all(
      [
        rpc.call((call) => rpc.client.getFolder({ id: 0n }, call)),
        provider.listFolderIds(0),
      ],
      { concurrency: 2 },
    );
    const engineIds = engineRoot.files.map((file) => String(file.id)).sort();
    const providerIds = providerRoot.map(String).sort();
    if (providerIds.length === 0 || engineIds.join() !== providerIds.join())
      return yield* fail(stage);
    stage = "baseline";
    const before = yield* provider.listTransfers();
    if (before.some((transfer) => carriesInfoHash(transfer, source.infoHash)))
      return yield* fail(stage);
    baselineClear = true;
    stage = "reservation";
    const bytes = creations * source.bytes;
    yield* Effect.tryPromise((signal) =>
      reserve(ledgerDirectory, creations, bytes, undefined, { signal }),
    );
    proof.reservation = { creations, bytes };

    const add = (phase: string) =>
      trackAcquisition(
        attempt,
        "transfer",
        Effect.gen(function* () {
          const response = yield* rpc.call((call) =>
            rpc.client.addTransfer(
              { url: source.magnet },
              { ...call, timeoutMs: 30_000 },
            ),
          );
          const id = response.transfer?.id;
          if (id === undefined || id < 1n || id > Number.MAX_SAFE_INTEGER)
            return yield* fail("engine-response");
          engineTransferIds.push(String(id));
          const listed = yield* provider.getTransfer(Number(id));
          if (
            listed.id !== Number(id) ||
            !carriesInfoHash(listed, source.infoHash)
          )
            return yield* fail("attribution");
          calls.push({ phase, transfer: label(listed.id) });
          return { id: listed.id };
        }),
        checkpoint,
      );

    stage = "first-add";
    const first = yield* add("first");
    stage = "sequential-reuse";
    const second = yield* add("sequential");
    if (second.id !== first.id) return yield* fail(stage);
    stage = "concurrent-reuse";
    const concurrent = yield* Effect.all(
      Array.from({ length: burst }, () => add("concurrent")),
      { concurrency: "unbounded" },
    );
    if (concurrent.some((transfer) => transfer.id !== first.id))
      return yield* fail(stage);
    stage = "provider-state";
    const listed = yield* reconcile;
    const status = listed[0]?.status.trim().toUpperCase() ?? "";
    proof.providerTransfers = listed.length;
    if (/^[A-Z_]{1,32}$/.test(status)) proof.providerStatus = status;
    if (listed.length !== 1 || listed[0]?.id !== first.id || status === "ERROR")
      return yield* fail(stage);
  }).pipe(
    Effect.timeout("3 minutes"),
    Effect.catchCause((cause) => {
      const error = Cause.findErrorOption(cause);
      proof.failureStage =
        Option.isSome(error) && error.value instanceof ReuseProbeFailure
          ? error.value.stage
          : stage;
      if (Option.isSome(error) && error.value instanceof EngineError)
        proof.failureCode = error.value.code;
      const reconciled = baselineClear ? Effect.ignore(reconcile) : Effect.void;
      return reconciled.pipe(
        Effect.andThen(Effect.fail(fail(String(proof.failureStage)))),
      );
    }),
  );

  yield* withLiveLifecycle(attempt, work, {
    cancelTransfers: provider.cancelTransfers,
    deleteFiles: () => Effect.void,
    checkpoint,
    publish: (outcome) =>
      Effect.tryPromise(async () => {
        proof.distinctTransfers = labels.length;
        await mkdir(options.artifact, { recursive: true, mode: 0o700 });
        await writeFile(
          `${options.artifact}/results.json`,
          redactCredentials(
            `${JSON.stringify(
              {
                status: outcome.status,
                engine: URL.canParse(options.engineBaseUrl)
                  ? new URL(options.engineBaseUrl).origin
                  : "invalid",
                proof,
                primary: outcome.primary,
                cleanup: outcome.cleanup,
              },
              null,
              2,
            )}\n`,
          ),
          { mode: 0o600 },
        );
        console.log(`${options.artifact}/results.json`);
      }),
  });
  return attempt.outcome;
});

if (import.meta.main) {
  const stamp = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  NodeRuntime.runMain(
    runTransferReuse({
      credential: process.env.CHILL_STREMIO_CREDENTIAL?.trim() ?? "",
      engineBaseUrl:
        process.env.CHILL_ENGINE_BASE_URL?.trim() ||
        "https://api.chill.institute/v4",
      username: process.env[liveVersions.usernameEnv]?.trim(),
      ledgerDirectory: () => liveRunnerDirectory(),
      provider: putio,
      artifact: `artifacts/live-reuse-${stamp}`,
      journal: `.cache/live/recovery/reuse-${stamp}.json`,
      nonce: randomBytes(16).toString("hex"),
    }).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          if (outcome?.status !== "passed") process.exitCode = 1;
        }),
      ),
      Effect.catchCause(() =>
        Effect.sync(() => {
          process.exitCode = 1;
          console.log('{"status":"failed","code":"reuse_probe_failed"}');
        }),
      ),
    ),
    { disableErrorReporting: true },
  );
}
