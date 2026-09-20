import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import { Effect, Exit, Fiber } from "effect";
import {
  createLiveAttempt,
  trackAcquisition,
  withLiveLifecycle,
  writeRecoveryJournal,
  type LiveOutcome,
} from "../harness/live/lifecycle.ts";

for (const primaryFails of [false, true]) {
  for (const cleanupFails of [false, true]) {
    test(`live lifecycle primary ${primaryFails ? "failure" : "success"}, cleanup ${cleanupFails ? "failure" : "success"}`, async () => {
      const attempt = createLiveAttempt();
      const calls: { operation: string; ids: readonly number[] }[] = [];
      const published: LiveOutcome[] = [];
      const work = Effect.gen(function* () {
        yield* trackAcquisition(
          attempt,
          "file",
          Effect.succeed({ id: 11 }),
          Effect.void,
        );
        yield* trackAcquisition(
          attempt,
          "transfer",
          Effect.succeed({ id: 22 }),
          Effect.void,
        );
        attempt.evidence.playback = { decoded: true };
        if (primaryFails)
          return yield* Effect.fail(new Error("playback failed"));
      });
      const exit = await Effect.runPromiseExit(
        withLiveLifecycle(attempt, work, {
          cancelTransfers: (ids) =>
            Effect.sync(() => {
              calls.push({ operation: "cancel", ids });
            }),
          deleteFiles: (ids) =>
            Effect.gen(function* () {
              calls.push({ operation: "delete", ids });
              if (cleanupFails)
                return yield* Effect.fail(new Error("deletion rejected"));
            }),
          checkpoint: Effect.void,
          publish: (outcome) =>
            Effect.sync(() => {
              published.push(outcome);
            }),
        }),
      );
      assert.equal(Exit.isFailure(exit), primaryFails);
      assert.equal(published.length, 1);
      assert.equal(
        published[0]?.status,
        primaryFails || cleanupFails ? "failed" : "passed",
      );
      assert.equal(
        published[0]?.primary.status,
        primaryFails ? "failed" : "passed",
      );
      assert.equal(
        published[0]?.cleanup.status,
        cleanupFails ? "uncertain" : "acknowledged",
      );
      assert.deepEqual(calls, [
        { operation: "cancel", ids: [22] },
        { operation: "delete", ids: [11] },
      ]);
      assert.deepEqual(attempt.evidence.playback, { decoded: true });
      if (primaryFails)
        assert.match(published[0]?.primary.error ?? "", /playback failed/);
      if (cleanupFails)
        assert.match(
          published[0]?.cleanup.files.error ?? "",
          /deletion rejected/,
        );
    });
  }
}

for (const end of ["timeout", "cancel"] as const) {
  test(`live ${end} publishes partial acquisition and cleanup`, async () => {
    const attempt = createLiveAttempt();
    const deleted: number[] = [];
    const published: LiveOutcome[] = [];
    let acquired: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const work = Effect.gen(function* () {
      yield* trackAcquisition(
        attempt,
        "file",
        Effect.succeed({ id: 11 }),
        Effect.void,
      );
      yield* trackAcquisition(
        attempt,
        "transfer",
        Effect.gen(function* () {
          acquired();
          return yield* Effect.never;
        }),
        Effect.void,
      );
    });
    const fiber = Effect.runFork(
      withLiveLifecycle(
        attempt,
        end === "timeout" ? work.pipe(Effect.timeout("30 millis")) : work,
        {
          cancelTransfers: () =>
            Effect.die("must not cancel unattributed transfers"),
          deleteFiles: (ids) =>
            Effect.sync(() => {
              deleted.push(...ids);
            }),
          checkpoint: Effect.void,
          publish: (outcome) =>
            Effect.sync(() => {
              published.push(outcome);
            }),
        },
      ),
    );
    await ready;
    if (end === "cancel") await Effect.runPromise(Fiber.interrupt(fiber));
    else await Effect.runPromiseExit(Fiber.join(fiber));
    assert.equal(published.length, 1);
    assert.equal(
      published[0]?.primary.status,
      end === "timeout" ? "timed-out" : "cancelled",
    );
    assert.equal(published[0]?.cleanup.pendingAcquisitions, 1);
    assert.equal(published[0]?.cleanup.status, "uncertain");
    assert.deepEqual(deleted, [11]);
  });
}

test("live recovery journal protects attribution and is written before mutations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-recovery-"));
  try {
    const attempt = createLiveAttempt();
    const path = join(directory, "private", "attempt.json");
    const checkpoint = writeRecoveryJournal(attempt, path);
    let pendingBeforeMutation = false;
    let shared = "";
    const work = trackAcquisition(
      attempt,
      "file",
      Effect.tryPromise(async () => {
        const journal = await readFile(path, "utf8");
        pendingBeforeMutation = journal.includes('"sequence": 0');
        return { id: 123456 };
      }),
      checkpoint,
    );
    await Effect.runPromise(
      withLiveLifecycle(attempt, work, {
        cancelTransfers: () => Effect.void,
        deleteFiles: () => Effect.void,
        checkpoint,
        publish: (outcome) =>
          Effect.sync(() => {
            shared = JSON.stringify(outcome);
          }),
      }),
    );
    assert.equal(pendingBeforeMutation, true);
    assert.match(await readFile(path, "utf8"), /123456/);
    assert.equal(shared.includes("123456"), false);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, "private"))).mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live journal failure blocks acquisition and still publishes a terminal outcome", async () => {
  const attempt = createLiveAttempt();
  let mutations = 0;
  const published: LiveOutcome[] = [];
  const checkpoint = Effect.fail(new Error("journal unavailable"));
  const work = trackAcquisition(
    attempt,
    "file",
    Effect.sync(() => {
      mutations++;
      return { id: 1 };
    }),
    checkpoint,
  );
  await Effect.runPromiseExit(
    withLiveLifecycle(attempt, work, {
      cancelTransfers: () => Effect.void,
      deleteFiles: () => Effect.void,
      checkpoint,
      publish: (outcome) =>
        Effect.sync(() => {
          published.push(outcome);
        }),
    }),
  );
  assert.equal(mutations, 0);
  assert.equal(published.length, 1);
  assert.equal(published[0]?.status, "failed");
  assert.match(
    published[0]?.cleanup.recoveryError ?? "",
    /journal unavailable/,
  );
});
