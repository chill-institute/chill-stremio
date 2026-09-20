import { Buffer } from "node:buffer";
import { Effect, Schema } from "effect";
import type { Manifest, MetaDetail } from "stremio-addon-sdk";
import { DiscoveryEngine } from "./discovery-engine.ts";
import { EngineError } from "./engine.ts";

export class DiscoveryError extends Schema.TaggedError<DiscoveryError>()(
  "DiscoveryError",
  {
    code: Schema.Literals([
      "invalid_request",
      "invalid_response",
      "catalog_too_large",
    ]),
  },
) {}

const invalidRequest = () => new DiscoveryError({ code: "invalid_request" });
const invalidResponse = () => new DiscoveryError({ code: "invalid_response" });
const artworkUnavailable = (error: unknown) =>
  error instanceof EngineError &&
  ["unavailable", "deadline_exceeded", "not_found"].includes(error.code);
const Text = Schema.String.check(Schema.isMaxLength(4096));
const Title = Schema.NonEmptyString.check(Schema.isMaxLength(1024));
const OpaqueId = Schema.NonEmptyString.check(Schema.isMaxLength(512));
const ImdbId = Schema.String.check(Schema.isPattern(/^tt[0-9]{7,10}$/));
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 9999 }));
const NumberId = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 9999 }),
);
const Query = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);
const Https = Schema.String.check(
  Schema.isMaxLength(16384),
  Schema.makeFilter((value) => {
    if (
      !URL.canParse(value) ||
      Array.from(value).some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      return false;
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  }),
);
const TransferUrl = Schema.Union([
  Https,
  Schema.String.check(
    Schema.isMaxLength(16384),
    Schema.makeFilter((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return (
        url.protocol === "magnet:" &&
        !url.hostname &&
        !url.username &&
        !url.password &&
        !url.hash &&
        url.searchParams
          .getAll("xt")
          .some(
            (topic) =>
              /^urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})$/.test(topic) ||
              /^urn:btmh:1220[a-fA-F0-9]{64}$/.test(topic),
          )
      );
    }),
  ),
]);
const Artwork = Schema.Union([Schema.Literal(""), Https]);
const Rating = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 10 }),
);
const Metadata = {
  title: Title,
  year: Count,
  posterUrl: Artwork,
  overview: Text,
  rating: Rating,
};
const Movie = Schema.Struct({
  ...Metadata,
  id: OpaqueId,
  externalUrl: Schema.optional(Schema.String.check(Schema.isMaxLength(16384))),
  backdropUrl: Artwork,
  genres: Schema.Array(Title).check(Schema.isMaxLength(50)),
});
const Show = Schema.Struct({ ...Metadata, imdbId: ImdbId });
const ShowDetail = Schema.Struct({
  ...Metadata,
  imdbId: ImdbId,
  backdropUrl: Artwork,
  genres: Schema.Array(Title).check(Schema.isMaxLength(50)),
});
const Release = Schema.Struct({
  id: OpaqueId,
  title: Title,
  link: TransferUrl,
  indexer: Title,
  size: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  seeders: Schema.BigInt.check(Schema.isGreaterThanOrEqualToBigInt(0n)),
  imdbId: Schema.optional(Text),
  releaseInfo: Schema.optional(
    Schema.Struct({
      season: Schema.optional(Schema.Int),
      episode: Schema.optional(Schema.Int),
      episodeEnd: Schema.optional(Schema.Int),
    }),
  ),
});
const Target = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("imdb"), imdbId: ImdbId }),
  Schema.Struct({ kind: Schema.Literal("movie"), id: OpaqueId }),
  Schema.Struct({
    kind: Schema.Literal("episode"),
    imdbId: ImdbId,
    season: NumberId,
    episode: NumberId,
  }),
  Schema.Struct({
    kind: Schema.Literal("release"),
    query: Query,
    id: OpaqueId,
  }),
]);
export type DiscoveryTarget = typeof Target.Type;
export type DiscoveryRelease = {
  id: string;
  title: string;
  url: string;
  indexer: string;
  size: bigint;
  seeders: bigint;
};

export const discoveryIdPrefixes = [
  "chill:movie:",
  "chill:series:",
  "chill:episode:",
  "chill:release:",
];
// Keep release search before optional empty catalogs: the pinned Web client can skip later search rows.
export const discoveryCatalogs: Manifest["catalogs"] = [
  {
    type: "movie",
    id: "discover-releases",
    name: "chill.institute Releases",
    extra: [{ name: "search", isRequired: true }, { name: "skip" }],
  },
  {
    type: "movie",
    id: "discover-movies",
    name: "chill.institute Movies",
    extra: [{ name: "search" }, { name: "skip" }],
  },
  {
    type: "series",
    id: "discover-series",
    name: "chill.institute Series",
    extra: [{ name: "search" }, { name: "skip" }],
  },
];

const encode = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url");
const decode = (value: string) => {
  const decoded = Buffer.from(value, "base64url").toString("utf8");
  return encode(decoded) === value ? decoded : "";
};
export function discoveryTargetId(target: DiscoveryTarget): string {
  switch (target.kind) {
    case "imdb":
      return target.imdbId;
    case "movie":
      return `chill:movie:${encode(target.id)}`;
    case "episode":
      return `chill:episode:${target.imdbId}:${target.season}:${target.episode}`;
    case "release":
      return `chill:release:${encode(target.query)}:${encode(target.id)}`;
  }
}

export const readDiscoveryTarget = Effect.fn("Discovery.readTarget")(
  function* (input: { type: string; id: string }) {
    const request = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        type: Schema.Literals(["movie", "series"]),
        id: Schema.String.check(Schema.isMaxLength(1600)),
      }),
    )(input).pipe(Effect.mapError(invalidRequest));
    const parts = request.id.split(":");
    let candidate: unknown;
    if (request.type === "movie" && Schema.is(ImdbId)(request.id)) {
      candidate = { kind: "imdb", imdbId: request.id };
    } else if (
      request.type === "series" &&
      parts.length === 3 &&
      Schema.is(ImdbId)(parts[0]) &&
      /^[1-9][0-9]{0,3}$/.test(parts[1] ?? "") &&
      /^[1-9][0-9]{0,3}$/.test(parts[2] ?? "")
    ) {
      candidate = {
        kind: "episode",
        imdbId: parts[0],
        season: Number(parts[1]),
        episode: Number(parts[2]),
      };
    } else if (
      parts[0] === "chill" &&
      parts[1] === "movie" &&
      parts.length === 3 &&
      request.type === "movie"
    ) {
      candidate = { kind: "movie", id: decode(parts[2] ?? "") };
    } else if (
      parts[0] === "chill" &&
      parts[1] === "episode" &&
      parts.length === 5 &&
      request.type === "series" &&
      /^[1-9][0-9]{0,3}$/.test(parts[3] ?? "") &&
      /^[1-9][0-9]{0,3}$/.test(parts[4] ?? "")
    ) {
      candidate = {
        kind: "episode",
        imdbId: parts[2],
        season: Number(parts[3]),
        episode: Number(parts[4]),
      };
    } else if (
      parts[0] === "chill" &&
      parts[1] === "release" &&
      parts.length === 4 &&
      request.type === "movie"
    ) {
      candidate = {
        kind: "release",
        query: decode(parts[2] ?? ""),
        id: decode(parts[3] ?? ""),
      };
    }
    return yield* Schema.decodeUnknownEffect(Target)(candidate).pipe(
      Effect.mapError(invalidRequest),
    );
  },
);

function metadata(
  value: typeof Show.Type | typeof Movie.Type,
  id: string,
  type: "movie" | "series",
): MetaDetail {
  return {
    id,
    type,
    name: value.title,
    poster: value.posterUrl || undefined,
    description: value.overview,
    releaseInfo: value.year ? String(value.year) : undefined,
    imdbRating: value.rating ? String(value.rating) : undefined,
  };
}
const CatalogRequest = Schema.Struct({
  type: Schema.Literals(["movie", "series"]),
  id: Schema.Literals([
    "discover-movies",
    "discover-series",
    "discover-releases",
  ]),
  extra: Schema.optional(
    Schema.Struct({
      search: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
      skip: Schema.optional(
        Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,3})$/)),
      ),
    }),
  ),
});
const decodeResponse =
  <A, I>(schema: Schema.Codec<A, I>) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(invalidResponse),
    );
const uniqueIds = (items: readonly { id: string }[]) =>
  new Set(items.map((item) => item.id)).size === items.length;

function episodeVideo(
  imdbId: string,
  entry: {
    seasonNumber: number;
    episodeNumber: number;
    name: string;
    overview: string;
    stillUrl: string;
    airDate: string;
  },
) {
  return {
    id: discoveryTargetId({
      kind: "episode",
      imdbId,
      season: entry.seasonNumber,
      episode: entry.episodeNumber,
    }),
    title: entry.name,
    season: entry.seasonNumber,
    episode: entry.episodeNumber,
    overview: entry.overview,
    thumbnail: entry.stillUrl || undefined,
    released: /^\d{4}-\d{2}-\d{2}$/.test(entry.airDate)
      ? `${entry.airDate}T00:00:00.000Z`
      : "",
  };
}

export function releaseDescription(
  entry: Pick<DiscoveryRelease, "indexer" | "seeders" | "size">,
) {
  const unit =
    entry.size >= 1073741824n
      ? { bytes: 1073741824, name: "GiB" }
      : entry.size >= 1048576n
        ? { bytes: 1048576, name: "MiB" }
        : entry.size >= 1024n
          ? { bytes: 1024, name: "KiB" }
          : undefined;
  const size = unit
    ? `${(Number(entry.size) / unit.bytes).toFixed(2)} ${unit.name}`
    : `${entry.size} bytes`;
  return `${entry.indexer} · ${entry.seeders} seeders · ${size}`;
}

function movieImdbId(movie: typeof Movie.Type) {
  if (!movie.externalUrl || !URL.canParse(movie.externalUrl)) return undefined;
  const url = new URL(movie.externalUrl);
  if (
    url.protocol !== "https:" ||
    !["imdb.com", "www.imdb.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    return undefined;
  return /^\/title\/(tt[0-9]{7,10})\/?$/.exec(url.pathname)?.[1];
}

function moviesByImdb(catalog: readonly (typeof Movie.Type)[]) {
  const index = new Map<string, (typeof Movie.Type)[]>();
  for (const movie of catalog) {
    const id = movieImdbId(movie);
    if (!id) continue;
    const matches = index.get(id);
    if (matches) matches.push(movie);
    else index.set(id, [movie]);
  }
  return index;
}

export function createDiscovery() {
  const movies = Effect.fn("Discovery.movies")(function* () {
    const engine = yield* DiscoveryEngine;
    return (yield* decodeResponse(
      Schema.Struct({
        movies: Schema.Array(Movie).check(
          Schema.isMaxLength(5000),
          Schema.makeFilter(uniqueIds),
        ),
      }),
    )(yield* engine.getMovies())).movies;
  });
  const shows = Effect.fn("Discovery.shows")(function* () {
    const engine = yield* DiscoveryEngine;
    return (yield* decodeResponse(
      Schema.Struct({
        shows: Schema.Array(Show).check(
          Schema.isMaxLength(5000),
          Schema.makeFilter(
            (items) =>
              new Set(items.map((item) => item.imdbId)).size === items.length,
          ),
        ),
      }),
    )(yield* engine.getTVShows())).shows;
  });
  const search = Effect.fn("Discovery.search")(function* (query: string) {
    yield* Schema.decodeUnknownEffect(Query)(query).pipe(
      Effect.mapError(invalidRequest),
    );
    const engine = yield* DiscoveryEngine;
    const response = yield* decodeResponse(
      Schema.Struct({
        query: Query,
        indexerStats: Schema.Array(Schema.Struct({ error: Text })).check(
          Schema.isMaxLength(100),
        ),
        results: Schema.Array(Release).check(
          Schema.isMaxLength(5000),
          Schema.makeFilter(uniqueIds),
        ),
      }),
    )(yield* engine.search(query));
    if (response.query !== query) return yield* invalidResponse();
    if (
      response.results.length === 0 &&
      response.indexerStats.some((stat) => stat.error.trim() !== "")
    )
      return yield* new EngineError({ code: "unavailable" });
    return response.results;
  });
  const detail = Effect.fn("Discovery.detail")(function* (imdbId: string) {
    const engine = yield* DiscoveryEngine;
    const response = yield* decodeResponse(
      Schema.Struct({
        show: ShowDetail,
        seasons: Schema.Array(Schema.Struct({ seasonNumber: Count })).check(
          Schema.isMaxLength(40),
          Schema.makeFilter(
            (items) =>
              new Set(items.map((item) => item.seasonNumber)).size ===
              items.length,
          ),
        ),
      }),
    )(yield* engine.getTVShowDetail(imdbId));
    if (response.show.imdbId !== imdbId) return yield* invalidResponse();
    return response;
  });
  const season = Effect.fn("Discovery.season")(function* (
    imdbId: string,
    seasonNumber: number,
  ) {
    const engine = yield* DiscoveryEngine;
    const response = yield* decodeResponse(
      Schema.Struct({
        imdbId: ImdbId,
        seasonNumber: NumberId,
        episodes: Schema.Array(
          Schema.Struct({
            seasonNumber: NumberId,
            episodeNumber: NumberId,
            name: Title,
            overview: Text,
            airDate: Schema.String.check(Schema.isMaxLength(10)),
            stillUrl: Artwork,
          }),
        ).check(
          Schema.isMaxLength(1000),
          Schema.makeFilter(
            (items) =>
              new Set(items.map((item) => item.episodeNumber)).size ===
              items.length,
          ),
        ),
      }),
    )(yield* engine.getTVShowSeason(imdbId, seasonNumber));
    if (
      response.imdbId !== imdbId ||
      response.seasonNumber !== seasonNumber ||
      response.episodes.some((entry) => entry.seasonNumber !== seasonNumber)
    )
      return yield* invalidResponse();
    return response.episodes;
  });
  const releaseContext = Effect.fn("Discovery.releaseContext")(function* (
    entry: typeof Release.Type,
  ) {
    if (!entry.imdbId || !Schema.is(ImdbId)(entry.imdbId)) return undefined;
    const matchingMovies =
      moviesByImdb(yield* movies()).get(entry.imdbId) ?? [];
    if (matchingMovies.length > 1) return undefined;
    const movie = matchingMovies[0];
    if (movie && !entry.releaseInfo?.season && !entry.releaseInfo?.episode) {
      return {
        poster: movie.posterUrl || undefined,
        background: movie.backdropUrl || undefined,
        description: movie.overview,
      };
    }
    if (movie) return undefined;
    const show = (yield* shows()).find((show) => show.imdbId === entry.imdbId);
    if (!show) return undefined;
    const info = entry.releaseInfo;
    if (
      !info ||
      !Schema.is(NumberId)(info.season) ||
      !Schema.is(NumberId)(info.episode) ||
      (info.episodeEnd && info.episodeEnd !== info.episode)
    )
      return undefined;
    const response = yield* detail(show.imdbId);
    if (!response.seasons.some((season) => season.seasonNumber === info.season))
      return undefined;
    const episode = (yield* season(show.imdbId, info.season)).find(
      (episode) => episode.episodeNumber === info.episode,
    );
    return episode
      ? {
          poster: response.show.posterUrl || undefined,
          background:
            episode.stillUrl || response.show.backdropUrl || undefined,
          description: `${response.show.title} · S${String(info.season).padStart(2, "0")}E${String(info.episode).padStart(2, "0")} · ${episode.name}\n${episode.overview || response.show.overview}`,
        }
      : undefined;
  });
  const releases = Effect.fn("Discovery.releases")(function* (
    input: DiscoveryTarget,
  ): Effect.fn.Return<
    DiscoveryRelease[],
    DiscoveryError | import("./engine.ts").EngineError,
    DiscoveryEngine
  > {
    const target = yield* Schema.decodeUnknownEffect(Target)(input).pipe(
      Effect.mapError(invalidRequest),
    );
    let query: string;
    if (target.kind === "imdb") {
      const matching = moviesByImdb(yield* movies()).get(target.imdbId) ?? [];
      const engine = yield* DiscoveryEngine;
      const movie =
        matching.length === 1
          ? matching[0]
          : yield* engine.getMovieMetadata(target.imdbId);
      if (!movie) return [];
      query = `${movie.title}${movie.year ? ` ${movie.year}` : ""}`;
    } else if (target.kind === "movie") {
      const movie = (yield* movies()).find((movie) => movie.id === target.id);
      if (!movie) return [];
      query = `${movie.title}${movie.year ? ` ${movie.year}` : ""}`;
    } else if (target.kind === "episode") {
      const show = yield* detail(target.imdbId);
      if (!show.seasons.some((entry) => entry.seasonNumber === target.season))
        return [];
      if (
        !(yield* season(target.imdbId, target.season)).some(
          (entry) => entry.episodeNumber === target.episode,
        )
      )
        return [];
      query = `${show.show.title} S${String(target.season).padStart(2, "0")}E${String(target.episode).padStart(2, "0")}`;
    } else query = target.query;
    const candidates = yield* search(query);
    return candidates
      .filter((entry) => target.kind !== "release" || entry.id === target.id)
      .map((entry) => ({
        id: entry.id,
        title: entry.title,
        url: entry.link,
        indexer: entry.indexer,
        size: entry.size,
        seeders: entry.seeders,
      }));
  });
  const budget = Effect.timeoutOrElse({
    duration: "10 seconds",
    orElse: () => Effect.fail(new EngineError({ code: "deadline_exceeded" })),
  });
  const methods = {
    releases,
    catalog: Effect.fn("Discovery.catalog")(function* (input: {
      type: string;
      id: string;
      extra?: { search?: string; skip?: string };
    }) {
      const request = yield* Schema.decodeUnknownEffect(CatalogRequest)(
        input,
      ).pipe(Effect.mapError(invalidRequest));
      if ((request.id === "discover-series") !== (request.type === "series"))
        return yield* invalidRequest();
      const query = request.extra?.search?.trim() ?? "";
      const skip = Number(request.extra?.skip ?? "0");
      let metas: MetaDetail[];
      if (request.id === "discover-releases") {
        if (!query) return { metas: [] };
        const results = (yield* search(query)).slice(skip, skip + 100);
        const catalog = moviesByImdb(
          results.some((entry) => Schema.is(ImdbId)(entry.imdbId))
            ? yield* movies().pipe(
                Effect.catch((error) =>
                  artworkUnavailable(error)
                    ? Effect.succeed([])
                    : Effect.fail(error),
                ),
              )
            : [],
        );
        metas = results.map((entry) => {
          const matches = Schema.is(ImdbId)(entry.imdbId)
            ? (catalog.get(entry.imdbId) ?? [])
            : [];
          const movie =
            matches.length === 1 &&
            !entry.releaseInfo?.season &&
            !entry.releaseInfo?.episode
              ? matches[0]
              : undefined;
          return {
            id: discoveryTargetId({ kind: "release", query, id: entry.id }),
            type: "movie",
            name: entry.title,
            poster: movie?.posterUrl || undefined,
            background: movie?.backdropUrl || undefined,
            description: [movie?.overview, releaseDescription(entry)]
              .filter(Boolean)
              .join("\n\n"),
          };
        });
        return { metas };
      } else if (request.id === "discover-movies") {
        metas = (yield* movies()).map((movie) => ({
          ...metadata(
            movie,
            discoveryTargetId({ kind: "movie", id: movie.id }),
            "movie",
          ),
          background: movie.backdropUrl || undefined,
          genres: [...movie.genres],
        }));
      } else
        metas = (yield* shows()).map((show) =>
          metadata(show, `chill:series:${show.imdbId}`, "series"),
        );
      const filtered = !query
        ? metas
        : metas.filter((meta) =>
            meta.name.toLowerCase().includes(query.toLowerCase()),
          );
      return { metas: filtered.slice(skip, skip + 100) };
    }),
    meta: Effect.fn("Discovery.meta")(function* (input: {
      type: string;
      id: string;
    }) {
      if (
        input.type === "series" &&
        /^chill:series:tt[0-9]{7,10}$/.test(input.id)
      ) {
        const imdbId = input.id.slice("chill:series:".length);
        const response = yield* detail(imdbId);
        const episodes = (yield* Effect.forEach(
          response.seasons.filter((entry) => entry.seasonNumber > 0),
          (entry) => season(imdbId, entry.seasonNumber),
          { concurrency: 3 },
        )).flat();
        if (episodes.length > 1000)
          return yield* new DiscoveryError({ code: "catalog_too_large" });
        const meta: MetaDetail = {
          ...metadata(response.show, input.id, "series"),
          background: response.show.backdropUrl || undefined,
          genres: [...response.show.genres],
          videos: episodes.map((entry) => episodeVideo(imdbId, entry)),
        };
        return { meta };
      }
      const target = yield* readDiscoveryTarget(input);
      if (target.kind === "imdb") return { meta: null };
      if (target.kind === "movie") {
        const movie = (yield* movies()).find((entry) => entry.id === target.id);
        return {
          meta: movie
            ? {
                ...metadata(movie, input.id, "movie"),
                background: movie.backdropUrl || undefined,
                genres: [...movie.genres],
              }
            : null,
        };
      }
      if (target.kind === "release") {
        const candidate = (yield* search(target.query)).find(
          (entry) => entry.id === target.id,
        );
        const context = candidate
          ? yield* releaseContext(candidate).pipe(
              Effect.catch((error) =>
                artworkUnavailable(error)
                  ? Effect.succeed(undefined)
                  : Effect.fail(error),
              ),
            )
          : undefined;
        return {
          meta: candidate
            ? {
                id: input.id,
                type: "movie" as const,
                name: candidate.title,
                ...context,
                description: [
                  context?.description,
                  releaseDescription(candidate),
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              }
            : null,
        };
      }
      const response = yield* detail(target.imdbId);
      if (
        !response.seasons.some((entry) => entry.seasonNumber === target.season)
      )
        return { meta: null };
      const episode = (yield* season(target.imdbId, target.season)).find(
        (entry) => entry.episodeNumber === target.episode,
      );
      return {
        meta: episode
          ? {
              ...metadata(response.show, input.id, "series"),
              name: `${response.show.title} · S${String(target.season).padStart(2, "0")}E${String(target.episode).padStart(2, "0")} · ${episode.name}`,
              description: episode.overview || response.show.overview,
              background:
                episode.stillUrl || response.show.backdropUrl || undefined,
              genres: [...response.show.genres],
              videos: [episodeVideo(target.imdbId, episode)],
              behaviorHints: { defaultVideoId: input.id },
            }
          : null,
      };
    }),
  };
  return {
    resolveTarget: Effect.fn("Discovery.resolveTarget")(function* (input: {
      type: string;
      id: string;
    }) {
      const target = yield* readDiscoveryTarget(input);
      if (target.kind !== "imdb") return target;
      const matching = moviesByImdb(yield* movies()).get(target.imdbId) ?? [];
      const movie = matching.length === 1 ? matching[0] : undefined;
      return movie ? { kind: "movie" as const, id: movie.id } : target;
    }, budget),
    releases: (target: DiscoveryTarget) =>
      methods.releases(target).pipe(budget),
    catalog: (input: Parameters<typeof methods.catalog>[0]) =>
      methods.catalog(input).pipe(budget),
    meta: (input: Parameters<typeof methods.meta>[0]) =>
      methods.meta(input).pipe(budget),
  };
}
