import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { access, chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import {
  acquireDesktopDirectory,
  type DesktopDirectory,
  desktopAttemptPassed,
  movieAdvances,
  type DesktopRunProof,
} from "../harness/native/desktop-contract.ts";
import type { FrameEvidence } from "../harness/native/desktop-evidence.ts";

const frame = (marker: number, pixelsHash: string): FrameEvidence => ({
  width: 1280,
  height: 720,
  kind: "movie",
  identityPixels: 40_000,
  intact: true,
  borderCoverage: 1,
  marker,
  pixelsHash,
  subtitlePixels: 0,
  subtitleSpan: 0,
});

test("desktop movie proof requires separated advancing samples before seeking", () => {
  const first = frame(2, "first");
  const next = frame(4, "next");
  assert.equal(movieAdvances(first, next, 2000), true);
  for (const [second, interval] of [
    [first, 2000],
    [frame(2, "changed-ui"), 2000],
    [frame(4, "first"), 2000],
    [frame(23, "seek-destination"), 2000],
    [frame(1, "backward"), 2000],
    [{ ...next, kind: "episode1" }, 2000],
    [{ ...next, intact: false }, 2000],
    [next, 100],
    [next, undefined],
    [next, Number.NaN],
    [next, 16_000],
    [undefined, 2000],
  ] satisfies [FrameEvidence | undefined, number | undefined][]) {
    assert.equal(movieAdvances(first, second, interval), false);
  }
  assert.equal(movieAdvances(undefined, next, 2000), false);
});

test("desktop success requires both fresh runs and all teardown evidence", () => {
  const run: DesktopRunProof = {
    status: "passed",
    remaining: [],
    freshState: true,
    cleanup: true,
    servicesClosed: true,
  };
  const attempt = {
    runs: [run, run],
    runtime: { kind: "linux-local" as const, cleaned: true },
    cleanupErrors: [],
  };
  assert.equal(desktopAttemptPassed(attempt), true);
  for (const proof of ["freshState", "cleanup", "servicesClosed"] as const) {
    for (const value of [false, undefined]) {
      assert.equal(
        desktopAttemptPassed({
          ...attempt,
          runs: [run, { ...run, [proof]: value }],
        }),
        false,
        `${proof}=${String(value)}`,
      );
    }
  }
  for (const invalid of [
    { ...run, status: "blocked" },
    { ...run, remaining: ["pending-empty"] },
    { ...run, remaining: undefined },
    { ...run, error: "Guest interrupted" },
  ]) {
    assert.equal(
      desktopAttemptPassed({ ...attempt, runs: [run, invalid] }),
      false,
    );
  }
  assert.equal(desktopAttemptPassed({ ...attempt, runs: [run] }), false);
  assert.equal(
    desktopAttemptPassed({
      ...attempt,
      runtime: { kind: "linux-local", cleaned: false },
    }),
    false,
  );
  assert.equal(
    desktopAttemptPassed({
      ...attempt,
      cleanupErrors: ["owned process stop failed"],
    }),
    false,
  );
  assert.equal(
    desktopAttemptPassed({ ...attempt, error: "Startup failed" }),
    false,
  );
});

test("desktop startup failure removes only its private owned directory", async () => {
  let owned: DesktopDirectory | undefined;
  await assert.rejects(
    Effect.runPromise(
      Effect.gen(function* () {
        const directory = yield* acquireDesktopDirectory;
        owned = directory;
        const mode = yield* Effect.promise(() => stat(directory.path));
        assert.equal(mode.mode & 0o777, 0o700);
        yield* Effect.promise(() =>
          writeFile(`${directory.path}/partial`, "fixture evidence"),
        );
        return yield* Effect.fail(new Error("startup failure"));
      }).pipe(Effect.scoped),
    ),
    /startup failure/,
  );
  assert.ok(owned);
  assert.equal(owned.removed, true);
  await assert.rejects(access(owned.path));
});

test("desktop archival failure can retain evidence for recovery", async () => {
  const owned = await Effect.runPromise(
    Effect.gen(function* () {
      const directory = yield* acquireDesktopDirectory;
      directory.retain = true;
      return directory;
    }).pipe(Effect.scoped),
  );
  try {
    assert.equal(owned.removed, false);
    await access(owned.path);
  } finally {
    await rm(owned.path, { recursive: true });
  }
});

test("directory release failure preserves primary failure and recovery attribution", async () => {
  let owned: DesktopDirectory | undefined;
  try {
    await assert.rejects(
      Effect.runPromise(
        Effect.gen(function* () {
          const directory = yield* acquireDesktopDirectory;
          owned = directory;
          yield* Effect.promise(async () => {
            await mkdir(`${directory.path}/locked`);
            await writeFile(`${directory.path}/locked/evidence`, "fixture");
            await chmod(`${directory.path}/locked`, 0o000);
          });
          return yield* Effect.fail(new Error("primary playback failure"));
        }).pipe(Effect.scoped),
      ),
      /primary playback failure/,
    );
    assert.ok(owned);
    assert.equal(owned.removed, false);
    assert.equal(owned.retain, true);
    assert.match(owned.cleanupError ?? "", /EACCES/);
    await access(owned.path);
  } finally {
    if (owned) {
      await chmod(`${owned.path}/locked`, 0o700);
      await rm(owned.path, { recursive: true, force: true });
    }
  }
});
