import type {
  GetMoviesResponse,
  GetTVShowsResponse,
  GetTVShowDetailResponse,
  GetTVShowSeasonResponse,
  SearchResponse,
} from "@chill-institute/contracts/chill/v4/api_pb";
import { Context, Effect, Layer } from "effect";
import { movieMetadata } from "./cinemeta.ts";
import { createEngineRpc, type EngineError } from "./engine.ts";

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

export function discoveryEngineLayer(configuration: {
  baseUrl: string;
  token: string;
}) {
  return Layer.effect(
    DiscoveryEngine,
    Effect.gen(function* () {
      const rpc = yield* createEngineRpc(configuration);
      return DiscoveryEngine.of({
        getMovieMetadata: (imdbId) => movieMetadata(imdbId),
        getMovies: () =>
          rpc.call((options) => rpc.client.getMovies({}, options)),
        getTVShows: () =>
          rpc.call((options) => rpc.client.getTVShows({}, options)),
        getTVShowDetail: (imdbId) =>
          rpc.call((options) =>
            rpc.client.getTVShowDetail({ imdbId }, options),
          ),
        getTVShowSeason: (imdbId, seasonNumber) =>
          rpc.call((options) =>
            rpc.client.getTVShowSeason({ imdbId, seasonNumber }, options),
          ),
        search: (query) =>
          rpc.call((options) => rpc.client.search({ query }, options)),
      });
    }),
  );
}
