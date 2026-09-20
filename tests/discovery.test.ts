import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import {
  GetMoviesResponseSchema,
  GetTVShowsResponseSchema,
  GetTVShowDetailResponseSchema,
  GetTVShowSeasonResponseSchema,
  SearchResponseSchema,
  MovieSchema,
  TVShowSeasonSchema,
} from "@chill-institute/contracts/chill/v4/api_pb";
import { Effect, Layer } from "effect";
import { test } from "vite-plus/test";
import { DiscoveryEngine } from "../src/discovery-engine.ts";
import {
  createDiscovery,
  discoveryTargetId,
  readDiscoveryTarget,
} from "../src/discovery.ts";
import { EngineError } from "../src/engine.ts";

const imdbId = "tt1234567";
const movie = {
  id: "catalog/opaque identity",
  title: "An Independent Film",
  year: 2024,
  posterUrl: "https://images.example/poster.jpg",
  backdropUrl: "https://images.example/background.jpg",
  overview: "A film synopsis",
  rating: 7.5,
  genres: ["Drama"],
};
const show = {
  imdbId,
  title: "An Independent Series",
  year: 2023,
  posterUrl: "https://images.example/show.jpg",
  overview: "A series synopsis",
  rating: 8,
};
const release = {
  id: "indexer/release-id",
  title: "Independent.Release.1080p",
  link: "https://api.example/download?download_token=fixture-only",
  indexer: "Example",
  size: 5000000000n,
  seeders: 8n,
};
const discovery = createDiscovery();
function fixture() {
  const calls: string[] = [];
  const movies = create(GetMoviesResponseSchema, { movies: [movie] });
  const shows = create(GetTVShowsResponseSchema, { shows: [show] });
  const detail = create(GetTVShowDetailResponseSchema, {
    show: {
      ...show,
      backdropUrl: "https://images.example/bg.jpg",
      genres: ["Comedy"],
    },
    seasons: [{ seasonNumber: 0 }, { seasonNumber: 1 }],
  });
  const season = create(GetTVShowSeasonResponseSchema, {
    imdbId,
    seasonNumber: 1,
    episodes: [
      {
        seasonNumber: 1,
        episodeNumber: 2,
        name: "The second episode",
        overview: "A scene",
        airDate: "2023-02-03",
        stillUrl: "https://images.example/still.jpg",
      },
    ],
  });
  const service = DiscoveryEngine.of({
    getMovieMetadata: (id) =>
      Effect.sync(() => {
        calls.push(`metadata:${id}`);
        return { title: "Another Film", year: 2020 };
      }),
    getMovies: () =>
      Effect.sync(() => {
        calls.push("movies");
        return movies;
      }),
    getTVShows: () =>
      Effect.sync(() => {
        calls.push("shows");
        return shows;
      }),
    getTVShowDetail: (id) =>
      Effect.sync(() => {
        calls.push(`detail:${id}`);
        return detail;
      }),
    getTVShowSeason: (id, number) =>
      Effect.sync(() => {
        calls.push(`season:${id}:${number}`);
        return season;
      }),
    search: (query) =>
      Effect.sync(() => {
        calls.push(`search:${query}`);
        return create(SearchResponseSchema, { query, results: [release] });
      }),
  });
  return {
    calls,
    movies,
    shows,
    detail,
    season,
    service,
    layer: Layer.succeed(DiscoveryEngine, service),
  };
}

test("discovery catalogs preserve opaque movie identity and Engine metadata", async () => {
  const f = fixture();
  const result = await Effect.runPromise(
    discovery
      .catalog({ type: "movie", id: "discover-movies" })
      .pipe(Effect.provide(f.layer)),
  );
  assert.equal(result.metas.length, 1);
  const item = result.metas[0];
  assert.ok(item);
  assert.equal(item.name, movie.title);
  assert.equal(item.poster, movie.posterUrl);
  assert.equal(item.background, movie.backdropUrl);
  assert.equal(item.description, movie.overview);
  assert.equal(item.id, "chill:movie:Y2F0YWxvZy9vcGFxdWUgaWRlbnRpdHk");
  assert.deepEqual(
    await Effect.runPromise(
      readDiscoveryTarget({ type: "movie", id: item.id }),
    ),
    { kind: "movie", id: movie.id },
  );
  assert.deepEqual(f.calls, ["movies"]);
  assert.doesNotMatch(JSON.stringify(result), /download_token|fixture-only/);
});

test("movie and series catalogs filter and paginate without provider mutations", async () => {
  const f = fixture();
  f.movies.movies = Array.from({ length: 105 }, (_, i) =>
    create(MovieSchema, { ...movie, id: String(i), title: `Film ${i}` }),
  );
  const result = await Effect.runPromise(
    discovery
      .catalog({ type: "movie", id: "discover-movies", extra: { skip: "100" } })
      .pipe(Effect.provide(f.layer)),
  );
  assert.equal(result.metas.length, 5);
  const series = await Effect.runPromise(
    discovery
      .catalog({
        type: "series",
        id: "discover-series",
        extra: { search: "independent" },
      })
      .pipe(Effect.provide(f.layer)),
  );
  assert.equal(series.metas[0]?.id, `chill:series:${imdbId}`);
  assert.deepEqual(f.calls, ["movies", "shows"]);
});

test("TV detail exposes verified season episodes and does not search or acquire", async () => {
  const f = fixture();
  const result = await Effect.runPromise(
    discovery
      .meta({ type: "series", id: `chill:series:${imdbId}` })
      .pipe(Effect.provide(f.layer)),
  );
  assert.ok(result.meta && "videos" in result.meta);
  assert.equal(result.meta.videos?.[0]?.id, `chill:episode:${imdbId}:1:2`);
  assert.equal(result.meta.videos?.[0]?.released, "2023-02-03T00:00:00.000Z");
  assert.deepEqual(f.calls, [`detail:${imdbId}`, `season:${imdbId}:1`]);
});

test("release search remains release-shaped and keeps download credentials server-side", async () => {
  const f = fixture();
  const catalog = await Effect.runPromise(
    discovery
      .catalog({
        type: "movie",
        id: "discover-releases",
        extra: { search: "independent film" },
      })
      .pipe(Effect.provide(f.layer)),
  );
  const item = catalog.metas[0];
  assert.ok(item);
  assert.equal(item.name, release.title);
  assert.equal(item.poster, undefined);
  const target = await Effect.runPromise(
    readDiscoveryTarget({ type: "movie", id: item.id }),
  );
  assert.deepEqual(target, {
    kind: "release",
    query: "independent film",
    id: release.id,
  });
  assert.deepEqual(f.calls, ["search:independent film"]);
  assert.doesNotMatch(JSON.stringify(catalog), /download_token|fixture-only/);
  const candidates = await Effect.runPromise(
    discovery.releases(target).pipe(Effect.provide(f.layer)),
  );
  assert.equal(candidates[0]?.url, release.link);
  assert.equal(candidates[0]?.size, 5000000000n);
});

test("search results reopen by stable identity while download credentials refresh", async () => {
  const f = fixture();
  let searchCount = 0;
  let present = true;
  f.service.search = (query) =>
    Effect.sync(() => {
      searchCount++;
      return create(SearchResponseSchema, {
        query,
        results: [
          {
            ...release,
            id: present ? release.id : "replacement-with-same-title",
            link: `https://api.example/download?download_token=fresh-${searchCount}`,
            seeders: BigInt(searchCount),
          },
        ],
      });
    });
  const layer = Layer.succeed(DiscoveryEngine, f.service);
  const catalog = await Effect.runPromise(
    discovery
      .catalog({
        type: "movie",
        id: "discover-releases",
        extra: { search: "independent" },
      })
      .pipe(Effect.provide(layer)),
  );
  const item = catalog.metas[0];
  assert.ok(item);
  const request = { type: "movie", id: item.id };
  const meta = await Effect.runPromise(
    discovery.meta(request).pipe(Effect.provide(layer)),
  );
  assert.equal(meta.meta?.name, release.title);
  assert.doesNotMatch(
    JSON.stringify({ catalog, meta }),
    /download_token|fresh-/,
  );
  const target = await Effect.runPromise(readDiscoveryTarget(request));
  const candidates = await Effect.runPromise(
    discovery.releases(target).pipe(Effect.provide(layer)),
  );
  assert.equal(searchCount, 3);
  assert.equal(candidates[0]?.id, release.id);
  assert.equal(
    candidates[0]?.url,
    "https://api.example/download?download_token=fresh-3",
  );
  present = false;
  assert.deepEqual(
    await Effect.runPromise(
      discovery.meta(request).pipe(Effect.provide(layer)),
    ),
    { meta: null },
  );
  assert.deepEqual(
    await Effect.runPromise(
      discovery.releases(target).pipe(Effect.provide(layer)),
    ),
    [],
  );
});

test("episode metadata retains verified show and episode context without searching", async () => {
  const f = fixture();
  const id = discoveryTargetId({
    kind: "episode",
    imdbId,
    season: 1,
    episode: 2,
  });
  const result = await Effect.runPromise(
    discovery.meta({ type: "series", id }).pipe(Effect.provide(f.layer)),
  );
  assert.equal(result.meta?.poster, show.posterUrl);
  assert.equal(result.meta?.background, "https://images.example/still.jpg");
  assert.equal(result.meta?.description, "A scene");
  assert.match(result.meta?.name ?? "", /S01E02 · The second episode/);
  assert.ok(result.meta && "videos" in result.meta);
  assert.equal(result.meta.videos?.[0]?.id, id);
  assert.deepEqual(f.calls, [`detail:${imdbId}`, `season:${imdbId}:1`]);
  f.season.episodes = [];
  assert.deepEqual(
    await Effect.runPromise(
      discovery.meta({ type: "series", id }).pipe(Effect.provide(f.layer)),
    ),
    { meta: null },
  );
});

test("release artwork uses exact IMDb identity while acquisition retains fresh release credentials", async () => {
  const f = fixture();
  const first = f.movies.movies[0];
  assert.ok(first);
  first.externalUrl = `https://www.imdb.com/title/${imdbId}/`;
  let reads = 0;
  f.service.search = (query) =>
    Effect.sync(() =>
      create(SearchResponseSchema, {
        query,
        results: [
          {
            ...release,
            imdbId,
            link: `https://api.example/download?download_token=${++reads}`,
          },
        ],
      }),
    );
  const layer = Layer.succeed(DiscoveryEngine, f.service);
  const target = {
    kind: "release" as const,
    query: "unrelated query text",
    id: release.id,
  };
  const result = await Effect.runPromise(
    discovery
      .meta({ type: "movie", id: discoveryTargetId(target) })
      .pipe(Effect.provide(layer)),
  );
  assert.equal(result.meta?.name, release.title);
  assert.equal(result.meta?.poster, movie.posterUrl);
  assert.equal(result.meta?.background, movie.backdropUrl);
  assert.equal(
    result.meta?.description,
    `${movie.overview}\n\nExample · 8 seeders · 4.66 GiB`,
  );
  const candidates = await Effect.runPromise(
    discovery.releases(target).pipe(Effect.provide(layer)),
  );
  assert.equal(candidates[0]?.id, release.id);
  assert.equal(
    candidates[0]?.url,
    "https://api.example/download?download_token=2",
  );
  assert.doesNotMatch(JSON.stringify(result), /download_token/);
  const catalog = await Effect.runPromise(
    discovery
      .catalog({
        type: "movie",
        id: "discover-releases",
        extra: { search: target.query },
      })
      .pipe(Effect.provide(layer)),
  );
  assert.equal(catalog.metas[0]?.poster, movie.posterUrl);
  assert.equal(catalog.metas[0]?.id, discoveryTargetId(target));
  assert.equal(catalog.metas[0]?.name, release.title);
});

test("ambiguous, unmatched and lookalike movie associations keep filename-only metadata", async () => {
  for (const association of ["missing", "duplicate", "lookalike"]) {
    const f = fixture();
    const first = f.movies.movies[0];
    assert.ok(first);
    first.externalUrl =
      association === "lookalike"
        ? `https://imdb.com.example/title/${imdbId}/`
        : `https://www.imdb.com/title/${imdbId}/`;
    if (association === "duplicate")
      f.movies.movies.push(
        create(MovieSchema, { ...first, id: "other-release-of-same-movie" }),
      );
    f.service.search = (query) =>
      Effect.succeed(
        create(SearchResponseSchema, {
          query,
          results: [
            {
              ...release,
              title: movie.title,
              imdbId: association === "missing" ? undefined : imdbId,
            },
          ],
        }),
      );
    const result = await Effect.runPromise(
      discovery
        .meta({
          type: "movie",
          id: discoveryTargetId({
            kind: "release",
            query: movie.title,
            id: release.id,
          }),
        })
        .pipe(Effect.provide(Layer.succeed(DiscoveryEngine, f.service))),
    );
    assert.equal(result.meta?.poster, undefined);
    assert.equal(result.meta?.background, undefined);
    assert.equal(result.meta?.name, movie.title);
    assert.equal(result.meta?.description, "Example · 8 seeders · 4.66 GiB");
  }
});

test("TV release artwork requires exact show and episode membership", async () => {
  const f = fixture();
  let episode = 2;
  f.service.search = (query) =>
    Effect.succeed(
      create(SearchResponseSchema, {
        query,
        results: [{ ...release, imdbId, releaseInfo: { season: 1, episode } }],
      }),
    );
  const layer = Layer.succeed(DiscoveryEngine, f.service);
  const input = {
    type: "movie",
    id: discoveryTargetId({
      kind: "release",
      query: "anything",
      id: release.id,
    }),
  };
  const result = await Effect.runPromise(
    discovery.meta(input).pipe(Effect.provide(layer)),
  );
  assert.equal(result.meta?.poster, show.posterUrl);
  assert.equal(result.meta?.background, "https://images.example/still.jpg");
  assert.match(result.meta?.description ?? "", /S01E02 · The second episode/);
  episode = 9;
  const missing = await Effect.runPromise(
    discovery.meta(input).pipe(Effect.provide(layer)),
  );
  assert.equal(missing.meta?.poster, undefined);
});

test("small unmatched releases retain a useful size and cannot borrow title-matched artwork", async () => {
  const f = fixture();
  f.service.search = (query) =>
    Effect.succeed(
      create(SearchResponseSchema, {
        query,
        results: [
          { ...release, title: movie.title, size: 1048576n, imdbId: "unknown" },
        ],
      }),
    );
  const result = await Effect.runPromise(
    discovery
      .meta({
        type: "movie",
        id: discoveryTargetId({
          kind: "release",
          query: movie.title,
          id: release.id,
        }),
      })
      .pipe(Effect.provide(Layer.succeed(DiscoveryEngine, f.service))),
  );
  assert.equal(result.meta?.poster, undefined);
  assert.equal(result.meta?.description, "Example · 8 seeders · 1.00 MiB");
});

test("mixed search results cannot associate missing IMDb identifiers with missing catalog links", async () => {
  const f = fixture();
  f.service.search = (query) =>
    Effect.succeed(
      create(SearchResponseSchema, {
        query,
        results: [
          { ...release, id: "identified", imdbId },
          { ...release, id: "unidentified" },
        ],
      }),
    );
  const result = await Effect.runPromise(
    discovery
      .catalog({
        type: "movie",
        id: "discover-releases",
        extra: { search: movie.title },
      })
      .pipe(Effect.provide(Layer.succeed(DiscoveryEngine, f.service))),
  );
  assert.equal(result.metas.length, 2);
  assert.ok(
    result.metas.every(
      (meta) => meta.poster === undefined && meta.background === undefined,
    ),
  );
});

test("release search paginates once before artwork association", async () => {
  const f = fixture();
  f.service.search = (query) =>
    Effect.succeed(
      create(SearchResponseSchema, {
        query,
        results: Array.from({ length: 105 }, (_, i) => ({
          ...release,
          id: String(i),
        })),
      }),
    );
  const result = await Effect.runPromise(
    discovery
      .catalog({
        type: "movie",
        id: "discover-releases",
        extra: { search: "independent", skip: "100" },
      })
      .pipe(Effect.provide(Layer.succeed(DiscoveryEngine, f.service))),
  );
  assert.equal(result.metas.length, 5);
  assert.deepEqual(
    await Effect.runPromise(
      readDiscoveryTarget({ type: "movie", id: result.metas[0]?.id ?? "" }),
    ),
    { kind: "release", query: "independent", id: "100" },
  );
  assert.deepEqual(f.calls, []);
});

test("acquisition candidates are freshly searched against current movie and episode membership", async () => {
  const f = fixture();
  await Effect.runPromise(
    discovery
      .releases({ kind: "movie", id: movie.id })
      .pipe(Effect.provide(f.layer)),
  );
  assert.deepEqual(f.calls, ["movies", `search:${movie.title} ${movie.year}`]);
  f.calls.length = 0;
  await Effect.runPromise(
    discovery
      .releases({ kind: "episode", imdbId, season: 1, episode: 2 })
      .pipe(Effect.provide(f.layer)),
  );
  assert.deepEqual(f.calls, [
    `detail:${imdbId}`,
    `season:${imdbId}:1`,
    `search:${show.title} S01E02`,
  ]);
  f.calls.length = 0;
  const absent = await Effect.runPromise(
    discovery
      .releases({ kind: "episode", imdbId, season: 1, episode: 9 })
      .pipe(Effect.provide(f.layer)),
  );
  assert.deepEqual(absent, []);
  assert.deepEqual(f.calls, [`detail:${imdbId}`, `season:${imdbId}:1`]);
});

test("malformed requests fail before Engine reads", async () => {
  const f = fixture();
  for (const input of [
    { type: "series", id: "discover-movies" },
    { type: "movie", id: "discover-series" },
    { type: "movie", id: "discover-movies", extra: { skip: "-1" } },
    {
      type: "movie",
      id: "discover-releases",
      extra: { search: "a".repeat(257) },
    },
  ]) {
    const error = await Effect.runPromise(
      discovery.catalog(input).pipe(Effect.provide(f.layer), Effect.flip),
    );
    assert.equal(error.code, "invalid_request");
  }
  for (const input of [
    { type: "movie", id: "chill:movie:YQ==" },
    { type: "series", id: "chill:movie:YQ" },
    { type: "series", id: `chill:episode:${imdbId}:01:2` },
    { type: "movie", id: "chill:release::YQ" },
  ]) {
    const error = await Effect.runPromise(
      readDiscoveryTarget(input).pipe(Effect.flip),
    );
    assert.equal(error.code, "invalid_request");
  }
  assert.deepEqual(f.calls, []);
});

test("malformed and excessive metadata fails closed", async () => {
  const f = fixture();
  const first = f.movies.movies[0];
  assert.ok(first);
  first.posterUrl = "https://user:secret@images.example/image";
  assert.equal(
    (
      await Effect.runPromise(
        discovery
          .catalog({ type: "movie", id: "discover-movies" })
          .pipe(Effect.provide(f.layer), Effect.flip),
      )
    ).code,
    "invalid_response",
  );
  first.posterUrl = movie.posterUrl;
  f.movies.movies.push(first);
  assert.equal(
    (
      await Effect.runPromise(
        discovery
          .catalog({ type: "movie", id: "discover-movies" })
          .pipe(Effect.provide(f.layer), Effect.flip),
      )
    ).code,
    "invalid_response",
  );
  f.detail.seasons = Array.from({ length: 41 }, (_, i) =>
    create(TVShowSeasonSchema, { seasonNumber: i }),
  );
  assert.equal(
    (
      await Effect.runPromise(
        discovery
          .meta({ type: "series", id: `chill:series:${imdbId}` })
          .pipe(Effect.provide(f.layer), Effect.flip),
      )
    ).code,
    "invalid_response",
  );
});

test("wrong episode identity and auth errors never become an empty successful catalog", async () => {
  const f = fixture();
  f.season.imdbId = "tt7654321";
  assert.equal(
    (
      await Effect.runPromise(
        discovery
          .meta({ type: "series", id: `chill:series:${imdbId}` })
          .pipe(Effect.provide(f.layer), Effect.flip),
      )
    ).code,
    "invalid_response",
  );
  f.service.getMovies = () =>
    Effect.fail(new EngineError({ code: "unauthenticated" }));
  const error = await Effect.runPromise(
    discovery
      .catalog({ type: "movie", id: "discover-movies" })
      .pipe(
        Effect.provide(Layer.succeed(DiscoveryEngine, f.service)),
        Effect.flip,
      ),
  );
  assert.equal(error.code, "unauthenticated");
});

test("validated magnet releases stay available only to acquisition dispatch", async () => {
  const f = fixture();
  const magnet = "magnet:?xt=urn:btih:0123456789012345678901234567890123456789";
  f.service.search = (query) =>
    Effect.succeed(
      create(SearchResponseSchema, {
        query,
        results: [{ ...release, link: magnet }],
      }),
    );
  const layer = Layer.succeed(DiscoveryEngine, f.service);
  const target = {
    kind: "release",
    query: "independent",
    id: release.id,
  } satisfies import("../src/discovery.ts").DiscoveryTarget;
  const candidates = await Effect.runPromise(
    discovery.releases(target).pipe(Effect.provide(layer)),
  );
  assert.equal(candidates[0]?.url, magnet);
  const catalog = await Effect.runPromise(
    discovery
      .catalog({
        type: "movie",
        id: "discover-releases",
        extra: { search: "independent" },
      })
      .pipe(Effect.provide(layer)),
  );
  assert.doesNotMatch(JSON.stringify(catalog), /magnet:|urn:btih/);
});

test("failed indexers cannot masquerade as a successful empty release search", async () => {
  const f = fixture();
  f.service.search = (query) =>
    Effect.succeed(
      create(SearchResponseSchema, {
        query,
        indexerStats: [{ id: "example", error: "upstream unavailable" }],
      }),
    );
  const error = await Effect.runPromise(
    discovery
      .catalog({
        type: "movie",
        id: "discover-releases",
        extra: { search: "independent" },
      })
      .pipe(
        Effect.provide(Layer.succeed(DiscoveryEngine, f.service)),
        Effect.flip,
      ),
  );
  assert.equal(error.code, "unavailable");
});

test("optional release artwork outages preserve search and exact release opening", async () => {
  for (const code of [
    "unavailable",
    "deadline_exceeded",
    "not_found",
  ] as const) {
    const f = fixture();
    f.service.getMovies = () => Effect.fail(new EngineError({ code }));
    f.service.search = (query) =>
      Effect.succeed(
        create(SearchResponseSchema, {
          query,
          results: [{ ...release, imdbId }],
        }),
      );
    const layer = Layer.succeed(DiscoveryEngine, f.service);
    const catalog = await Effect.runPromise(
      discovery
        .catalog({
          type: "movie",
          id: "discover-releases",
          extra: { search: movie.title },
        })
        .pipe(Effect.provide(layer)),
    );
    assert.equal(catalog.metas.length, 1);
    const id = discoveryTargetId({
      kind: "release",
      query: movie.title,
      id: release.id,
    });
    assert.equal(catalog.metas[0]?.id, id);
    assert.equal(catalog.metas[0]?.poster, undefined);
    const result = await Effect.runPromise(
      discovery.meta({ type: "movie", id }).pipe(Effect.provide(layer)),
    );
    assert.equal(result.meta?.name, release.title);
    assert.equal(result.meta?.poster, undefined);
    assert.match(result.meta?.description ?? "", /Example · 8 seeders/);
    const resolved = await Effect.runPromise(
      discovery
        .releases({ kind: "release", query: movie.title, id: release.id })
        .pipe(Effect.provide(layer)),
    );
    assert.equal(resolved[0]?.id, release.id);
    assert.equal(resolved[0]?.url, release.link);
  }
});

test("optional artwork does not hide authentication or malformed catalog failures", async () => {
  for (const code of [
    "unauthenticated",
    "permission_denied",
    "invalid_response",
  ] as const) {
    const f = fixture();
    f.service.getMovies = () => Effect.fail(new EngineError({ code }));
    f.service.search = (query) =>
      Effect.succeed(
        create(SearchResponseSchema, {
          query,
          results: [{ ...release, imdbId }],
        }),
      );
    const layer = Layer.succeed(DiscoveryEngine, f.service);
    const id = discoveryTargetId({
      kind: "release",
      query: movie.title,
      id: release.id,
    });
    for (const effect of [
      discovery
        .catalog({
          type: "movie",
          id: "discover-releases",
          extra: { search: movie.title },
        })
        .pipe(Effect.asVoid),
      discovery.meta({ type: "movie", id }).pipe(Effect.asVoid),
    ]) {
      const result = await Effect.runPromise(
        effect.pipe(Effect.flip, Effect.provide(layer)),
      );
      assert.equal(result.code, code);
    }
  }
});

test("standard IMDb movie cards search the matching catalog title", async () => {
  const f = fixture();
  assert.ok(f.movies.movies[0]);
  f.movies.movies[0].externalUrl = `https://www.imdb.com/title/${imdbId}/`;
  const target = await Effect.runPromise(
    readDiscoveryTarget({ type: "movie", id: imdbId }),
  );
  const candidates = await Effect.runPromise(
    discovery.releases(target).pipe(Effect.provide(f.layer)),
  );
  assert.equal(candidates[0]?.id, release.id);
  assert.deepEqual(f.calls, ["movies", `search:${movie.title} ${movie.year}`]);
});

test("standard IMDb episode cards share the existing episode acquisition identity", async () => {
  const f = fixture();
  const target = await Effect.runPromise(
    readDiscoveryTarget({ type: "series", id: `${imdbId}:1:2` }),
  );
  assert.equal(discoveryTargetId(target), `chill:episode:${imdbId}:1:2`);
  const candidates = await Effect.runPromise(
    discovery.releases(target).pipe(Effect.provide(f.layer)),
  );
  assert.equal(candidates[0]?.id, release.id);
  assert.deepEqual(f.calls, [
    `detail:${imdbId}`,
    `season:${imdbId}:1`,
    `search:${show.title} S01E02`,
  ]);
});

test("malformed standard IDs never reach discovery", async () => {
  for (const input of [
    { type: "movie", id: "tt1234567:1:2" },
    { type: "movie", id: "tt1234567/other" },
    { type: "series", id: "tt1234567" },
    { type: "series", id: "tt1234567:01:2" },
    { type: "series", id: "tt1234567:1:0" },
    { type: "series", id: "tt1234567:1:2:3" },
  ]) {
    const failure = await Effect.runPromise(
      readDiscoveryTarget(input).pipe(Effect.flip),
    );
    assert.equal(failure.code, "invalid_request");
  }
});

test("IMDb movies share catalog acquisition identity when available", async () => {
  const f = fixture();
  assert.ok(f.movies.movies[0]);
  f.movies.movies[0].externalUrl = `https://www.imdb.com/title/${imdbId}/`;
  const target = await Effect.runPromise(
    discovery
      .resolveTarget({ type: "movie", id: imdbId })
      .pipe(Effect.provide(f.layer)),
  );
  assert.equal(
    discoveryTargetId(target),
    discoveryTargetId({ kind: "movie", id: movie.id }),
  );
});

test("IMDb movie outside the current catalog resolves public metadata before searching", async () => {
  const f = fixture();
  const target = await Effect.runPromise(
    discovery
      .resolveTarget({ type: "movie", id: imdbId })
      .pipe(Effect.provide(f.layer)),
  );
  assert.equal(discoveryTargetId(target), imdbId);
  const releases = await Effect.runPromise(
    discovery.releases(target).pipe(Effect.provide(f.layer)),
  );
  assert.equal(releases[0]?.id, release.id);
  assert.deepEqual(f.calls, [
    "movies",
    "movies",
    `metadata:${imdbId}`,
    "search:Another Film 2020",
  ]);
});
