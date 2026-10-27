import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, get, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import * as proto from "@chill-institute/contracts/chill/v4/api_pb";
import { Schema } from "effect";
import { vi } from "vite-plus/test";
import { startHostedAdapter } from "../../src/hosted.ts";
import { statusMediaKinds, statusPlaylist } from "../../src/status-media.ts";
import { discoveryTargetId } from "../../src/discovery.ts";

export const statusSegment = Buffer.alloc(188 * 2, 0x47);
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
export const webOrigin = "http://127.0.0.1:3000";
export const credential = () =>
  `v4.local.${randomBytes(300).toString("base64url")}`;
export const ownerCredential = credential();
export const otherCredential = credential();
// More accepted links, so stalled requests can fill the whole process.
export const spareCredentials = [credential(), credential()];
export const target = discoveryTargetId({ kind: "movie", id: "fixture-film" });
export const episodeTarget = discoveryTargetId({
  kind: "episode",
  imdbId: "tt7654321",
  season: 1,
  episode: 2,
});
const seasonPackLink =
  "https://engine.fixture.test/download?token=fixture-season-secret";
export const parsedReleaseLink = (id: string) =>
  `https://engine.fixture.test/download?token=fixture-${id}`;
export const Catalog = Schema.Struct({
  metas: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String }),
  ),
});
export const Streams = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      url: Schema.optional(Schema.String),
      externalUrl: Schema.optional(Schema.String),
    }),
  ),
});
export async function decode<A, I>(
  response: Response,
  schema: Schema.Codec<A, I>,
): Promise<A> {
  const value: unknown = await response.json();
  return Schema.decodeUnknownSync(schema)(value);
}

export async function fixture(
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
    // ResolvePlayback answers that put.io must convert the video first.
    playbackConvertible: false,
    // ResolvePlayback answers unavailable for a reason other than conversion.
    playbackUnavailable: false,
    conversionResult: "pending" as "pending" | "unavailable",
    // An accepted conversion leaves the video pending, as put.io converting
    // it would.
    conversionStarts: false,
    conversionRejection: undefined as
      | { status: number; code: string }
      | undefined,
    // File IDs StartPlaybackConversion was asked to convert, in order.
    conversions: [] as bigint[],
    // File IDs ResolvePlayback was asked to resolve, in order.
    resolved: [] as bigint[],
    rejection: undefined as { status: number; code: string } | undefined,
    // Engine closes each connection without answering.
    dropConnections: false,
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
  const latency = async (ms: number) => {
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
  };
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
      if (state.dropConnections) {
        response.destroy();
        return;
      }
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
          await latency(state.seasonDelayMs);
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
          await latency(state.ownedDelayMs);
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
          state.resolved.push(fileId);
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
          if (state.playbackConvertible || state.playbackUnavailable) {
            response.end(
              JSON.stringify({
                unavailable: {
                  reason: state.playbackConvertible
                    ? "UNAVAILABLE_REASON_CONVERSION_REQUIRED"
                    : "UNAVAILABLE_REASON_UNSUPPORTED_FORMAT",
                },
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
        case "StartPlaybackConversion": {
          const { fileId } = fromJsonString(
            proto.StartPlaybackConversionRequestSchema,
            json,
          );
          state.conversions.push(fileId);
          if (state.conversionRejection) {
            error(
              response,
              state.conversionRejection.status,
              state.conversionRejection.code,
            );
            return;
          }
          if (state.conversionStarts && state.conversionResult === "pending") {
            state.playbackConvertible = false;
            state.playbackPending = true;
          }
          response.end(
            toJsonString(
              proto.StartPlaybackConversionResponseSchema,
              create(proto.StartPlaybackConversionResponseSchema, {
                result:
                  state.conversionResult === "pending"
                    ? { case: "pending", value: { reason: 1 } }
                    : { case: "unavailable", value: { reason: 2 } },
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

export async function releaseSelection(f: Fixture) {
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
/**
 * Runs a request on a fake clock: advances fake timers and Date in small steps,
 * giving sockets a real turn between steps, and returns the fake time the
 * request took. Deadlines then cost no real time.
 */
export async function onFakeClock<T>(request: () => Promise<T>) {
  const stepMs = 20;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  try {
    let settled = false;
    const pending = request().finally(() => {
      settled = true;
    });
    let elapsedMs = 0;
    for (;;) {
      await sleep(2);
      if (settled) break;
      assert.ok(elapsedMs < 30_000, "request did not settle on the fake clock");
      await vi.advanceTimersByTimeAsync(stepMs);
      elapsedMs += stepMs;
    }
    return { value: await pending, elapsedMs };
  } finally {
    vi.useRealTimers();
  }
}

export async function until(condition: () => boolean) {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "condition not reached");
    await sleep(5);
  }
}

// Sends the path as written; fetch would resolve its dot segments first.
export function rawStatus(origin: string, path: string) {
  const { hostname, port } = new URL(origin);
  return new Promise<number | undefined>((resolve, reject) => {
    get({ hostname, port, path }, (response) => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
}

export const Rows = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      title: Schema.String,
      url: Schema.String,
    }),
  ),
});
export const seasonPack = {
  id: "fixture-season-pack",
  resolution: "1080p",
  codec: "x264",
  quality: "WEB",
};
export const packEpisodes = [
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
export const episodeRows = async (f: Fixture) => {
  const response = await fetch(
    `${f.base()}/stream/series/${encodeURIComponent("tt7654321:1:2")}.json`,
  );
  assert.equal(response.status, 200);
  return (await decode(response, Rows)).streams;
};
export const packSelection = (f: Fixture, id = seasonPack.id) =>
  `${f.base()}/play/series/${encodeURIComponent(episodeTarget)}/${encodeURIComponent(`pack:${id}`)}.m3u8`;
export const location = async (url: string) =>
  (await fetch(url, { redirect: "manual" })).headers.get("location");

/** Episode row names and the fake time the listing took. */
export const timedEpisodeRows = async (f: Fixture) => {
  const { value, elapsedMs } = await onFakeClock(() => episodeRows(f));
  return { names: value.map(({ name }) => name), elapsedMs };
};

/** Movie row names and the fake time the listing took. */
export const timedMovieRows = async (f: Fixture) => {
  const { value, elapsedMs } = await onFakeClock(() => movieRows(f));
  return { names: value.map(({ name }) => name), elapsedMs };
};

export const ownedVideo = (id: bigint) => ({
  id,
  name: `Independent.Film.2024.Part${id}.mkv`,
});
export const movieRows = async (f: Fixture, id = "tt1234567") => {
  const response = await fetch(
    `${f.base()}/stream/movie/${encodeURIComponent(id)}.json`,
  );
  assert.equal(response.status, 200);
  return (await decode(response, Rows)).streams;
};
export const ownedSelection = (f: Fixture, fileId: string, format = "m3u8") =>
  `${f.base()}/play/movie/${encodeURIComponent(target)}/${encodeURIComponent(`owned:${fileId}`)}.${format}`;
export const librarySelection = (
  f: Fixture,
  fileId: string,
  options: { type?: string; id?: string; format?: string } = {},
) =>
  `${f.base()}/play/${options.type ?? "movie"}/${encodeURIComponent(options.id ?? `chill:file:${fileId}`)}/${encodeURIComponent(`owned:${fileId}`)}.${options.format ?? "m3u8"}`;

// Requests Stremio clients make for a media URL without consuming it.
export const readOnlyProbes: RequestInit[] = [
  { method: "HEAD" },
  { method: "OPTIONS" },
  { headers: { purpose: "prefetch" } },
  { headers: { "sec-purpose": "prefetch" } },
];
export const playbackResolutions = (f: Fixture) =>
  f.calls.filter(({ method }) => method === "ResolvePlayback").length;

const resolutionsOf = (f: Fixture, fileId: bigint) =>
  f.state.resolved.filter((id) => id === fileId).length;
/**
 * Waits on each file's library selection until it reads again after joining
 * its wait, then lets it play, so the wait stays remembered.
 */
export async function rememberWaits(f: Fixture, fileIds: readonly bigint[]) {
  f.state.playbackPending = true;
  const responses = fileIds.map((id) =>
    fetch(librarySelection(f, String(id)), { redirect: "manual" }),
  );
  await until(() => fileIds.every((id) => resolutionsOf(f, id) >= 2));
  f.state.playbackPending = false;
  for (const response of await Promise.all(responses)) {
    assert.equal(response.status, 302);
    await response.arrayBuffer();
  }
}
/**
 * Remembers waits for the first 256 of 257 file IDs, seen in their order, and
 * returns the IDs.
 */
export async function fillWaits(f: Fixture) {
  const fileIds = Array.from({ length: 257 }, (_, n) => BigInt(1_000 + n));
  f.state.ownedVideos = fileIds.map(ownedVideo);
  await rememberWaits(f, fileIds.slice(0, 1));
  await rememberWaits(f, fileIds.slice(1, 2));
  for (let n = 2; n < 256; n += 15)
    await rememberWaits(f, fileIds.slice(n, Math.min(n + 15, 256)));
  return fileIds;
}
/** Selects each file again and ends their windows together. */
export async function nextWindows(f: Fixture, fileIds: readonly bigint[]) {
  f.state.playbackPending = true;
  const before = fileIds.map((id) => resolutionsOf(f, id));
  const responses = fileIds.map((id) =>
    fetch(librarySelection(f, String(id)), { redirect: "manual" }),
  );
  await until(() =>
    fileIds.every((id, n) => resolutionsOf(f, id) >= (before[n] ?? 0) + 2),
  );
  await vi.advanceTimersByTimeAsync(25_000);
  return Promise.all(
    responses.map(async (response) => (await response).headers.get("location")),
  );
}
