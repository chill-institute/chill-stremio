import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { createServer, get, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import * as proto from "@chill-institute/contracts/chill/v4/api_pb";
import { Schema } from "effect";
import { test, vi } from "vite-plus/test";
import { redactCredentials } from "../src/credential.ts";
import { startHostedAdapter } from "../src/hosted.ts";
import { statusMediaKinds, statusPlaylist } from "../src/status-media.ts";
import { discoveryTargetId } from "../src/discovery.ts";

// Poll pending playback quickly; its window and continuation limits stay real.
vi.mock("../src/playback-wait.ts", async (original) => {
  const actual = await original<typeof import("../src/playback-wait.ts")>();
  return { ...actual, playbackWait: { ...actual.playbackWait, pollMs: 20 } };
});

const statusSegment = Buffer.alloc(188 * 2, 0x47);
const statusMedia = new Map(
  statusMediaKinds.map((kind) => [
    kind,
    {
      mp4: Buffer.from("fixture-status-video"),
      m3u8: Buffer.from(statusPlaylist(kind)),
      ts: statusSegment,
    },
  ]),
);
const webOrigin = "http://127.0.0.1:3000";
const credential = () => `v4.local.${randomBytes(300).toString("base64url")}`;
const ownerCredential = credential();
const otherCredential = credential();
// More accepted links, so stalled requests can fill the whole process.
const spareCredentials = [credential(), credential()];
const target = discoveryTargetId({ kind: "movie", id: "fixture-film" });
const episodeTarget = discoveryTargetId({
  kind: "episode",
  imdbId: "tt7654321",
  season: 1,
  episode: 2,
});
const seasonPackLink =
  "https://engine.fixture.test/download?token=fixture-season-secret";
const parsedReleaseLink = (id: string) =>
  `https://engine.fixture.test/download?token=fixture-${id}`;
const Catalog = Schema.Struct({
  metas: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String }),
  ),
});
const Streams = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      url: Schema.optional(Schema.String),
      externalUrl: Schema.optional(Schema.String),
    }),
  ),
});
async function decode<A, I>(
  response: Response,
  schema: Schema.Codec<A, I>,
): Promise<A> {
  const value: unknown = await response.json();
  return Schema.decodeUnknownSync(schema)(value);
}

async function fixture(
  options: { selectionReuseMs?: number; selectionPendingMs?: number } = {},
) {
  const calls: {
    method: string;
    owner: string;
    timeout: string | string[] | undefined;
  }[] = [];
  const searches: string[] = [];
  const listings: { id: bigint; releaseInfo: boolean }[] = [];
  const ownedLookups: {
    title: string;
    year: number;
    season?: number;
    episode?: number;
  }[] = [];
  const state = {
    loseTransferResponse: false,
    stallMovies: false,
    addCount: 0,
    addDelayMs: 0,
    engineDelayMs: 0,
    heldCalls: 0,
    addCredentials: [] as (string | string[] | undefined)[],
    addUrls: [] as string[],
    transferFinished: true,
    transferStatus: undefined as string | undefined,
    singleFile: false,
    // Folder listings that replace or add to the defaults, by folder ID.
    folders: new Map<
      bigint,
      {
        id: bigint;
        name: string;
        fileType: string;
        releaseInfo?: {
          season?: number;
          episode?: number;
          episodeEnd?: number;
        };
      }[]
    >(),
    seasonPack: undefined as
      | { id: string; resolution: string; codec: string; quality: string }
      | undefined,
    seasonRejection: undefined as { status: number; code: string } | undefined,
    stallSeasonPack: false,
    seasonDelayMs: 0,
    abandonedSeasonLookups: 0,
    // Videos FindOwnedVideos returns; each one also resolves for playback.
    ownedVideos: [] as { id: bigint; name: string; fileType?: string }[],
    ownedRejection: undefined as { status: number; code: string } | undefined,
    ownedDelayMs: 0,
    playbackPending: false,
    rejection: undefined as { status: number; code: string } | undefined,
    // An AddTransfer refusal and the stable code Engine sends with it.
    addRejection: undefined as
      | { status: number; code: string; engineCode?: string }
      | undefined,
    // Engine latency by method on the global clock, which tests may fake.
    delayMs: {} as Partial<Record<string, number>>,
    // Wall-clock time a method takes, for tests that fake `Date`.
    elapsedMs: {} as Partial<Record<string, number>>,
    releaseMissing: false,
    // Search results listed after the fixture release, with release info.
    parsedReleases: [] as {
      id: string;
      releaseInfo?: { season?: number; episode?: number; episodeEnd?: number };
    }[],
    // Search results listed after those.
    extraReleases: 0,
    indexerError: "",
  };
  const error = (
    response: ServerResponse,
    status: number,
    code: string,
    engineCode?: string,
  ) => {
    response.writeHead(status, {
      "content-type": "application/json",
      ...(engineCode && { "chill-error-code": engineCode }),
    });
    response.end(JSON.stringify({ code, message: "fixture error" }));
  };
  // Global timers, so a test's fake clock decides this Engine latency.
  const hold = async () => {
    if (!state.engineDelayMs) return;
    state.heldCalls++;
    await new Promise((resolve) => setTimeout(resolve, state.engineDelayMs));
  };
  const engine = createServer((request, response) => {
    void (async () => {
      const presented = request.headers["x-chill-stremio-credential"];
      const owner =
        presented === ownerCredential
          ? "101"
          : presented === otherCredential
            ? "202"
            : typeof presented === "string" &&
                spareCredentials.includes(presented)
              ? "303"
              : undefined;
      if (!owner || request.headers.authorization !== undefined) {
        error(response, 401, "unauthenticated");
        return;
      }
      const method = request.url?.split("/").at(-1) ?? "";
      calls.push({
        method,
        owner,
        timeout: request.headers["connect-timeout-ms"],
      });
      const elapsed = state.elapsedMs[method];
      if (elapsed) vi.setSystemTime(Date.now() + elapsed);
      const delay = state.delayMs[method];
      if (delay) {
        state.heldCalls++;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      assert.equal(request.method, "POST");
      if (state.rejection) {
        error(response, state.rejection.status, state.rejection.code);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const json = Buffer.concat(chunks).toString("utf8");
      response.setHeader("content-type", "application/json");
      switch (method) {
        case "GetFolder": {
          const { id, includeReleaseInfo } = fromJsonString(
            proto.GetFolderRequestSchema,
            json,
          );
          listings.push({ id, releaseInfo: includeReleaseInfo });
          await hold();
          const files =
            state.folders.get(id) ??
            (id === 0n
              ? [{ id: 42n, name: "Nested library", fileType: "FOLDER" }]
              : id === 42n
                ? [{ id: 50n, name: "Existing video", fileType: "VIDEO" }]
                : id === 10n
                  ? [
                      {
                        id: 20n,
                        name: "Acquired film folder",
                        fileType: "FOLDER",
                      },
                      { id: 99n, name: "Unrelated video", fileType: "VIDEO" },
                    ]
                  : id === 20n
                    ? [
                        { id: 21n, name: "First video", fileType: "VIDEO" },
                        ...(state.singleFile
                          ? []
                          : [
                              {
                                id: 22n,
                                name: "Second video",
                                fileType: "VIDEO",
                              },
                            ]),
                      ]
                    : undefined);
          if (!files) {
            error(response, 404, "not_found");
            return;
          }
          response.end(
            toJsonString(
              proto.GetFolderResponseSchema,
              create(proto.GetFolderResponseSchema, {
                parent: { id, name: "Fixture folder", fileType: "FOLDER" },
                files: files.map(({ releaseInfo, ...file }) =>
                  includeReleaseInfo ? { ...file, releaseInfo } : file,
                ),
              }),
            ),
          );
          return;
        }
        case "GetMovies":
          if (state.stallMovies) {
            response.writeHead(200);
            response.write("{");
            return;
          }
          fromJsonString(proto.GetMoviesRequestSchema, json);
          response.end(
            toJsonString(
              proto.GetMoviesResponseSchema,
              create(proto.GetMoviesResponseSchema, {
                movies: [
                  {
                    id: "fixture-film",
                    externalUrl: "https://www.imdb.com/title/tt1234567/",
                    title: "Independent film",
                    year: 2024,
                    overview: "Fixture overview",
                    posterUrl: "https://images.fixture.test/poster.jpg",
                  },
                ],
              }),
            ),
          );
          return;
        case "GetTVShowDetail": {
          const { imdbId } = fromJsonString(
            proto.GetTVShowDetailRequestSchema,
            json,
          );
          response.end(
            toJsonString(
              proto.GetTVShowDetailResponseSchema,
              create(proto.GetTVShowDetailResponseSchema, {
                show: { imdbId, title: "Independent series", year: 2024 },
                seasons: [{ seasonNumber: 1 }],
              }),
            ),
          );
          return;
        }
        case "GetTVShowSeason": {
          const { imdbId, seasonNumber } = fromJsonString(
            proto.GetTVShowSeasonRequestSchema,
            json,
          );
          response.end(
            toJsonString(
              proto.GetTVShowSeasonResponseSchema,
              create(proto.GetTVShowSeasonResponseSchema, {
                imdbId,
                seasonNumber,
                episodes: [
                  { seasonNumber, episodeNumber: 2, name: "Episode two" },
                ],
              }),
            ),
          );
          return;
        }
        case "Search": {
          const { query } = fromJsonString(proto.UserSearchRequestSchema, json);
          searches.push(query);
          await hold();
          response.end(
            toJsonString(
              proto.SearchResponseSchema,
              create(proto.SearchResponseSchema, {
                query,
                indexerStats: state.indexerError
                  ? [{ id: "slow", name: "Slow", error: state.indexerError }]
                  : [],
                results: [
                  {
                    id: state.releaseMissing
                      ? "other-release"
                      : "fixture-release",
                    title: "Independent.Film.1080p",
                    indexer: "Fixture",
                    link: "https://engine.fixture.test/download?token=fixture-release-secret",
                    size: 12345n,
                    seeders: 3n,
                  },
                  ...state.parsedReleases.map(({ id, releaseInfo }) => ({
                    id,
                    title: `Independent.Series.${id}`,
                    indexer: "Fixture",
                    link: parsedReleaseLink(id),
                    size: 12345n,
                    seeders: 2n,
                    releaseInfo: releaseInfo && {
                      title: "Independent Series",
                      ...releaseInfo,
                    },
                  })),
                  ...Array.from({ length: state.extraReleases }, (_, n) => ({
                    id: `fixture-release-${n}`,
                    title: "Independent.Film.720p",
                    indexer: "Fixture",
                    link: "https://engine.fixture.test/download?token=fixture-release-secret",
                    size: 12345n,
                    seeders: 1n,
                  })),
                ],
              }),
            ),
          );
          return;
        }
        case "GetTVShowSeasonDownloads": {
          const { seasonNumber } = fromJsonString(
            proto.GetTVShowSeasonDownloadsRequestSchema,
            json,
          );
          if (state.stallSeasonPack) {
            response.once("close", () => state.abandonedSeasonLookups++);
            return;
          }
          if (state.seasonRejection) {
            error(
              response,
              state.seasonRejection.status,
              state.seasonRejection.code,
            );
            return;
          }
          await sleep(state.seasonDelayMs);
          response.end(
            toJsonString(
              proto.GetTVShowSeasonDownloadsResponseSchema,
              create(proto.GetTVShowSeasonDownloadsResponseSchema, {
                seasonPack: state.seasonPack && {
                  ...state.seasonPack,
                  title: "Independent.Series.S01.1080p",
                  link: seasonPackLink,
                  indexer: "Fixture",
                  size: 2147483648n,
                  seeders: 5n,
                  seasonNumber,
                },
                episodes: [
                  {
                    episodeNumber: 2,
                    searchQuery: "Independent series S01E02",
                  },
                ],
              }),
            ),
          );
          return;
        }
        case "FindOwnedVideos": {
          const { title, year, season, episode } = fromJsonString(
            proto.FindOwnedVideosRequestSchema,
            json,
          );
          ownedLookups.push({
            title,
            year,
            ...(season !== undefined && { season }),
            ...(episode !== undefined && { episode }),
          });
          if (state.ownedRejection) {
            error(
              response,
              state.ownedRejection.status,
              state.ownedRejection.code,
            );
            return;
          }
          await sleep(state.ownedDelayMs);
          response.end(
            toJsonString(
              proto.FindOwnedVideosResponseSchema,
              create(proto.FindOwnedVideosResponseSchema, {
                videos: state.ownedVideos.map((video) => ({
                  fileType: "VIDEO",
                  ...video,
                })),
              }),
            ),
          );
          return;
        }
        case "AddTransfer": {
          const { url } = fromJsonString(proto.AddTransferRequestSchema, json);
          assert.ok(
            [
              "https://engine.fixture.test/download?token=fixture-release-secret",
              seasonPackLink,
              ...state.parsedReleases.map(({ id }) => parsedReleaseLink(id)),
            ].includes(url),
          );
          state.addCount++;
          state.addUrls.push(url);
          state.addCredentials.push(presented);
          if (state.addRejection) {
            const { status, code, engineCode } = state.addRejection;
            error(response, status, code, engineCode);
            return;
          }
          await sleep(state.addDelayMs);
          await hold();
          if (state.loseTransferResponse) {
            response.destroy();
            return;
          }
          response.end(
            toJsonString(
              proto.AddTransferResponseSchema,
              create(proto.AddTransferResponseSchema, {
                status: "success",
                transfer: {
                  id: 90n,
                  status:
                    state.transferStatus ??
                    (state.transferFinished ? "COMPLETED" : "DOWNLOADING"),
                  isFinished: state.transferFinished,
                  percentDone: state.transferFinished ? 100 : 42,
                  fileId: 20n,
                  saveParentId: 10n,
                },
              }),
            ),
          );
          return;
        }
        case "GetTransfer": {
          const { id } = fromJsonString(proto.GetTransferRequestSchema, json);
          await hold();
          if (id !== 90n) {
            error(response, 404, "not_found");
            return;
          }
          response.end(
            toJsonString(
              proto.GetTransferResponseSchema,
              create(proto.GetTransferResponseSchema, {
                transfer: {
                  id,
                  status:
                    state.transferStatus ??
                    (state.transferFinished ? "COMPLETED" : "DOWNLOADING"),
                  isFinished: state.transferFinished,
                  percentDone: state.transferFinished ? 100 : 42,
                  fileId: 20n,
                  saveParentId: 10n,
                },
              }),
            ),
          );
          return;
        }
        case "ResolvePlayback": {
          const { fileId } = fromJsonString(
            proto.ResolvePlaybackRequestSchema,
            json,
          );
          if (
            ![21n, 22n, 50n, ...state.ownedVideos.map(({ id }) => id)].includes(
              fileId,
            )
          ) {
            error(response, 404, "not_found");
            return;
          }
          if (state.playbackPending) {
            response.end(
              JSON.stringify({
                pending: { reason: "PENDING_REASON_PROCESSING" },
              }),
            );
            return;
          }
          response.end(
            toJsonString(
              proto.ResolvePlaybackResponseSchema,
              create(proto.ResolvePlaybackResponseSchema, {
                result: {
                  case: "ready",
                  value: {
                    media: {
                      url: `https://media.fixture.test/video-${fileId}?token=fixture-playback-secret`,
                      expiry: { case: "expiryUnknown", value: true },
                    },
                    format: { container: 1, videoCodec: 1, audioCodec: 1 },
                    subtitles: [
                      {
                        id: `english-${fileId}`,
                        language: "eng",
                        format: 1,
                        source: {
                          url: `https://media.fixture.test/subtitles-${fileId}.vtt`,
                          expiry: { case: "expiryUnknown", value: true },
                        },
                      },
                    ],
                  },
                },
              }),
            ),
          );
          return;
        }
        default:
          error(response, 404, "not_found");
      }
    })().catch(() => error(response, 500, "internal"));
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  const address = engine.address();
  assert.ok(address && typeof address !== "string");
  const start = () =>
    startHostedAdapter({
      statusMedia,
      engineBaseUrl: `http://127.0.0.1:${address.port}`,
      webOrigin,
      selectionReuseMs: options.selectionReuseMs,
      selectionPendingMs: options.selectionPendingMs,
    });
  let hosted = await start();
  return {
    calls,
    searches,
    listings,
    ownedLookups,
    state,
    get origin() {
      return hosted.origin;
    },
    base(value = ownerCredential) {
      return `${hosted.origin}/s/${value}`;
    },
    async restart() {
      await hosted.close();
      hosted = await start();
    },
    async close() {
      await hosted.close();
      engine.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        engine.close((cause) => (cause ? reject(cause) : resolve())),
      );
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function releaseSelection(f: Fixture) {
  const response = await fetch(
    `${f.base()}/stream/movie/${encodeURIComponent(target)}.json`,
  );
  assert.equal(response.status, 200);
  const entries = await decode(response, Streams);
  const url = entries.streams[0]?.url;
  assert.ok(url);
  assert.equal(entries.streams[0]?.externalUrl, undefined);
  return url;
}

// Real time bounds each wait, so a missing limit fails instead of stalling.
async function until(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "condition not reached");
    await sleep(5);
  }
}

// Sends the path as written; fetch would resolve its dot segments first.
function rawStatus(origin: string, path: string) {
  const { hostname, port } = new URL(origin);
  return new Promise<number | undefined>((resolve, reject) => {
    get({ hostname, port, path }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
}

test("credential manifest and discovery remain read-only and keep transfer URLs private", async () => {
  const f = await fixture();
  try {
    const manifest = await fetch(`${f.base()}/manifest.json`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get("cache-control"), "no-store");
    assert.equal(manifest.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(f.calls, []);
    const catalogResponse = await fetch(
      `${f.base()}/catalog/movie/discover-movies.json`,
    );
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalogResponse.headers.get("cache-control"), "no-store");
    const catalog = await decode(catalogResponse, Catalog);
    assert.equal(catalog.metas[0]?.id, target);
    const streamResponse = await fetch(
      `${f.base()}/stream/movie/${encodeURIComponent(target)}.json`,
    );
    assert.equal(streamResponse.status, 200);
    const streamText = await streamResponse.text();
    assert.doesNotMatch(streamText, /fixture-release-secret|https:\/\/engine/);
    const stream = Schema.decodeUnknownSync(Streams)(JSON.parse(streamText));
    assert.equal(stream.streams[0]?.externalUrl, undefined);
    assert.equal(
      stream.streams[0]?.url,
      `${f.base()}/play/movie/${encodeURIComponent(target)}/fixture-release.m3u8`,
    );
    assert.equal(f.state.addCount, 0);
    assert.ok(f.calls.every(({ owner }) => owner === "101"));
    assert.equal(
      f.calls.some(({ method }) => method === "GetUserProfile"),
      false,
    );
    assert.equal(
      (await fetch(`${f.base()}/manifest.json`, { method: "POST" })).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("malformed credentials and removed routes never reach Engine", async () => {
  const f = await fixture();
  try {
    for (const path of [
      "/s/not-a-credential/manifest.json",
      "/s/v4.local.short/manifest.json",
      `/s/v4.public.${"a".repeat(64)}/manifest.json`,
      `/s/v4.local.${"a".repeat(1016)}/catalog/movie/library.json`,
      `/s/v4.local.${"a".repeat(64)}.footer.extra/manifest.json`,
      `/s/v4.local.${"a".repeat(64)}.${"b".repeat(87)}/manifest.json`,
      `/i/${"x".repeat(43)}/manifest.json`,
      "/api/installations",
    ])
      assert.equal((await fetch(`${f.origin}${path}`)).status, 404, path);
    assert.equal(
      (await fetch(`${f.base(`v4.local.${"a".repeat(1015)}`)}/manifest.json`))
        .status,
      200,
    );
    assert.equal(
      (
        await fetch(
          `${f.base(`v4.local.${"a".repeat(300)}.eyJraWQiOiJzMSJ9`)}/manifest.json`,
        )
      ).status,
      200,
    );
    const denied = await fetch(
      `${f.base(credential())}/catalog/movie/library.json`,
    );
    assert.equal(denied.status, 200);
    assert.deepEqual(
      (await decode(denied, Catalog)).metas.map(({ id }) => id),
      ["chill:reconnect"],
    );
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});

test("Engine credential rejection shows reconnect rows, sources and notices", async () => {
  const f = await fixture();
  try {
    const url = await releaseSelection(f);
    for (const rejection of [
      { status: 401, code: "unauthenticated" },
      { status: 403, code: "permission_denied" },
    ]) {
      f.state.rejection = rejection;
      for (const [type, catalog] of [
        ["movie", "library"],
        ["movie", "discover-movies"],
        ["series", "discover-series"],
      ] as const) {
        const response = await fetch(
          `${f.base()}/catalog/${type}/${catalog}.json`,
        );
        assert.equal(response.status, 200);
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            metas: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                type: Schema.String,
                description: Schema.String,
              }),
            ),
          }),
        )(await response.json());
        assert.deepEqual(
          body.metas.map(({ id, type }) => ({ id, type })),
          [{ id: "chill:reconnect", type }],
        );
        assert.match(body.metas[0]?.description ?? "", /\/stremio/);
      }
      const reconnectSource = {
        streams: [{ externalUrl: `${webOrigin}/stremio` }],
      };
      for (const id of [
        target,
        "tt1234567",
        "chill:file:50",
        "chill:reconnect",
      ])
        assert.deepEqual(
          await decode(
            await fetch(
              `${f.base()}/stream/movie/${encodeURIComponent(id)}.json`,
            ),
            Streams,
          ),
          reconnectSource,
        );
      const meta = await fetch(`${f.base()}/meta/movie/chill%3Areconnect.json`);
      assert.equal(meta.status, 200);
      assert.match(await meta.text(), /Reconnect chill\.institute/);
      assert.deepEqual(
        await (
          await fetch(`${f.base()}/subtitles/movie/chill%3Afile%3A50.json`)
        ).json(),
        { subtitles: [] },
      );
      const hls = await fetch(url, { redirect: "manual" });
      assert.equal(hls.status, 302);
      assert.equal(
        hls.headers.get("location"),
        `${f.base()}/notice/reconnect.m3u8`,
      );
      const legacy = await fetch(url.replace(/\.m3u8$/, ".mp4"), {
        redirect: "manual",
      });
      assert.equal(legacy.status, 302);
      assert.equal(
        legacy.headers.get("location"),
        `${f.base()}/notice/reconnect.mp4`,
      );
      const status = await fetch(`${f.base()}/status/90.mp4`, {
        redirect: "manual",
      });
      assert.equal(
        status.headers.get("location"),
        `${f.base()}/notice/reconnect.mp4`,
      );
    }
    const clip = await fetch(`${f.base()}/notice/reconnect.mp4`);
    assert.equal(clip.status, 200);
    assert.equal(clip.headers.get("content-type"), "video/mp4");
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("hosted protocol configuration and malformed routes stay within their credential", async () => {
  const f = await fixture();
  try {
    const config = await fetch(`${f.base()}/configure`, { redirect: "manual" });
    assert.equal(config.status, 302);
    assert.equal(config.headers.get("location"), `${webOrigin}/stremio`);
    assert.equal(config.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await fetch(`${f.base()}/meta/movie/%ZZ.json`)).status, 400);
    assert.equal(
      (
        await fetch(
          `${f.base()}/catalog/movie/discover-movies/search=x&search=y.json`,
        )
      ).status,
      400,
    );
    for (const id of [
      "0",
      "abc",
      "-1",
      "01",
      "9223372036854775808",
      "99999999999999999999",
    ])
      assert.equal(
        (await fetch(`${f.base()}/status/${id}.m3u8`, { redirect: "manual" }))
          .status,
        404,
        id,
      );
    for (const path of [
      "/notice/other.mp4",
      "/notice/other.m3u8",
      "/notice/other.ts",
      "/notice/pending.mp4x",
      "/notice/pending.m3u8/x",
      "/notice/pending",
    ])
      assert.equal((await fetch(`${f.base()}${path}`)).status, 404, path);
    assert.equal((await fetch(`${f.base()}/${"x".repeat(4096)}`)).status, 404);
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("a stalled protocol response times out once and the server remains usable", async () => {
  const f = await fixture();
  // Fake only the request deadline timers; sockets stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.state.stallMovies = true;
    const stalled = fetch(`${f.base()}/catalog/movie/discover-movies.json`);
    while (!f.calls.some(({ method }) => method === "GetMovies"))
      await sleep(5);
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await stalled;
    assert.equal(response.status, 504);
    await response.arrayBuffer();
    assert.equal(
      f.calls.filter(({ method }) => method === "GetMovies").length,
      1,
    );
    f.state.stallMovies = false;
    assert.equal(
      (await fetch(`${f.base()}/catalog/movie/discover-movies.json`)).status,
      200,
    );
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("liveness, HEAD and OPTIONS answer while stalled requests fill the process", async () => {
  const f = await fixture();
  const catalog = (link: string) =>
    fetch(`${f.base(link)}/catalog/movie/discover-movies.json`);
  const stalled: Promise<Response>[] = [];
  // Fake only the request deadline timers; sockets stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.state.stallMovies = true;
    for (const link of [ownerCredential, otherCredential, ...spareCredentials])
      for (let i = 0; i < 16; i++) stalled.push(catalog(link));
    await until(
      () =>
        f.calls.filter(({ method }) => method === "GetMovies").length === 64,
    );
    const refused = await catalog(credential());
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("retry-after"), "5");
    assert.equal(refused.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await refused.json(), { error: "unavailable" });
    const health = await fetch(`${f.origin}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const selected = `${f.base()}/play/movie/${encodeURIComponent(target)}/fixture-release.m3u8`;
    const probe = await fetch(selected, { method: "HEAD" });
    assert.equal(probe.status, 200);
    assert.equal(
      probe.headers.get("content-type"),
      "application/vnd.apple.mpegurl",
    );
    assert.equal(
      (await fetch(`${f.base()}/manifest.json`, { method: "OPTIONS" })).status,
      204,
    );
    await vi.advanceTimersByTimeAsync(10_000);
    for (const response of await Promise.all(stalled)) {
      assert.equal(response.status, 504);
      await response.arrayBuffer();
    }
  } finally {
    vi.useRealTimers();
    const settled = Promise.allSettled(stalled);
    await f.close();
    await settled;
  }
});

test("one add-on link holds at most 16 requests while other links and status clips answer", async () => {
  const f = await fixture();
  const catalog = () => fetch(`${f.base()}/catalog/movie/discover-movies.json`);
  const movies = () =>
    f.calls.filter(({ method }) => method === "GetMovies").length;
  const sent: Promise<Response>[] = [];
  const answered: Response[] = [];
  // Fake only the request deadline timers; sockets stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.state.stallMovies = true;
    for (let i = 0; i < 64; i++) {
      const response = catalog();
      sent.push(response);
      response.then(
        (value) => answered.push(value),
        () => undefined,
      );
    }
    await until(() => movies() === 16 && answered.length === 48);
    const refused = [...answered];
    for (const response of refused) {
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "5");
      assert.deepEqual(await response.json(), {
        error: "resource_exhausted",
      });
    }
    assert.equal(
      await rawStatus(
        f.origin,
        `/x/../s/${ownerCredential}/catalog/movie/discover-movies.json`,
      ),
      429,
    );
    const selected = `${f.base()}/play/movie/${encodeURIComponent(target)}/fixture-release.m3u8`;
    const media = await fetch(selected, { redirect: "manual" });
    assert.equal(media.status, 503, "HLS players retry 5xx, never 4xx");
    assert.equal(media.headers.get("retry-after"), "5");
    assert.equal(media.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await media.json(), { error: "unavailable" });
    assert.equal((await fetch(selected, { method: "HEAD" })).status, 200);
    const clip = await fetch(`${f.base()}/notice/pending.m3u8`);
    assert.equal(clip.status, 200);
    await clip.arrayBuffer();
    assert.equal(
      (await fetch(`${f.base(otherCredential)}/catalog/movie/library.json`))
        .status,
      200,
    );
    assert.equal((await fetch(`${f.origin}/health`)).status, 200);
    assert.equal(movies(), 16);
    assert.equal(f.state.addCount, 0);
    await vi.advanceTimersByTimeAsync(10_000);
    const stalled = (await Promise.all(sent)).filter(
      (response) => !refused.includes(response),
    );
    assert.equal(stalled.length, 16);
    for (const response of stalled) {
      assert.equal(response.status, 504);
      await response.arrayBuffer();
    }
    f.state.stallMovies = false;
    assert.equal((await catalog()).status, 200);
  } finally {
    vi.useRealTimers();
    const settled = Promise.allSettled(sent);
    await f.close();
    await settled;
  }
});

test("a selection keeps a unit of its link until its submission settles", async () => {
  const f = await fixture();
  const catalog = () => fetch(`${f.base()}/catalog/movie/discover-movies.json`);
  const manifest = async () => {
    const response = await fetch(`${f.base()}/manifest.json`);
    await response.arrayBuffer();
    return response.status;
  };
  // The link admits its manifest only while it holds fewer than 16 units.
  const admitted = async (message: string) => {
    const deadline = Date.now() + 2_000;
    while ((await manifest()) !== 200) {
      assert.ok(Date.now() < deadline, message);
      await sleep(5);
    }
  };
  const movies = () =>
    f.calls.filter(({ method }) => method === "GetMovies").length;
  const stalled: Promise<Response>[] = [];
  try {
    const url = await releaseSelection(f);
    // Fake request deadlines and Engine latency; sockets stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.state.engineDelayMs = 6_000;
    const client = new AbortController();
    const abandoned = fetch(url, {
      redirect: "manual",
      signal: client.signal,
    }).catch(() => undefined);
    await until(() => f.state.heldCalls === 1);
    await vi.advanceTimersByTimeAsync(6_000);
    await until(() => f.state.heldCalls === 2);
    assert.equal(f.state.addCount, 1, "AddTransfer is answering");
    client.abort();
    await abandoned;
    f.state.stallMovies = true;
    const before = movies();
    for (let i = 0; i < 14; i++) stalled.push(catalog());
    await until(() => movies() === before + 14);
    await admitted("the disconnected request kept its unit");
    stalled.push(catalog());
    await until(() => movies() === before + 15);
    assert.equal(await manifest(), 429, "the submission holds the 16th unit");
    await vi.advanceTimersByTimeAsync(6_000);
    await admitted("the settled submission kept its unit");
    const searches = f.searches.length;
    const another = await fetch(url.replace("fixture-release", "other"), {
      redirect: "manual",
    });
    assert.equal(another.status, 503, "a new selection needs two free units");
    assert.equal(another.headers.get("retry-after"), "5");
    assert.deepEqual(await another.json(), { error: "unavailable" });
    assert.equal(f.searches.length, searches);
    assert.equal(f.state.addCount, 1);
    await vi.advanceTimersByTimeAsync(10_000);
    for (const response of await Promise.all(stalled)) {
      assert.equal(response.status, 504);
      await response.arrayBuffer();
    }
  } finally {
    vi.useRealTimers();
    const settled = Promise.allSettled(stalled);
    await f.close();
    await settled;
  }
});

test("Stremio media selection waits for its download and plays without reselection", async () => {
  const f = await fixture();
  try {
    f.state.transferFinished = false;
    f.state.singleFile = true;
    const url = await releaseSelection(f);
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(
      head.headers.get("content-type"),
      "application/vnd.apple.mpegurl",
    );
    assert.equal((await fetch(url, { method: "OPTIONS" })).status, 204);
    assert.equal(
      (await fetch(url, { headers: { purpose: "prefetch" } })).status,
      204,
    );
    assert.equal(
      (await fetch(url, { headers: { "sec-purpose": "prefetch" } })).status,
      204,
    );
    assert.equal(f.state.addCount, 0);
    let responded = false;
    const selected = fetch(url, { redirect: "manual" }).then((response) => {
      responded = true;
      return response;
    });
    const submittedDeadline = Date.now() + 2000;
    while (f.state.addCount === 0 && Date.now() < submittedDeadline)
      await sleep(10);
    assert.equal(f.state.addCount, 1);
    const repeated = fetch(url, { redirect: "manual" });
    await sleep(200);
    assert.equal(
      f.state.addCount,
      1,
      "Concurrent selections share one submission",
    );
    assert.equal(responded, false);
    f.state.playbackPending = true;
    f.state.transferFinished = true;
    await sleep(100);
    assert.equal(responded, false);
    f.state.playbackPending = false;
    for (const ready of await Promise.all([selected, repeated])) {
      assert.equal(ready.status, 302);
      assert.equal(
        ready.headers.get("location"),
        "https://media.fixture.test/video-21?token=fixture-playback-secret",
      );
    }
    assert.equal(f.state.addCount, 1);
    const reopened = await fetch(url, { redirect: "manual" });
    assert.equal(reopened.status, 302);
    assert.equal(
      f.state.addCount,
      1,
      "A reopened selection reuses its submission",
    );
    await f.restart();
    for (const extension of ["m3u8", "mp4"]) {
      const resumed = await fetch(`${f.base()}/status/90.${extension}?wait=3`, {
        redirect: "manual",
      });
      assert.equal(resumed.status, 302);
      assert.equal(
        resumed.headers.get("location"),
        "https://media.fixture.test/video-21?token=fixture-playback-secret",
      );
    }
    assert.equal(f.state.addCount, 1, "Status reads never submit");
    assert.equal(
      (
        await fetch(`${f.origin}${new URL(url).pathname}`, {
          redirect: "manual",
        })
      ).status,
      302,
    );
    assert.equal(
      f.state.addCount,
      2,
      "Selecting again after a restart submits again",
    );
    const foreign = await fetch(`${f.base(otherCredential)}/status/91.m3u8`, {
      redirect: "manual",
    });
    assert.equal(foreign.status, 404);
  } finally {
    await f.close();
  }
});

test("a slow submission still redirects its pending download before the request deadline", async () => {
  const f = await fixture();
  try {
    f.state.transferFinished = false;
    const url = await releaseSelection(f);
    // Fake request deadlines and Engine latency; sockets stay real.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    f.state.engineDelayMs = 6_000;
    let responded = false;
    const selected = fetch(url, { redirect: "manual" }).then((response) => {
      responded = true;
      return response;
    });
    // Search, AddTransfer and each GetTransfer take one step; the 25-second
    // HLS window ends during the fifth, the response deadline during the sixth.
    for (let step = 1; ; step++) {
      while (f.state.heldCalls < step && !responded) await sleep(5);
      if (responded) break;
      await vi.advanceTimersByTimeAsync(6_000);
    }
    const response = await selected;
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      `${f.base()}/status/90.m3u8?wait=1`,
    );
    assert.equal(f.state.addCount, 1);
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("invalid playback continuations never start a download", async () => {
  const f = await fixture();
  try {
    const url = await releaseSelection(f);
    for (const query of ["wait=6", "wait=-1", "wait=0&wait=1", "other=1"]) {
      assert.equal(
        (await fetch(`${url}?${query}`, { redirect: "manual" })).status,
        400,
      );
    }
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("a release missing after an indexer failure is unavailable, not gone", async () => {
  const f = await fixture();
  try {
    const url = (await releaseSelection(f)).replace(/\.m3u8$/, ".mp4");
    f.state.releaseMissing = true;
    const gone = await fetch(url, { redirect: "manual" });
    assert.equal(gone.status, 404);
    assert.deepEqual(await gone.json(), { error: "not_found" });
    f.state.indexerError = "request timed out";
    const incomplete = await fetch(url, { redirect: "manual" });
    assert.equal(incomplete.status, 503);
    assert.deepEqual(await incomplete.json(), { error: "unavailable" });
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("multi-file Stremio selection requires choosing a file and never guesses the first video", async () => {
  const f = await fixture();
  try {
    const url = await releaseSelection(f);
    const selected = await fetch(url, { redirect: "manual" });
    assert.equal(selected.status, 302);
    assert.equal(
      selected.headers.get("location"),
      `${f.base()}/notice/select-file.m3u8`,
    );
    const legacy = await fetch(`${f.base()}/status/90.mp4`, {
      redirect: "manual",
    });
    assert.equal(legacy.status, 302);
    assert.equal(
      legacy.headers.get("location"),
      `${f.base()}/notice/select-file.mp4`,
    );
    assert.equal(f.state.addCount, 1);
    assert.equal(
      f.calls.some(({ method }) => method === "ResolvePlayback"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("a multi-file download plays its one video that is not a sample", async () => {
  const f = await fixture();
  const status = async () =>
    (
      await fetch(`${f.base()}/status/90.m3u8`, { redirect: "manual" })
    ).headers.get("location");
  const feature = { id: 21n, name: "Independent.Film.mkv", fileType: "VIDEO" };
  const played =
    "https://media.fixture.test/video-21?token=fixture-playback-secret";
  try {
    f.state.folders.set(20n, [
      feature,
      { id: 30n, name: "Sample", fileType: "FOLDER" },
    ]);
    f.state.folders.set(30n, [{ id: 31n, name: "x.mkv", fileType: "VIDEO" }]);
    assert.equal(await status(), played, "a video in a sample folder");
    f.state.folders.set(20n, [
      feature,
      { id: 30n, name: "Sample Extras", fileType: "FOLDER" },
    ]);
    assert.equal(
      await status(),
      `${f.base()}/notice/select-file.m3u8`,
      "a folder named with more than the sample word",
    );
    f.state.folders.set(20n, [
      feature,
      { id: 31n, name: "x_sample.mkv", fileType: "VIDEO" },
    ]);
    assert.equal(await status(), played, "a video named as a sample");
    f.state.folders.set(20n, [
      feature,
      { id: 31n, name: "The.Sample.S01E05.mkv", fileType: "VIDEO" },
    ]);
    assert.equal(
      await status(),
      `${f.base()}/notice/select-file.m3u8`,
      "a sample word inside a video's name",
    );
    f.state.folders.set(10n, [{ id: 20n, name: "Sample", fileType: "FOLDER" }]);
    f.state.folders.set(20n, [
      feature,
      { id: 30n, name: "Samples", fileType: "FOLDER" },
    ]);
    f.state.folders.set(30n, [{ id: 32n, name: "Extras", fileType: "FOLDER" }]);
    f.state.folders.set(32n, [{ id: 31n, name: "x.mkv", fileType: "VIDEO" }]);
    assert.equal(
      await status(),
      played,
      "a video deeper in a sample folder of a download named Sample",
    );
  } finally {
    await f.close();
  }
});

test("a download with too many folders to list asks for a file choice", async () => {
  const f = await fixture();
  try {
    const extras = Array.from({ length: 33 }, (_, i) => ({
      id: BigInt(100 + i),
      name: `Extra ${i + 1}`,
      fileType: "FOLDER",
    }));
    f.state.folders.set(20n, [
      { id: 21n, name: "Independent.Film.mkv", fileType: "VIDEO" },
      ...extras,
    ]);
    for (const extra of extras) f.state.folders.set(extra.id, []);
    const response = await fetch(`${f.base()}/status/90.m3u8`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      `${f.base()}/notice/select-file.m3u8`,
    );
  } finally {
    await f.close();
  }
});

test("a download too slow to list asks for a file choice", async () => {
  const f = await fixture();
  // Fake the listing limit and Engine latency; sockets stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.state.engineDelayMs = 6_000;
    f.state.singleFile = true;
    let responded = false;
    const selected = fetch(`${f.base()}/status/90.m3u8`, {
      redirect: "manual",
    }).then((response) => {
      responded = true;
      return response;
    });
    // GetTransfer and each GetFolder take one step; the ten-second listing
    // limit ends during the second GetFolder.
    for (let step = 1; ; step++) {
      while (f.state.heldCalls < step && !responded) await sleep(5);
      if (responded) break;
      await vi.advanceTimersByTimeAsync(6_000);
    }
    const response = await selected;
    assert.equal(response.status, 302);
    assert.equal(
      response.headers.get("location"),
      `${f.base()}/notice/select-file.m3u8`,
    );
    assert.equal(
      f.calls.filter(({ method }) => method === "GetFolder").length,
      2,
    );
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("a lost submission response is reported as unknown and never retried", async () => {
  const f = await fixture();
  try {
    const url = await releaseSelection(f);
    f.state.loseTransferResponse = true;
    const first = await fetch(url, { redirect: "manual" });
    assert.equal(first.status, 302);
    assert.equal(
      first.headers.get("location"),
      `${f.base()}/notice/unknown.m3u8`,
    );
    assert.equal(f.state.addCount, 1);
    const legacy = await fetch(url.replace(/\.m3u8$/, ".mp4"), {
      redirect: "manual",
    });
    assert.equal(
      legacy.headers.get("location"),
      `${f.base()}/notice/unknown.mp4`,
    );
    assert.equal(f.state.addCount, 1, "A reopened selection is not retried");
    assert.equal(
      f.calls.filter(({ method }) => method === "GetTransfer").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("Engine refusals that leave no transfer play the clip that explains them", async () => {
  const cases = [
    {
      status: 400,
      code: "failed_precondition",
      engineCode: "stremio_folder_missing",
      clip: "reconnect",
    },
    {
      status: 429,
      code: "resource_exhausted",
      engineCode: "putio_rate_limited",
      clip: "release-unavailable",
    },
    {
      status: 400,
      code: "invalid_argument",
      engineCode: "invalid_transfer_url",
      clip: "release-unavailable",
    },
    // put.io may refuse a release the account already holds.
    {
      status: 400,
      code: "failed_precondition",
      engineCode: "putio_rejected",
      clip: "unknown",
    },
    {
      status: 400,
      code: "failed_precondition",
      engineCode: "unlisted_code",
      clip: "unknown",
    },
  ];
  for (const { engineCode, clip, ...rejection } of cases)
    for (const sent of [engineCode, undefined]) {
      // A fresh server, since identical selections share one submission.
      const f = await fixture();
      try {
        f.state.addRejection = { ...rejection, engineCode: sent };
        const url = await releaseSelection(f);
        const expected = sent ? clip : "unknown";
        for (const extension of ["m3u8", "mp4"]) {
          const selected = await fetch(
            url.replace(/\.m3u8$/, `.${extension}`),
            { redirect: "manual" },
          );
          assert.equal(selected.status, 302);
          assert.equal(
            selected.headers.get("location"),
            `${f.base()}/notice/${expected}.${extension}`,
            `${rejection.code} with ${sent ?? "no code"}`,
          );
        }
        assert.equal(f.state.addCount, 1, "A refusal is never retried");
      } finally {
        await f.close();
      }
    }
});

test("an HLS selection outlasting its window continues at its URL with one submission", async () => {
  const f = await fixture();
  // Fake request windows, Engine latency and the wall clock Engine deadlines
  // read; sockets stay real.
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
  // Real time bounds each wait; the faked `Date` cannot.
  const reached = async (condition: () => boolean) => {
    for (let tries = 0; !condition(); tries++) {
      assert.ok(tries < 400, "condition not reached");
      await sleep(5);
    }
  };
  try {
    f.state.transferFinished = false;
    // Finding the movie and its release take most of the 25-second HLS
    // window; Engine's shared add takes 15 seconds more.
    f.state.delayMs = { GetMovies: 9_000, Search: 9_000, AddTransfer: 15_000 };
    const url = `${f.base()}/play/movie/tt1234567/fixture-release.m3u8`;
    const first = fetch(url, { redirect: "manual" });
    for (const [calls, ms] of [
      [1, 9_000],
      [2, 9_000],
      [3, 7_000],
    ] as const) {
      await reached(() => f.state.heldCalls === calls);
      await vi.advanceTimersByTimeAsync(ms);
    }
    const continued = await first;
    assert.equal(continued.status, 302);
    assert.equal(continued.headers.get("location"), `${url}?wait=1`);
    let responded = false;
    const second = fetch(`${url}?wait=1`, { redirect: "manual" }).then(
      (response) => {
        responded = true;
        return response;
      },
    );
    await sleep(100);
    const reads = () =>
      f.calls.filter(({ method }) => method === "GetTransfer").length;
    assert.equal(reads(), 0, "The add is still in flight");
    // The add answers eight seconds in; the download is still pending when
    // the second window ends.
    for (let elapsed = 0; !responded; elapsed += 1_000) {
      assert.ok(elapsed < 30_000, "the continuation never answered");
      await vi.advanceTimersByTimeAsync(1_000);
      await sleep(5);
    }
    const pending = await second;
    assert.equal(pending.status, 302);
    assert.equal(
      pending.headers.get("location"),
      `${f.base()}/status/90.m3u8?wait=2`,
    );
    assert.ok(reads() > 0);
    assert.equal(f.state.addCount, 1, "The continuation rejoins the add");
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("capacity pressure keeps a running submission for its continuation", async () => {
  const f = await fixture();
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "Date", "performance"],
  });
  const reached = async (condition: () => boolean) => {
    for (let tries = 0; !condition(); tries++) {
      assert.ok(tries < 400, "condition not reached");
      await sleep(5);
    }
  };
  const adds = () =>
    f.calls.filter(({ method }) => method === "AddTransfer").length;
  try {
    f.state.transferFinished = false;
    f.state.extraReleases = 256;
    f.state.delayMs = { GetMovies: 9_000, Search: 9_000, AddTransfer: 15_000 };
    const url = `${f.base()}/play/movie/tt1234567/fixture-release.m3u8`;
    const first = fetch(url, { redirect: "manual" });
    for (const [calls, ms] of [
      [1, 9_000],
      [2, 9_000],
      [3, 7_000],
    ] as const) {
      await reached(() => f.state.heldCalls === calls);
      await vi.advanceTimersByTimeAsync(ms);
    }
    const continued = await first;
    assert.equal(continued.headers.get("location"), `${url}?wait=1`);
    // Other selections fill the shared-submission memory while the add runs.
    f.state.delayMs = {};
    f.state.transferFinished = true;
    for (let n = 0; n < 256; n++)
      await (
        await fetch(
          `${f.base()}/play/movie/tt1234567/fixture-release-${n}.m3u8`,
          { redirect: "manual" },
        )
      ).arrayBuffer();
    const added = adds();
    let responded = false;
    const second = fetch(`${url}?wait=1`, { redirect: "manual" }).then(
      (response) => {
        responded = true;
        return response;
      },
    );
    for (let elapsed = 0; !responded; elapsed += 1_000) {
      assert.ok(elapsed < 30_000, "the continuation never answered");
      await vi.advanceTimersByTimeAsync(1_000);
      await sleep(5);
    }
    await (await second).arrayBuffer();
    assert.equal(adds(), added, "The continuation rejoins the add");
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("status clips play from their credential path without reaching Engine", async () => {
  const f = await fixture();
  try {
    for (const kind of statusMediaKinds) {
      const playlist = await fetch(`${f.base()}/notice/${kind}.m3u8`);
      assert.equal(playlist.status, 200);
      assert.equal(
        playlist.headers.get("content-type"),
        "application/vnd.apple.mpegurl",
      );
      assert.equal(playlist.headers.get("cache-control"), "no-store");
      assert.equal(playlist.headers.get("referrer-policy"), "no-referrer");
      assert.equal(playlist.headers.get("access-control-allow-origin"), "*");
      assert.equal(await playlist.text(), statusPlaylist(kind));
      const segment = await fetch(`${f.base(credential())}/notice/${kind}.ts`);
      assert.equal(segment.status, 200);
      assert.equal(segment.headers.get("content-type"), "video/mp2t");
      assert.deepEqual(Buffer.from(await segment.arrayBuffer()), statusSegment);
    }
    const head = await fetch(`${f.base()}/notice/failed.ts`, {
      method: "HEAD",
    });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const range = await fetch(`${f.base()}/notice/failed.ts`, {
      headers: { Range: "bytes=188-" },
    });
    assert.equal(range.status, 206);
    assert.deepEqual(
      Buffer.from(await range.arrayBuffer()),
      statusSegment.subarray(188),
    );
    assert.equal(
      (await fetch(`${f.origin}/s/v4.local.short/notice/failed.m3u8`)).status,
      404,
    );
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});

test("a long-pending HLS selection shows the pending clip and waits again when reselected", async () => {
  const f = await fixture({ selectionPendingMs: 40_000 });
  // Fake request windows and the pending clock; sockets stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    f.state.transferFinished = false;
    f.state.singleFile = true;
    const url = await releaseSelection(f);
    const reads = () =>
      f.calls.filter(({ method }) => method === "GetTransfer").length;
    const wait = async (target: string, windowMs: number) => {
      const before = reads();
      const response = fetch(target, { redirect: "manual" });
      while (reads() <= before) await sleep(5);
      await vi.advanceTimersByTimeAsync(windowMs);
      return (await response).headers.get("location");
    };
    const continued = `${f.base()}/status/90.m3u8?wait=1`;
    const clip = `${f.base()}/notice/pending.m3u8`;
    assert.equal(await wait(url, 25_000), continued);
    assert.equal(
      await wait(url, 25_000),
      clip,
      "The client's retry of the selected URL reaches the pending limit",
    );
    assert.equal(
      await wait(url, 25_000),
      continued,
      "Reselecting after the clip waits again",
    );
    assert.equal(await wait(`${f.base()}/status/90.m3u8?wait=5`, 25_000), clip);
    const legacy = url.replace(/\.m3u8$/, ".mp4");
    assert.equal(
      await wait(legacy, 45_000),
      `${f.base()}/status/90.mp4?wait=1`,
    );
    const before = reads();
    const exhausted = fetch(`${f.base()}/status/90.mp4?wait=5`, {
      redirect: "manual",
    });
    while (reads() <= before) await sleep(5);
    await vi.advanceTimersByTimeAsync(45_000);
    const limit = await exhausted;
    assert.equal(limit.status, 503);
    assert.equal(limit.headers.get("retry-after"), "5");
    assert.deepEqual(await limit.json(), { error: "download_pending" });
    f.state.transferFinished = true;
    const ready = await fetch(url, { redirect: "manual" });
    assert.equal(
      ready.headers.get("location"),
      "https://media.fixture.test/video-21?token=fixture-playback-secret",
    );
    assert.equal(f.state.addCount, 1, "Waiting never resubmits");
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("HLS selections Search no longer resolves show the release clip without submitting", async () => {
  const f = await fixture();
  try {
    const url = await releaseSelection(f);
    const clip = `${f.base()}/notice/release-unavailable.m3u8`;
    f.state.releaseMissing = true;
    for (const indexerError of ["", "request timed out"]) {
      f.state.indexerError = indexerError;
      const selected = await fetch(url, { redirect: "manual" });
      assert.equal(selected.status, 302);
      assert.equal(selected.headers.get("location"), clip);
    }
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("a disconnected first client does not duplicate a shared submission", async () => {
  const f = await fixture();
  try {
    f.state.singleFile = true;
    f.state.addDelayMs = 500;
    const url = await releaseSelection(f);
    const first = new AbortController();
    const abandoned = fetch(url, {
      redirect: "manual",
      signal: first.signal,
    }).catch(() => undefined);
    await sleep(150);
    first.abort();
    await abandoned;
    await sleep(700);
    const reopened = await fetch(url, { redirect: "manual" });
    assert.equal(reopened.status, 302);
    assert.equal(f.state.addCount, 1);
  } finally {
    await f.close();
  }
});

test("identical selections under different credentials submit separately", async () => {
  const f = await fixture();
  try {
    f.state.singleFile = true;
    const url = await releaseSelection(f);
    const path = new URL(url).pathname.replace(/^\/s\/[^/]+/, "");
    for (const value of [ownerCredential, otherCredential])
      assert.equal(
        (await fetch(`${f.base(value)}${path}`, { redirect: "manual" })).status,
        302,
      );
    assert.equal(f.state.addCount, 2);
    assert.deepEqual(f.state.addCredentials, [
      ownerCredential,
      otherCredential,
    ]);
  } finally {
    await f.close();
  }
});

test("the library lists nested videos from the account root without downloads", async () => {
  const f = await fixture();
  try {
    const library = () => fetch(`${f.base()}/catalog/movie/library.json`);
    const catalog = await decode(await library(), Catalog);
    assert.deepEqual(
      catalog.metas.map((file) => file.name),
      ["Existing video"],
    );
    await f.restart();
    assert.deepEqual(await decode(await library(), Catalog), catalog);
    const streams = await decode(
      await fetch(`${f.base()}/stream/movie/chill%3Afile%3A50.json`),
      Streams,
    );
    assert.match(streams.streams[0]?.url ?? "", /video-50/);
    for (const removed of ["downloads", "acquired"])
      assert.notEqual(
        (await fetch(`${f.base()}/catalog/movie/${removed}.json`)).status,
        200,
      );
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("public catalog entry requires configuration and never accesses an account", async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.origin}/manifest.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const Manifest = Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      description: Schema.String,
      logo: Schema.optional(Schema.String),
      contactEmail: Schema.optional(Schema.String),
      catalogs: Schema.Array(Schema.Struct({ id: Schema.String })),
      behaviorHints: Schema.Struct({
        configurable: Schema.Boolean,
        configurationRequired: Schema.Boolean,
      }),
    });
    const listing = {
      logo: `${f.origin}/configure-assets/logo.png`,
      contactEmail: "chillardinho@chill.institute",
    };
    const supportedClients = (copy: string) => {
      assert.match(copy, /Tested in Stremio Web and Stremio for Linux[.;]/);
      assert.doesNotMatch(copy, /early access|work in progress/i);
    };
    const publicManifest = await decode(response, Manifest);
    assert.equal(publicManifest.name, "chill.institute");
    assert.equal(publicManifest.logo, listing.logo);
    assert.equal(publicManifest.contactEmail, listing.contactEmail);
    supportedClients(publicManifest.description);
    assert.deepEqual(publicManifest.behaviorHints, {
      configurable: true,
      configurationRequired: true,
    });
    assert.deepEqual(
      publicManifest.catalogs.map(({ id }) => id),
      ["discover-releases", "library", "discover-movies", "discover-series"],
    );
    const redirected = await fetch(`${f.origin}/`, { redirect: "manual" });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get("location"), `${webOrigin}/stremio`);
    assert.equal(redirected.headers.get("referrer-policy"), "no-referrer");
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const setup = await fetch(`${f.origin}/configure`, {
        method,
        redirect: "manual",
      });
      assert.equal(setup.status, method === "OPTIONS" ? 204 : 200);
      assert.equal(setup.headers.get("location"), null);
      assert.equal(setup.headers.get("referrer-policy"), "no-referrer");
      if (method === "GET") {
        assert.match(setup.headers.get("content-type") ?? "", /^text\/html/);
        const html = await setup.text();
        assert.ok(
          [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)].some(
            ([, href]) => href === `${webOrigin}/stremio`,
          ),
        );
        const stylesheet = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
        assert.ok(stylesheet);
        const hash = createHash("sha256").update(stylesheet).digest("base64");
        assert.equal(
          setup.headers.get("content-security-policy"),
          `default-src 'none'; style-src 'sha256-${hash}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
        assert.doesNotMatch(html, /<script\b|<link\b|<iframe\b/i);
        supportedClients(html);
      } else assert.equal(await setup.text(), "");
    }
    assert.equal(
      (await fetch(`${f.origin}/manifest.json`, { method: "OPTIONS" })).status,
      204,
    );
    for (const [name, contentType] of [["logo.png", "image/png"]]) {
      const assetUrl = `${f.origin}/configure-assets/${name}`;
      const asset = await fetch(assetUrl);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get("content-type"), contentType);
      assert.ok((await asset.arrayBuffer()).byteLength > 0);
      const assetHead = await fetch(assetUrl, { method: "HEAD" });
      assert.equal(assetHead.status, 200);
      assert.equal(await assetHead.text(), "");
      assert.equal((await fetch(assetUrl, { method: "POST" })).status, 404);
    }
    assert.equal(
      (await fetch(`${f.origin}/configure-assets/missing.woff2`)).status,
      404,
    );
    const head = await fetch(`${f.origin}/manifest.json`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    for (const path of [
      "/catalog/movie/library.json",
      "/stream/movie/chill:file:50.json",
    ]) {
      assert.notEqual((await fetch(`${f.origin}${path}`)).status, 200);
    }
    assert.deepEqual(f.calls, []);
    const personal = await decode(
      await fetch(`${f.base()}/manifest.json`),
      Manifest,
    );
    assert.equal(personal.id, publicManifest.id);
    assert.equal(personal.logo, listing.logo);
    assert.equal(personal.contactEmail, listing.contactEmail);
    supportedClients(personal.description);
    assert.equal(personal.behaviorHints.configurationRequired, false);
    assert.deepEqual(personal.catalogs, publicManifest.catalogs);
  } finally {
    await f.close();
  }
});

test("ordinary Stremio movie and episode cards offer read-only chill release search", async () => {
  const f = await fixture();
  try {
    const manifest: unknown = await (
      await fetch(`${f.base()}/manifest.json`)
    ).json();
    const isSupported: (
      manifest: unknown,
      resource: string,
      type: string,
      id: string,
    ) => boolean = createRequire(import.meta.url)(
      "stremio-addon-client/lib/util/isSupported.js",
    );
    assert.equal(isSupported(manifest, "stream", "movie", "tt1234567"), true);
    assert.equal(
      isSupported(manifest, "stream", "series", "tt7654321:1:2"),
      true,
    );
    assert.equal(isSupported(manifest, "meta", "movie", "tt1234567"), false);
    assert.equal(isSupported(manifest, "meta", "series", "tt7654321"), false);
    assert.equal(
      isSupported(manifest, "subtitles", "movie", "chill:file:50"),
      true,
    );
    assert.equal(
      isSupported(manifest, "subtitles", "movie", "tt1234567"),
      false,
    );
    for (const input of [
      { type: "movie", id: "tt1234567", canonical: target },
      {
        type: "series",
        id: "tt7654321:1:2",
        canonical: "chill:episode:tt7654321:1:2",
      },
    ]) {
      const response = await fetch(
        `${f.base()}/stream/${input.type}/${encodeURIComponent(input.id)}.json`,
      );
      assert.equal(response.status, 200);
      const stream = await decode(response, Streams);
      assert.equal(stream.streams.length, 1);
      assert.equal(
        stream.streams[0]?.url,
        `${f.base()}/play/${input.type}/${encodeURIComponent(input.canonical)}/fixture-release.m3u8`,
      );
    }
    assert.deepEqual(f.searches, [
      "Independent film 2024",
      "Independent series S01E02",
    ]);
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("a stream listing for a catalog IMDb movie reads the movie catalog once", async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.base()}/stream/movie/tt1234567.json`);
    assert.equal(response.status, 200);
    assert.equal((await decode(response, Streams)).streams.length, 1);
    assert.deepEqual(f.calls.map(({ method }) => method).toSorted(), [
      "FindOwnedVideos",
      "GetMovies",
      "Search",
    ]);
  } finally {
    await f.close();
  }
});

test("release searches tell Engine the time left before their route's deadline", async () => {
  const f = await fixture();
  // Freeze the wall clock so Engine time is exact; sockets and timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const searchTimeout = async (path: string, slowMethod: string) => {
      f.calls.length = 0;
      f.state.elapsedMs = { [slowMethod]: 1_000 };
      await (
        await fetch(`${f.base()}${path}`, { redirect: "manual" })
      ).arrayBuffer();
      return f.calls.find(({ method }) => method === "Search")?.timeout;
    };
    // A listing searches within the request's ten seconds.
    assert.equal(
      await searchTimeout("/stream/movie/tt1234567.json", "GetMovies"),
      "8500",
    );
    // A selection searches within its own budget, not the request's ...
    assert.equal(
      await searchTimeout(
        "/play/movie/tt1234567/fixture-release.m3u8",
        "GetMovies",
      ),
      "9500",
    );
    // ... and within the ten seconds allowed for finding its release.
    assert.equal(
      await searchTimeout(
        `/play/series/${encodeURIComponent("chill:episode:tt7654321:1:2")}/fixture-release.m3u8`,
        "GetTVShowDetail",
      ),
      "8500",
    );
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("selections always wait for Engine's shared add", async () => {
  // Freeze the wall clock so Engine time is exact; sockets and timers stay real.
  vi.useFakeTimers({ toFake: ["Date"] });
  // Each selection gets its own server, since identical selections share one submission.
  const addTimeout = async (
    path: string,
    elapsedMs: Partial<Record<string, number>>,
  ) => {
    const f = await fixture();
    try {
      f.state.elapsedMs = elapsedMs;
      await (
        await fetch(`${f.base()}${path}`, { redirect: "manual" })
      ).arrayBuffer();
      return f.calls.find(({ method }) => method === "AddTransfer")?.timeout;
    } finally {
      await f.close();
    }
  };
  try {
    // Engine keeps a shared add running for 20 seconds after its caller leaves.
    assert.equal(
      await addTimeout("/play/movie/tt1234567/fixture-release.mp4", {}),
      "21000",
    );
    // Nor does an HLS selection's 25-second window cut it short after finding
    // the movie and its release take nearly their whole budgets.
    assert.equal(
      await addTimeout("/play/movie/tt1234567/fixture-release.m3u8", {
        GetMovies: 9_900,
        Search: 9_900,
      }),
      "21000",
    );
  } finally {
    vi.useRealTimers();
  }
});

test("library subtitle resources return the file's tracks without starting downloads", async () => {
  const f = await fixture();
  try {
    const response = await fetch(
      `${f.base()}/subtitles/movie/chill%3Afile%3A50.json`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      subtitles: [
        {
          id: "english-50",
          lang: "eng",
          url: "https://media.fixture.test/subtitles-50.vtt",
        },
      ],
    });
    assert.deepEqual(
      await (
        await fetch(
          `${f.base()}/subtitles/movie/tt1234567/${new URLSearchParams({ filename: "fixture-release.m3u8" })}.json`,
        )
      ).json(),
      { subtitles: [] },
    );
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("credential redaction removes every issued credential from text", () => {
  const text = `GET /s/${ownerCredential}/manifest.json and ${otherCredential}`;
  const redacted = redactCredentials(text);
  assert.equal(redacted, "GET /s/[credential]/manifest.json and [credential]");
  assert.doesNotMatch(redacted, /v4\.local\./);
});

test("a finished selection is reused only within its window", async () => {
  const f = await fixture({ selectionReuseMs: 200 });
  try {
    const url = await releaseSelection(f);
    f.state.loseTransferResponse = true;
    const select = async () => {
      const response = await fetch(url, { redirect: "manual" });
      assert.equal(
        response.headers.get("location"),
        `${f.base()}/notice/unknown.m3u8`,
      );
    };
    await select();
    await select();
    assert.equal(f.state.addCount, 1);
    await sleep(400);
    await select();
    assert.equal(f.state.addCount, 2);
  } finally {
    await f.close();
  }
});

const Rows = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      title: Schema.String,
      url: Schema.String,
    }),
  ),
});
const seasonPack = {
  id: "fixture-season-pack",
  resolution: "1080p",
  codec: "x264",
  quality: "WEB",
};
const packEpisodes = [
  {
    id: 21n,
    name: "Season file one.mkv",
    fileType: "VIDEO",
    releaseInfo: { season: 1, episode: 1 },
  },
  {
    id: 22n,
    name: "Season file two.mkv",
    fileType: "VIDEO",
    releaseInfo: { season: 1, episode: 2 },
  },
];
const episodeRows = async (f: Fixture) => {
  const response = await fetch(
    `${f.base()}/stream/series/${encodeURIComponent("tt7654321:1:2")}.json`,
  );
  assert.equal(response.status, 200);
  return (await decode(response, Rows)).streams;
};
const packSelection = (f: Fixture, id = seasonPack.id) =>
  `${f.base()}/play/series/${encodeURIComponent(episodeTarget)}/${encodeURIComponent(`pack:${id}`)}.m3u8`;
const location = async (url: string) =>
  (await fetch(url, { redirect: "manual" })).headers.get("location");

test("an episode lists Engine's season pack after its releases", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    assert.deepEqual(await episodeRows(f), [
      {
        name: "Download to put.io",
        title: "Independent.Film.1080p\nFixture · 3 seeders · 12.06 KiB",
        url: `${f.base()}/play/series/${encodeURIComponent(episodeTarget)}/fixture-release.m3u8`,
      },
      {
        name: "Download season to put.io",
        title: "Season 1 pack · 1080p x264 WEB\nFixture · 5 seeders · 2.00 GiB",
        url: packSelection(f),
      },
    ]);
    f.state.seasonPack = {
      ...seasonPack,
      resolution: "",
      codec: "",
      quality: "",
    };
    assert.equal(
      (await episodeRows(f))[1]?.title,
      "Season 1 pack\nFixture · 5 seeders · 2.00 GiB",
    );
    f.state.seasonPack = { ...seasonPack, id: "fixture-release" };
    assert.deepEqual(
      (await episodeRows(f)).map(({ name }) => name),
      ["Download to put.io"],
      "A pack Search already lists appears once",
    );
    f.state.seasonPack = seasonPack;
    f.state.extraReleases = 100;
    const capped = await episodeRows(f);
    assert.equal(capped.length, 101, "100 episode releases and the pack");
    assert.equal(capped.at(-1)?.name, "Download season to put.io");
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("an episode leaves out releases parsed as other episodes, which its play URLs still select", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    f.state.parsedReleases = [
      { id: "other-season", releaseInfo: { season: 9, episode: 2 } },
      { id: "other-episode", releaseInfo: { season: 1, episode: 3 } },
      {
        id: "episode-range",
        releaseInfo: { season: 1, episode: 1, episodeEnd: 3 },
      },
      { id: "season-pack-release", releaseInfo: { season: 1 } },
    ];
    const play = (id: string) =>
      `${f.base()}/play/series/${encodeURIComponent(episodeTarget)}/${id}.m3u8`;
    assert.deepEqual(
      (await episodeRows(f)).map(({ name, url }) => [name, url]),
      [
        ["Download to put.io", play("fixture-release")],
        ["Download to put.io", play("episode-range")],
        ["Download to put.io", play("season-pack-release")],
        ["Download season to put.io", packSelection(f)],
      ],
    );
    assert.equal(f.state.addCount, 0);
    assert.equal(
      await location(play("other-season")),
      `${f.base()}/notice/select-file.m3u8`,
      "The multi-file download was submitted",
    );
    assert.deepEqual(f.state.addUrls, [parsedReleaseLink("other-season")]);
  } finally {
    await f.close();
  }
});

test("a season lookup Engine refuses or never answers leaves the episode rows", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    f.state.seasonRejection = { status: 403, code: "procedure_not_allowed" };
    assert.deepEqual(
      (await episodeRows(f)).map(({ name }) => name),
      ["Download to put.io"],
    );
    f.state.seasonRejection = undefined;
    f.state.stallSeasonPack = true;
    const started = performance.now();
    assert.deepEqual(
      (await episodeRows(f)).map(({ name }) => name),
      ["Download to put.io"],
    );
    assert.ok(performance.now() - started < 3_000);
    await until(() => f.state.abandonedSeasonLookups === 1);
  } finally {
    await f.close();
  }
});

test("a season lookup slower than the episode search still lists its pack", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    // The pack answers after the search, but before the grace that follows it ends.
    f.state.engineDelayMs = 500;
    f.state.seasonDelayMs = 750;
    assert.deepEqual(
      (await episodeRows(f)).map(({ name }) => name),
      ["Download to put.io", "Download season to put.io"],
    );
  } finally {
    await f.close();
  }
});

test("a season pack plays the one video Engine names as the requested episode", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    f.state.folders.set(20n, [
      ...packEpisodes,
      {
        id: 23n,
        name: "Season file two.sample.mkv",
        fileType: "VIDEO",
        releaseInfo: { season: 1, episode: 2 },
      },
    ]);
    assert.equal(
      await location(packSelection(f)),
      "https://media.fixture.test/video-22?token=fixture-playback-secret",
    );
    assert.equal(f.state.addCount, 1);
    const flagged = (id: bigint) =>
      f.listings.filter((listing) => listing.id === id && listing.releaseInfo)
        .length;
    assert.equal(flagged(10n), 0, "The destination listing");
    assert.equal(flagged(20n), 1, "The download's own listing");
    f.listings.length = 0;
    assert.equal(
      await location(`${f.base()}/status/90.m3u8`),
      `${f.base()}/notice/select-file.m3u8`,
      "The same download selected by its episode release",
    );
    assert.equal(flagged(20n), 0);
    assert.equal(
      await location(`${f.base()}/status/90/1/2.m3u8`),
      "https://media.fixture.test/video-22?token=fixture-playback-secret",
    );
  } finally {
    await f.close();
  }
});

test("a season pack put.io is still completing waits for its files instead of playing unavailable", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    // put.io names the download's folder before it moves the files in.
    f.state.transferStatus = "COMPLETING";
    f.state.folders.set(20n, []);
    let responded = false;
    const status = location(`${f.base()}/status/90/1/2.m3u8`).then((url) => {
      responded = true;
      return url;
    });
    await sleep(300);
    assert.equal(responded, false);
    f.state.transferStatus = undefined;
    f.state.folders.set(20n, packEpisodes);
    assert.equal(
      await status,
      "https://media.fixture.test/video-22?token=fixture-playback-secret",
    );
  } finally {
    await f.close();
  }
});

test("a season pack asks for a file choice unless exactly one video is the episode", async () => {
  const f = await fixture();
  const status = () => location(`${f.base()}/status/90/1/2.m3u8`);
  const choose = `${f.base()}/notice/select-file.m3u8`;
  const video = (
    id: bigint,
    releaseInfo?: { season?: number; episode?: number; episodeEnd?: number },
  ) => ({
    id,
    name: `Season file ${id}.mkv`,
    fileType: "VIDEO",
    releaseInfo,
  });
  try {
    for (const [files, expected, reason] of [
      [
        [video(21n, { episode: 2 }), video(22n, { season: 1, episode: 1 })],
        choose,
        "an episode without a season",
      ],
      [
        [
          video(21n, { season: 1, episode: 1 }),
          video(22n, { season: 1, episode: 2, episodeEnd: 3 }),
        ],
        choose,
        "an episode range",
      ],
      [
        [
          video(21n, { season: 1, episode: 2 }),
          video(22n, { season: 1, episode: 2 }),
        ],
        choose,
        "two matching videos",
      ],
      [[video(21n), video(22n)], choose, "no release info"],
      [[], `${f.base()}/notice/unavailable.m3u8`, "no videos"],
      [
        [
          video(21n, { season: 1, episode: 1 }),
          video(22n, { season: 1, episode: 2, episodeEnd: 2 }),
        ],
        "https://media.fixture.test/video-22?token=fixture-playback-secret",
        "a range of the episode alone",
      ],
    ] as const) {
      f.state.folders.set(20n, [...files]);
      assert.equal(await status(), expected, reason);
    }
    f.state.folders.set(10n, [video(20n, { season: 1, episode: 2 })]);
    assert.equal(await status(), choose, "a single-file download");
  } finally {
    await f.close();
  }
});

test("a pending season pack keeps its episode in the status URL", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.state.seasonPack = seasonPack;
    f.state.folders.set(20n, packEpisodes);
    f.state.transferFinished = false;
    const reads = () =>
      f.calls.filter(({ method }) => method === "GetTransfer").length;
    const selected = fetch(packSelection(f), { redirect: "manual" });
    while (reads() === 0) await sleep(5);
    await vi.advanceTimersByTimeAsync(25_000);
    const continued = (await selected).headers.get("location");
    assert.equal(continued, `${f.base()}/status/90/1/2.m3u8?wait=1`);
    vi.useRealTimers();
    f.state.transferFinished = true;
    assert.equal(
      await location(continued),
      "https://media.fixture.test/video-22?token=fixture-playback-secret",
    );
    for (const [path, code] of [
      ["/status/90/0/2.m3u8", 404],
      ["/status/90/1/10000.m3u8", 404],
      ["/status/90/1.m3u8", 404],
      ["/status/90/1/2.m3u8?other=1", 400],
      ["/status/90/1/2.m3u8?wait=6", 400],
    ] as const)
      assert.equal(
        (await fetch(`${f.base()}${path}`, { redirect: "manual" })).status,
        code,
        path,
      );
    assert.equal(f.state.addCount, 1);
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("a season pack Engine no longer offers or refuses plays release-unavailable", async () => {
  const f = await fixture();
  const unavailable = `${f.base()}/notice/release-unavailable.m3u8`;
  try {
    f.state.seasonPack = { ...seasonPack, id: "another-season-pack" };
    assert.equal(await location(packSelection(f)), unavailable);
    f.state.seasonPack = undefined;
    assert.equal(await location(packSelection(f)), unavailable);
    f.state.seasonPack = seasonPack;
    f.state.seasonRejection = { status: 403, code: "procedure_not_allowed" };
    assert.equal(await location(packSelection(f)), unavailable);
    f.state.seasonRejection = { status: 500, code: "internal" };
    assert.equal(await location(packSelection(f)), unavailable);
    f.state.seasonRejection = undefined;
    f.state.seasonPack = { ...seasonPack, id: "" };
    assert.equal(
      await location(packSelection(f)),
      unavailable,
      "A pack without an ID",
    );
    f.state.seasonPack = seasonPack;
    f.state.seasonRejection = { status: 401, code: "unauthenticated" };
    assert.equal(
      await location(packSelection(f)),
      `${f.base()}/notice/reconnect.m3u8`,
    );
    assert.equal(f.state.addCount, 0);
    const calls = f.calls.length;
    assert.equal(
      await location(
        `${f.base()}/play/movie/${encodeURIComponent(target)}/${encodeURIComponent(`pack:${seasonPack.id}`)}.m3u8`,
      ),
      unavailable,
      "A movie has no season pack",
    );
    assert.equal(
      f.calls
        .slice(calls)
        .some(({ method }) => method === "GetTVShowSeasonDownloads"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("movie and episode releases never consult the season lookup", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    f.state.seasonRejection = { status: 403, code: "procedure_not_allowed" };
    f.state.singleFile = true;
    const episode = `${f.base()}/play/series/${encodeURIComponent(episodeTarget)}/fixture-release.m3u8`;
    f.state.releaseMissing = true;
    assert.equal(
      await location(episode),
      `${f.base()}/notice/release-unavailable.m3u8`,
    );
    f.state.releaseMissing = false;
    for (const url of [await releaseSelection(f), episode])
      assert.equal(
        await location(url),
        "https://media.fixture.test/video-21?token=fixture-playback-secret",
      );
    assert.equal(f.state.addCount, 2);
    assert.ok(f.listings.every(({ releaseInfo }) => !releaseInfo));
    assert.equal(
      f.calls.some(({ method }) => method === "GetTVShowSeasonDownloads"),
      false,
    );
  } finally {
    await f.close();
  }
});

const ownedVideo = (id: bigint) => ({
  id,
  name: `Independent.Film.2024.Part${id}.mkv`,
});
const movieRows = async (f: Fixture, id = "tt1234567") => {
  const response = await fetch(
    `${f.base()}/stream/movie/${encodeURIComponent(id)}.json`,
  );
  assert.equal(response.status, 200);
  return (await decode(response, Rows)).streams;
};
const ownedSelection = (f: Fixture, fileId: string, format = "m3u8") =>
  `${f.base()}/play/movie/${encodeURIComponent(target)}/${encodeURIComponent(`owned:${fileId}`)}.${format}`;

test("videos already in put.io lead the stream list, outside the release limit", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = Array.from({ length: 10 }, (_, n) =>
      ownedVideo(BigInt(n + 70)),
    );
    f.state.extraReleases = 100;
    const response = await fetch(`${f.base()}/stream/movie/tt1234567.json`);
    const listed = Schema.decodeUnknownSync(
      Schema.Struct({
        streams: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            title: Schema.String,
            url: Schema.String,
            behaviorHints: Schema.Struct({ notWebReady: Schema.Boolean }),
          }),
        ),
      }),
    )(await response.json()).streams;
    assert.equal(listed.length, 110, "10 videos and 100 releases");
    assert.deepEqual(listed[0], {
      name: "Play from put.io",
      title: "Independent.Film.2024.Part70.mkv",
      url: ownedSelection(f, "70"),
      behaviorHints: { notWebReady: false },
    });
    assert.deepEqual(
      listed.slice(0, 10).map(({ name, title }) => ({ name, title })),
      f.state.ownedVideos.map(({ name }) => ({
        name: "Play from put.io",
        title: name,
      })),
    );
    assert.ok(
      listed.slice(10).every(({ name }) => name === "Download to put.io"),
    );
    f.state.seasonPack = seasonPack;
    const episode = await episodeRows(f);
    assert.equal(episode.length, 111, "10 videos, 100 releases and the pack");
    assert.equal(episode[0]?.name, "Play from put.io");
    assert.equal(episode.at(-1)?.name, "Download season to put.io");
    for (const method of ["GetTVShowDetail", "GetTVShowSeason"])
      assert.equal(
        f.calls.filter((call) => call.method === method).length,
        1,
        `${method} serves both the lookup and Search`,
      );
    assert.deepEqual(f.ownedLookups, [
      { title: "Independent film", year: 2024 },
      { title: "Independent series", year: 2024, season: 1, episode: 2 },
    ]);
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("the account lookup runs alongside Search, not after it", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    // Search takes 1 s; the lookup answers after 1.2 s, inside the grace
    // that follows Search only if it started with Search.
    f.state.engineDelayMs = 1_000;
    f.state.ownedDelayMs = 1_200;
    assert.deepEqual(
      (await movieRows(f)).map(({ name }) => name),
      ["Play from put.io", "Download to put.io"],
    );
  } finally {
    await f.close();
  }
});

test("an account lookup slower than its grace is left out", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    f.state.ownedDelayMs = 3_000;
    const started = performance.now();
    assert.deepEqual(
      (await movieRows(f)).map(({ name }) => name),
      ["Download to put.io"],
    );
    assert.ok(performance.now() - started < 2_800);
  } finally {
    await f.close();
  }
});

test("a fast release search still gives the account and season lookups two seconds", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    f.state.seasonPack = seasonPack;
    // Search answers at once; both lookups answer after more than its grace.
    f.state.ownedDelayMs = 1_200;
    f.state.seasonDelayMs = 1_200;
    assert.deepEqual(
      (await movieRows(f)).map(({ name }) => name),
      ["Play from put.io", "Download to put.io"],
    );
    assert.deepEqual(
      (await episodeRows(f)).map(({ name }) => name),
      ["Play from put.io", "Download to put.io", "Download season to put.io"],
    );
  } finally {
    await f.close();
  }
});

test("a refused or malformed account lookup leaves the rows unchanged", async () => {
  const f = await fixture();
  try {
    const baseline = await movieRows(f);
    assert.deepEqual(
      baseline.map(({ name }) => name),
      ["Download to put.io"],
    );
    f.state.ownedVideos = [ownedVideo(77n)];
    for (const rejection of [
      { status: 401, code: "unauthenticated" },
      { status: 403, code: "permission_denied" },
      { status: 403, code: "procedure_not_allowed" },
      { status: 503, code: "unavailable" },
    ]) {
      f.state.ownedRejection = rejection;
      assert.deepEqual(await movieRows(f), baseline, rejection.code);
    }
    f.state.ownedRejection = undefined;
    for (const videos of [
      [{ ...ownedVideo(77n), fileType: "FOLDER" }],
      Array.from({ length: 11 }, (_, n) => ownedVideo(BigInt(n + 70))),
    ]) {
      f.state.ownedVideos = videos;
      assert.deepEqual(await movieRows(f), baseline);
    }
  } finally {
    await f.close();
  }
});

test("release targets and missing titles never ask for videos in put.io", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    const release = discoveryTargetId({
      kind: "release",
      query: "Independent film",
      id: "fixture-release",
    });
    assert.deepEqual(
      (await movieRows(f, release)).map(({ name }) => name),
      ["Download to put.io"],
    );
    assert.deepEqual(
      await movieRows(
        f,
        discoveryTargetId({ kind: "movie", id: "missing-film" }),
      ),
      [],
    );
    assert.deepEqual(f.ownedLookups, []);
  } finally {
    await f.close();
  }
});

test("a video already in put.io plays without a transfer or status URL", async () => {
  const f = await fixture();
  const media =
    "https://media.fixture.test/video-77?token=fixture-playback-secret";
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    const [row] = await movieRows(f);
    assert.equal(row?.url, ownedSelection(f, "77"));
    f.calls.length = 0;
    assert.equal(
      (await fetch(ownedSelection(f, "77"), { method: "HEAD" })).status,
      200,
    );
    const prefetch = await fetch(ownedSelection(f, "77"), {
      headers: { "sec-purpose": "prefetch" },
    });
    assert.equal(prefetch.status, 204);
    assert.deepEqual(f.calls, []);
    assert.equal(await location(ownedSelection(f, "77")), media);
    assert.equal(await location(ownedSelection(f, "77", "mp4")), media);
    f.state.playbackPending = true;
    for (const format of ["m3u8", "mp4"])
      assert.equal(
        await location(ownedSelection(f, "77", format)),
        `${f.base()}/notice/preparing.${format}`,
      );
    f.state.playbackPending = false;
    assert.equal(await location(ownedSelection(f, "77")), media);
    for (const format of ["m3u8", "mp4"])
      assert.equal(
        await location(ownedSelection(f, "78", format)),
        `${f.base()}/notice/unavailable.${format}`,
      );
    for (const rejection of [
      { status: 401, code: "unauthenticated" },
      { status: 403, code: "permission_denied" },
    ]) {
      f.state.rejection = rejection;
      assert.equal(
        await location(ownedSelection(f, "77")),
        `${f.base()}/notice/reconnect.m3u8`,
      );
    }
    f.state.rejection = undefined;
    assert.ok(f.calls.every(({ method }) => method === "ResolvePlayback"));
    assert.equal(f.state.addCount, 0);
    const calls = f.calls.length;
    for (const id of [
      "0",
      "077",
      "-1",
      "",
      "abc",
      "9223372036854775808",
      "1".repeat(20),
    ])
      assert.equal(
        (await fetch(ownedSelection(f, id), { redirect: "manual" })).status,
        400,
        id,
      );
    assert.equal(f.calls.length, calls);
  } finally {
    await f.close();
  }
});

test("a video already in put.io needs no submission unit of its link", async () => {
  const f = await fixture();
  const catalog = () => fetch(`${f.base()}/catalog/movie/discover-movies.json`);
  const stalled: Promise<Response>[] = [];
  // Fake only the request deadline timers; sockets stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    f.state.stallMovies = true;
    for (let i = 0; i < 15; i++) stalled.push(catalog());
    await until(
      () =>
        f.calls.filter(({ method }) => method === "GetMovies").length === 15,
    );
    const another = await fetch(
      `${f.base()}/play/movie/${encodeURIComponent(target)}/fixture-release.m3u8`,
      { redirect: "manual" },
    );
    assert.equal(another.status, 503, "a new selection needs two free units");
    await another.arrayBuffer();
    assert.equal(
      await location(ownedSelection(f, "77")),
      "https://media.fixture.test/video-77?token=fixture-playback-secret",
    );
    assert.equal(f.state.addCount, 0);
    await vi.advanceTimersByTimeAsync(10_000);
    for (const response of await Promise.all(stalled)) {
      assert.equal(response.status, 504);
      await response.arrayBuffer();
    }
  } finally {
    vi.useRealTimers();
    const settled = Promise.allSettled(stalled);
    await f.close();
    await settled;
  }
});
