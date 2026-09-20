import { Buffer } from "node:buffer";
import { Effect, Schema } from "effect";
import { EngineError } from "./engine.ts";

const ImdbId = Schema.String.check(Schema.isPattern(/^tt[0-9]{7,10}$/));
const Metadata = Schema.Struct({
  meta: Schema.NullOr(
    Schema.Struct({
      id: ImdbId,
      type: Schema.Literal("movie"),
      name: Schema.NonEmptyString.check(Schema.isMaxLength(240)),
      releaseInfo: Schema.optional(
        Schema.String.check(Schema.isPattern(/^[0-9]{4}$/)),
      ),
    }),
  ),
});

export const movieMetadata = Effect.fn("Cinemeta.movieMetadata")(function* (
  imdbId: string,
  fetchMetadata: typeof fetch = globalThis.fetch,
) {
  yield* Schema.decodeUnknownEffect(ImdbId)(imdbId).pipe(
    Effect.mapError(() => new EngineError({ code: "invalid_response" })),
  );
  const body = yield* Effect.tryPromise({
    try: async (signal) => {
      const response = await fetchMetadata(
        `https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`,
        { signal, redirect: "error", credentials: "omit" },
      );
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) return { meta: null };
        throw new EngineError({ code: "unavailable" });
      }
      if (!response.body) throw new EngineError({ code: "invalid_response" });
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > 256 * 1024) {
            await reader.cancel();
            throw new EngineError({ code: "invalid_response" });
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new EngineError({ code: "invalid_response" });
      }
    },
    catch: (error) =>
      error instanceof EngineError
        ? error
        : new EngineError({ code: "unavailable" }),
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new EngineError({ code: "deadline_exceeded" })),
    }),
  );
  const result = yield* Schema.decodeUnknownEffect(Metadata)(body).pipe(
    Effect.mapError(() => new EngineError({ code: "invalid_response" })),
  );
  if (result.meta && result.meta.id !== imdbId)
    return yield* new EngineError({ code: "invalid_response" });
  return result.meta
    ? {
        title: result.meta.name,
        year: result.meta.releaseInfo ? Number(result.meta.releaseInfo) : 0,
      }
    : null;
});
