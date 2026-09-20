import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import type { addonBuilder, Stream } from "stremio-addon-sdk";

export const StreamRequest = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
});
export class SourceError extends Schema.TaggedError<SourceError>()(
  "SourceError",
  {
    cause: Schema.Defect(),
  },
) {}
export class Sources extends Context.Service<
  Sources,
  {
    streams(
      request: typeof StreamRequest.Type,
    ): Effect.Effect<Stream[], SourceError>;
  }
>()("chill-stremio/Sources") {}

export function attachStreamHandler(
  builder: addonBuilder,
  layer: Layer.Layer<Sources>,
) {
  const runtime = ManagedRuntime.make(layer);
  builder.defineStreamHandler(async (input) => {
    const streams = await runtime.runPromise(
      Effect.gen(function* () {
        const request = yield* Schema.decodeUnknownEffect(StreamRequest)(input);
        const sources = yield* Sources;
        return yield* sources.streams(request);
      }),
    );
    return { streams, cacheMaxAge: 0 };
  });
  return { close: () => runtime.dispose() };
}
