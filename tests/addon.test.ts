import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { Effect, Layer } from "effect";
import sdk from "stremio-addon-sdk";
import { attachStreamHandler, Sources, SourceError } from "../src/addon.ts";

// SDK 1.6.10 takes positional arguments; DefinitelyTyped 1.6.12 incorrectly declares one object.
const manifest = {
  id: "institute.chill.test",
  version: "0.1.0",
  name: "Test",
  description: "Bridge test",
  types: ["movie" as const],
  resources: ["stream" as const],
  catalogs: [],
};

test("SDK Promise bridge resolves injected Effect service and releases its resources", async () => {
  let released = false;
  const builder = new sdk.addonBuilder(manifest);
  const layer = Layer.effect(
    Sources,
    Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.void, () =>
        Effect.sync(() => {
          released = true;
        }),
      );
      return Sources.of({
        streams: Effect.fn("Test.streams")(function* ({ id }) {
          return [{ name: id, url: "http://127.0.0.1/media/movie.mp4" }];
        }),
      });
    }),
  );
  const bridge = attachStreamHandler(builder, layer);
  try {
    const response = await Reflect.apply(
      builder.getInterface().get,
      undefined,
      ["stream", "movie", "fixture:movie", {}],
    );
    assert.deepEqual(response, {
      streams: [
        { name: "fixture:movie", url: "http://127.0.0.1/media/movie.mp4" },
      ],
      cacheMaxAge: 0,
    });
    assert.equal(released, false);
  } finally {
    await bridge.close();
  }
  assert.equal(released, true);
});

test("SDK Promise bridge rejects source failures without inventing playable streams", async () => {
  const builder = new sdk.addonBuilder(manifest);
  const bridge = attachStreamHandler(
    builder,
    Layer.succeed(
      Sources,
      Sources.of({
        streams: () =>
          Effect.fail(
            new SourceError({ cause: new Error("source unavailable") }),
          ),
      }),
    ),
  );
  try {
    await assert.rejects(
      Reflect.apply(builder.getInterface().get, undefined, [
        "stream",
        "movie",
        "fixture:movie",
        {},
      ]),
      /SourceError/,
    );
  } finally {
    await bridge.close();
  }
});
