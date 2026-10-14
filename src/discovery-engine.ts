import type {
  FindOwnedVideosResponse,
  GetMoviesResponse,
  GetTVShowsResponse,
  GetTVShowDetailResponse,
  GetTVShowSeasonResponse,
  GetTVShowSeasonDownloadsResponse,
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
    getTVShowSeasonDownloads(
      imdbId: string,
      seasonNumber: number,
    ): Effect.Effect<GetTVShowSeasonDownloadsResponse, EngineError>;
    search(query: string): Effect.Effect<SearchResponse, EngineError>;
    findOwnedVideos(request: {
      title: string;
      year: number;
      season?: number;
      episode?: number;
    }): Effect.Effect<FindOwnedVideosResponse, EngineError>;
  }
>()("chill-stremio/DiscoveryEngine") {}

/** Epoch milliseconds after which the caller no longer waits for Engine. */
export const DiscoveryDeadline = Context.Reference<number>(
  "chill-stremio/DiscoveryDeadline",
  { defaultValue: () => Number.POSITIVE_INFINITY },
);

// Kept back from the caller's deadline to receive Engine's answer.
const responseReserveMs = 500;

/** The time an Engine RPC may take: at most `limitMs`, and within the caller's deadline. */
export const engineTimeout = Effect.fn("Engine.timeout")(function* (
  limitMs: number,
) {
  const remaining =
    (yield* DiscoveryDeadline) -
    (yield* Clock.currentTimeMillis) -
    responseReserveMs;
  const timeoutMs = Math.floor(Math.min(limitMs, remaining));
  // Connect sends no deadline at all for a timeout below one.
  if (timeoutMs < 1)
    return yield* new EngineError({ code: "deadline_exceeded" });
  return timeoutMs;
});

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
        const timeoutMs = yield* engineTimeout(engineTimeoutMs);
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
        getTVShowSeasonDownloads: (imdbId, seasonNumber) =>
          call((options) =>
            rpc.client.getTVShowSeasonDownloads(
              { imdbId, seasonNumber },
              options,
            ),
          ),
        search: (query) =>
          call((options) => rpc.client.search({ query }, options)),
        findOwnedVideos: (request) =>
          call((options) => rpc.client.findOwnedVideos(request, options)),
      });
    }),
  );
}
