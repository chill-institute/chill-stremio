import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startFixtureServer, type Fixture } from "../harness/fixture.ts";

async function withFixture(run: (fixture: Fixture) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "chill-interruption-"));
  try {
    await writeFile(join(directory, "movie.mp4"), Buffer.alloc(12000, 42));
    const fixture = await startFixtureServer({ mediaDir: directory });
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= fixture.close());
    try {
      await run({ ...fixture, close });
    } finally {
      await close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function interrupted(fixture: Fixture, signal?: AbortSignal) {
  const response = await fetch(`${fixture.origin}/failure/interrupted.mp4`, {
    signal: signal ?? AbortSignal.timeout(40000),
  });
  assert.equal(response.status, 200);
  return { rejected: assert.rejects(response.arrayBuffer()) };
}

async function released(fixture: Fixture) {
  const deadline = performance.now() + 1000;
  while (fixture.metrics.interruptedActive && performance.now() < deadline)
    await delay(10);
  assert.equal(fixture.metrics.interruptedActive, 0);
}

test(
  "delayed arming cuts every real response after the standalone deadline",
  { timeout: 8000 },
  async () => {
    await withFixture(async (fixture) => {
      const control = fixture.prepareInterruption();
      const first = await interrupted(fixture);
      const second = await interrupted(fixture);
      await delay(4100);
      assert.equal(fixture.metrics.interruptedActive, 2);
      assert.equal(fixture.metrics.interruptedCuts, 0);
      assert.ok(fixture.metrics.interruptedBytes > 0);
      control.arm();
      await Promise.all([first.rejected, second.rejected]);
      assert.equal(fixture.metrics.interruptedCuts, 2);
      await released(fixture);
      await assert.rejects(
        fetch(`${fixture.origin}/failure/interrupted.mp4`, {
          signal: AbortSignal.timeout(1000),
        }),
      );
      assert.equal(fixture.metrics.interruptedCuts, 3);
      control.cancel();
      const recovered = await fetch(`${fixture.origin}/media/movie.mp4`);
      assert.equal((await recovered.arrayBuffer()).byteLength, 12000);
    });
  },
);

test("disconnect and cancellation release pending responses without claiming a cut", async () => {
  await withFixture(async (fixture) => {
    const control = fixture.prepareInterruption();
    const abort = new AbortController();
    const abandoned = await interrupted(fixture, abort.signal);
    abort.abort();
    await abandoned.rejected;
    await released(fixture);
    assert.throws(() => control.arm(), /No active media response/);
    const pending = await interrupted(fixture);
    control.cancel();
    await pending.rejected;
    await released(fixture);
    assert.equal(fixture.metrics.interruptedCuts, 0);
    assert.throws(() => control.arm(), /cancelled/);
    fixture.prepareInterruption().cancel();
  });
});

test("reset and server shutdown cancel pending interruption work", async () => {
  await withFixture(async (fixture) => {
    const control = fixture.prepareInterruption();
    const pending = await interrupted(fixture);
    fixture.reset();
    await pending.rejected;
    await released(fixture);
    assert.throws(() => control.arm(), /cancelled/);
    fixture.prepareInterruption();
    const closing = await interrupted(fixture);
    await fixture.close();
    await closing.rejected;
    await released(fixture);
    assert.equal(fixture.metrics.interruptedCuts, 0);
    await assert.rejects(
      fetch(`${fixture.origin}/manifest.json`, {
        signal: AbortSignal.timeout(1000),
      }),
    );
  });
});

test(
  "an unarmed decode session expires and releases real connections",
  { timeout: 40000 },
  async () => {
    await withFixture(async (fixture) => {
      const control = fixture.prepareInterruption();
      const pending = await interrupted(fixture);
      await pending.rejected;
      assert.equal(fixture.metrics.interruptedTimeouts, 1);
      assert.equal(fixture.metrics.interruptedCuts, 1);
      await released(fixture);
      assert.throws(() => control.arm(), /expired/);
      control.cancel();
    });
  },
);
