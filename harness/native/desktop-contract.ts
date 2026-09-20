import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import type { FrameEvidence } from "./desktop-evidence.ts";

export function movieAdvances(
  first: FrameEvidence | undefined,
  second: FrameEvidence | undefined,
  intervalMs: number | undefined,
) {
  return Boolean(
    first?.kind === "movie" &&
    second?.kind === "movie" &&
    first.intact &&
    second.intact &&
    intervalMs !== undefined &&
    intervalMs >= 1500 &&
    intervalMs <= 15_000 &&
    first.marker >= 0 &&
    second.marker > first.marker &&
    second.marker - first.marker <= Math.ceil(intervalMs / 1000) + 1 &&
    first.pixelsHash !== second.pixelsHash,
  );
}

export interface DesktopRunProof {
  status?: string;
  remaining?: readonly string[];
  freshState?: boolean;
  cleanup?: boolean;
  servicesClosed?: boolean;
  error?: string;
}

export function desktopRunPassed(run: DesktopRunProof) {
  return (
    run.status === "passed" &&
    run.remaining?.length === 0 &&
    run.freshState === true &&
    run.cleanup === true &&
    run.servicesClosed === true &&
    !run.error
  );
}

export function desktopAttemptPassed(attempt: {
  runs: readonly DesktopRunProof[];
  runtime: { kind: "linux-local"; cleaned: boolean };
  cleanupErrors: readonly string[];
  error?: string;
}) {
  return (
    !attempt.error &&
    attempt.runtime.cleaned &&
    attempt.cleanupErrors.length === 0 &&
    attempt.runs.length === 2 &&
    attempt.runs.every(desktopRunPassed)
  );
}

export interface DesktopDirectory {
  path: string;
  removed: boolean;
  retain: boolean;
  cleanupError?: string;
}

export const acquireDesktopDirectory = Effect.acquireRelease(
  Effect.tryPromise(async (): Promise<DesktopDirectory> => ({
    path: await mkdtemp("/tmp/chill-desktop-"),
    removed: false,
    retain: false,
  })),
  (directory) =>
    Effect.promise(async () => {
      if (directory.retain) return;
      try {
        await rm(directory.path, { recursive: true, force: true });
        directory.removed = true;
      } catch (cause) {
        directory.retain = true;
        directory.cleanupError =
          cause instanceof Error ? cause.message : String(cause);
      }
    }),
);
