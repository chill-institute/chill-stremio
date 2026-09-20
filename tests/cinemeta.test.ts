import assert from "node:assert/strict";
import { Effect } from "effect";
import { test } from "vite-plus/test";
import { movieMetadata } from "../src/cinemeta.ts";

const meta = {
  id: "tt0133093",
  type: "movie",
  name: "The Matrix",
  releaseInfo: "1999",
};

test("Cinemeta lookup sends only a fixed public IMDb path and validates movie context", async () => {
  const result = await Effect.runPromise(
    movieMetadata(meta.id, async (url, init) => {
      assert.equal(
        url,
        "https://v3-cinemeta.strem.io/meta/movie/tt0133093.json",
      );
      assert.equal(init?.headers, undefined);
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      return Response.json({ meta });
    }),
  );
  assert.deepEqual(result, { title: "The Matrix", year: 1999 });
});

test("Cinemeta missing titles return no movie, while outages and bad metadata remain errors", async () => {
  assert.equal(
    await Effect.runPromise(
      movieMetadata(meta.id, async () => new Response(null, { status: 404 })),
    ),
    null,
  );
  for (const body of [
    { meta: { ...meta, id: "tt1234567" } },
    { meta: { ...meta, type: "series" } },
    { meta: { ...meta, name: "" } },
    { meta: { ...meta, releaseInfo: "unknown" } },
  ]) {
    const error = await Effect.runPromise(
      movieMetadata(meta.id, async () => Response.json(body)).pipe(Effect.flip),
    );
    assert.equal(error.code, "invalid_response");
  }
  const outage = await Effect.runPromise(
    movieMetadata(
      meta.id,
      async () => new Response(null, { status: 503 }),
    ).pipe(Effect.flip),
  );
  assert.equal(outage.code, "unavailable");
  const oversized = await Effect.runPromise(
    movieMetadata(
      meta.id,
      async () => new Response("x".repeat(256 * 1024 + 1)),
    ).pipe(Effect.flip),
  );
  assert.equal(oversized.code, "invalid_response");
});

test("canceling the addon request aborts its metadata fetch", async () => {
  const controller = new AbortController();
  let observed: AbortSignal | null | undefined;
  let started: (() => void) | undefined;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const request = Effect.runPromise(
    movieMetadata(meta.id, async (_url, init) => {
      observed = init?.signal;
      started?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        );
      });
    }),
    { signal: controller.signal },
  );
  await ready;
  controller.abort();
  await assert.rejects(request);
  assert.equal(observed?.aborted, true);
});
