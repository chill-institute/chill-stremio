import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { startFixture } from "../harness/fixture.ts";
import { verifyProtocol } from "../harness/protocol.ts";

test(
  "official SDK protocol, local media transport, pending and failure recovery",
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chill-protocol-"));
    let origin = "";
    try {
      // Transport checks use disposable bytes. Decoding is exclusively proven by the browser harness.
      await writeFile(join(directory, "movie.mp4"), Buffer.alloc(12000, 42));
      for (const language of ["english", "spanish"])
        await writeFile(join(directory, `${language}.vtt`), "WEBVTT\n");
      const results = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fixture = yield* startFixture({ mediaDir: directory });
            origin = fixture.origin;
            return yield* Effect.promise(() => verifyProtocol(fixture));
          }),
        ),
      );
      assert.equal(results.length, 4);
      await assert.rejects(
        fetch(`${origin}/manifest.json`, { signal: AbortSignal.timeout(1000) }),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Effect interruption releases the fixture listener",
  { timeout: 5000 },
  async () => {
    let origin = "";
    const controller = new AbortController();
    const running = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* startFixture();
          origin = fixture.origin;
          controller.abort();
          yield* Effect.never;
        }),
      ),
      { signal: controller.signal },
    );
    await assert.rejects(running);
    assert.ok(origin);
    await assert.rejects(
      fetch(`${origin}/manifest.json`, { signal: AbortSignal.timeout(1000) }),
    );
  },
);
