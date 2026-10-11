import type {
  GetMoviesResponse,
  GetTVShowsResponse,
  GetTVShowDetailResponse,
  GetTVShowSeasonResponse,
  SearchResponse,
} from "@chill-institute/contracts/chill/v4/api_pb";
import { Clock, Context, Effect, Layer } from "effect";
import { movieMetadata } from "./cinemeta.ts";
import {
  createEngineRpc,
  EngineError,
  engineTimeoutMs,
  type EngineAuth,
} from "./engine.ts";

export class DiscoveryEngine extends Context.Service<
  DiscoveryEngine,
  {
    getMovieMetadata(
      imdbId: string,
    ): Effect.Effect<{ title: string; year: number } | null, EngineError>;
    getMovies(): Effect.Effect<GetMoviesResponse, EngineError>;
    getTVShows(): Effect.Effect<GetTVShowsResponse, EngineError>;
    getTVShowDetail(
      imdbId: string,
    ): Effect.Effect<GetTVShowDetailResponse, EngineError>;
    getTVShowSeason(
      imdbId: string,
      seasonNumber: number,
    ): Effect.Effect<GetTVShowSeasonResponse, EngineError>;
    search(query: string): Effect.Effect<SearchResponse, EngineError>;
  }
>()("chill-stremio/DiscoveryEngine") {}

/** Epoch milliseconds after which the caller no longer waits for discovery. */
export const DiscoveryDeadline = Context.Reference<number>(
  "chill-stremio/DiscoveryDeadline",
  { defaultValue: () => Number.POSITIVE_INFINITY },
);

// Kept back from the caller's deadline to receive Engine's answer.
const responseReserveMs = 500;

export function discoveryEngineLayer(configuration: EngineAuth) {
  return Layer.effect(
    DiscoveryEngine,
    Effect.gen(function* () {
      const rpc = yield* createEngineRpc(configuration);
      // Engine bounds its own work by the timeout each request carries.
      const call = Effect.fn("DiscoveryEngine.call")(function* <A>(
        run: (options: {
          signal: AbortSignal;
          headers: Record<string, string>;
          timeoutMs: number;
        }) => Promise<A>,
      ) {
        const remaining =
          (yield* DiscoveryDeadline) -
          (yield* Clock.currentTimeMillis) -
          responseReserveMs;
        const timeoutMs = Math.floor(Math.min(engineTimeoutMs, remaining));
        // Connect sends no deadline at all for a timeout below one.
        if (timeoutMs < 1)
          return yield* new EngineError({ code: "deadline_exceeded" });
        return yield* rpc.call((options) => run({ ...options, timeoutMs }));
      });
      // Hosted routes build this layer per request, so the catalog is reused
      // only within one request.
      const movies = yield* Effect.cached(
        call((options) => rpc.client.getMovies({}, options)),
      );
      return DiscoveryEngine.of({
        getMovieMetadata: (imdbId) => movieMetadata(imdbId),
        getMovies: () => movies,
        getTVShows: () => call((options) => rpc.client.getTVShows({}, options)),
        getTVShowDetail: (imdbId) =>
          call((options) => rpc.client.getTVShowDetail({ imdbId }, options)),
        getTVShowSeason: (imdbId, seasonNumber) =>
          call((options) =>
            rpc.client.getTVShowSeason({ imdbId, seasonNumber }, options),
          ),
        search: (query) =>
          call((options) => rpc.client.search({ query }, options)),
      });
    }),
  );
}
