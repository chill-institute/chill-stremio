import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { waitForPlayback, type PlaybackResult } from "../src/playback-wait.ts";

const pending: PlaybackResult = { status: "pending" };
const ready: PlaybackResult = { url: "https://media.fixture.test/video.mp4" };
const timing = { windowMs: 1000, pollMs: 1, continuations: 0 };

test("a pending selection resolves to real playback without another selection", async () => {
  let polls = 0;
  const result = await waitForPlayback(
    pending,
    async () => (++polls === 2 ? ready : pending),
    new AbortController().signal,
    timing,
  );
  assert.deepEqual(result, ready);
  assert.equal(polls, 2);
});

test("ready and terminal outcomes do not poll", async () => {
  for (const result of [
    ready,
    { ...pending, status: "unknown" as const },
    { ...pending, status: "failed" as const },
  ]) {
    assert.equal(
      await waitForPlayback(
        result,
        async () => {
          throw new Error("unexpected poll");
        },
        new AbortController().signal,
        timing,
      ),
      result,
    );
  }
});

test("pending waits have a finite window", async () => {
  assert.equal(
    await waitForPlayback(
      pending,
      async () => pending,
      new AbortController().signal,
      { ...timing, windowMs: 5 },
    ),
    pending,
  );
});

test("disconnect cancels a pending wait before further provider reads", async () => {
  const controller = new AbortController();
  let polls = 0;
  const wait = waitForPlayback(
    pending,
    async () => {
      polls++;
      return pending;
    },
    controller.signal,
    { ...timing, pollMs: 1000 },
  );
  controller.abort();
  await assert.rejects(wait, { name: "AbortError" });
  assert.equal(polls, 0);
});

test("poll failures retain their cause", async () => {
  const failure = new Error("fixture upstream error");
  await assert.rejects(
    waitForPlayback(
      pending,
      async () => {
        throw failure;
      },
      new AbortController().signal,
      timing,
    ),
    (error) => error === failure,
  );
});
