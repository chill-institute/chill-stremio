import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { promisify } from "node:util";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
  AudioCodec,
  SubtitleFormat,
  GetMoviesResponseSchema,
  GetTVShowsResponseSchema,
  GetTVShowDetailResponseSchema,
  GetTVShowSeasonResponseSchema,
  GetTVShowDetailRequestSchema,
  GetTVShowSeasonRequestSchema,
  UserSearchRequestSchema,
  SearchResponseSchema,
  AddTransferRequestSchema,
  AddTransferResponseSchema,
  GetTransferRequestSchema,
  GetTransferResponseSchema,
  Container,
  GetFolderRequestSchema,
  GetFolderResponseSchema,
  ResolvePlaybackRequestSchema,
  ResolvePlaybackResponseSchema,
  VideoCodec,
} from "@chill-institute/contracts/chill/v4/api_pb";
import { Effect } from "effect";
import { generateHls } from "./hls-fixture.ts";

// Generated Engine responses and lawful fixture media for the hosted adapter.
// Nothing here contacts a real account or provider.
export const hostedFixture = {
  libraryFolderId: 200n,
  libraryFileId: 9223372036854775807n - 4n,
  libraryName: "Nested Library Movie",
  fileId: 9223372036854775807n,
  episodeFileId: 9223372036854775807n - 1n,
  movieName: "Hosted Fixture Movie",
  episodeName: "Hosted Fixture Episode",
  discoveryName: "Synthetic Feature Alpha",
  seriesName: "Synthetic Series Alpha",
  movieId: "fixture-movie",
  fixtureImdbId: "tt1234567",
  seriesImdbId: "tt7654321",
  multipleFolderId: 100n,
  multipleMovieId: 9223372036854775807n - 2n,
  multipleEpisodeId: 9223372036854775807n - 3n,
  multipleMovieName: "First file - generated movie",
  multipleEpisodeName: "Second file - generated episode",
  recoveryCases: [
    { kind: "failed", name: "Synthetic Failed Release", transferId: 3n },
    { kind: "unknown", name: "Synthetic Unknown Release", transferId: 4n },
    { kind: "select-file", name: "Synthetic Multiple Files", transferId: 5n },
  ],
} as const;
export type RecoveryKind = (typeof hostedFixture.recoveryCases)[number]["kind"];
export const movieTarget = (id: string) =>
  `chill:movie:${Buffer.from(id).toString("base64url")}`;
export const episodeTarget = `chill:episode:${hostedFixture.seriesImdbId}:1:1`;
export const seriesMetaId = `chill:series:${hostedFixture.seriesImdbId}`;
/** A generated value with the shape of an Engine-issued Stremio credential. */
export const fakeCredential = (bytes = 300) =>
  `v4.local.${randomBytes(bytes).toString("base64url")}`;

export interface HostedEngineState {
  submitted: boolean;
  episodeSubmitted: boolean;
  completed: boolean;
  recoverySubmitted: Set<RecoveryKind>;
  /** Answer every RPC as Engine does for a revoked or expired credential. */
  credentialRejected: boolean;
}
export interface HostedEngineCalls {
  folder: number;
  playback: number;
  discovery: number;
  search: number;
  transfer: number;
  rejected: number;
  /** RPCs answered with 401 while the credential was rejected. */
  unauthenticated: number;
  /** Resolved playback file IDs in request order. */
  playbackFiles: string[];
}
export interface HostedMedia {
  origin: string;
  /** Active fixture responses cut by an armed interruption. */
  cuts: number;
  /** Media requests refused while the interruption window was open. */
  refused: number;
  interrupt(): void;
}

export async function listen(server: Server, protocol = "http") {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `${protocol}://127.0.0.1:${address.port}`;
}
export async function close(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export const generateCertificates = Effect.fn("generateCertificates")(
  function* () {
    yield* Effect.promise(() => mkdir(".cache", { recursive: true }));
    const directory = yield* Effect.acquireRelease(
      Effect.tryPromise(() => mkdtemp(".cache/adapter-tls-")),
      (path) =>
        Effect.promise(() => rm(path, { recursive: true, force: true })),
    );
    yield* Effect.tryPromise(() =>
      promisify(execFile)(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-days",
          "1",
          "-subj",
          "/CN=localhost",
          "-addext",
          "subjectAltName=IP:127.0.0.1",
          "-keyout",
          `${directory}/key.pem`,
          "-out",
          `${directory}/cert.pem`,
        ],
        { timeout: 15000 },
      ),
    );
    const key = yield* Effect.tryPromise(() =>
      readFile(`${directory}/key.pem`),
    );
    const cert = yield* Effect.tryPromise(() =>
      readFile(`${directory}/cert.pem`),
    );
    return { directory, key, cert };
  },
);

const mediaPaths = [
  "/media/movie.mp4",
  "/media/episode1.mp4",
  "/media/english.vtt",
  "/media/spanish.vtt",
  "/poster.svg",
];
const interruptionWindowMs = 6000;
// The generated movie is small enough to download in one burst, which leaves
// nothing to interrupt. The native lane paces the tail so a real response stays
// open mid-playback while still delivering faster than the clip plays; the Web
// smoke keeps burst delivery for its seek checks.
const pacedPath = "/media/movie.mp4";
const burstBytes = 128 * 1024;
const paceBytes = 12 * 1024;
const paceIntervalMs = 400;
const pace = async (
  source: AsyncIterable<Buffer>,
  sink: NodeJS.WritableStream,
  open: () => boolean,
) => {
  let sent = 0;
  for await (const chunk of source) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!open()) return;
      const slice = chunk.subarray(
        offset,
        sent < burstBytes ? chunk.length : offset + paceBytes,
      );
      if (!sink.write(slice))
        await new Promise<void>((resolve) => sink.once("drain", resolve));
      sent += slice.length;
      offset += slice.length;
      if (sent >= burstBytes)
        await new Promise<void>((resolve) =>
          setTimeout(resolve, paceIntervalMs),
        );
    }
  }
  sink.end();
};

/** HTTPS front for the plain fixture media, as Engine only resolves secure playback URLs. */
export const startHostedMedia = Effect.fn("startHostedMedia")(function* (
  fixtureOrigin: string,
  certificate: { key: Buffer; cert: Buffer },
  options: { paceMovie?: boolean; hls?: boolean } = {},
) {
  const playlists = new Map<string, Buffer>();
  if (options.hls) {
    for (const name of ["movie", "episode1"]) {
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(".cache/hosted-hls-")),
        (path) =>
          Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const files = yield* Effect.tryPromise(() =>
        generateHls(directory, `.cache/media/${name}.mp4`),
      );
      for (const { file } of files)
        playlists.set(
          `/hls/${name}/${file}`,
          yield* Effect.tryPromise(() => readFile(`${directory}/${file}`)),
        );
    }
  }
  return yield* Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const active = new Set<() => void>();
      let refuseUntil = 0;
      const media: HostedMedia = {
        origin: "",
        cuts: 0,
        refused: 0,
        interrupt: () => {
          refuseUntil = Date.now() + interruptionWindowMs;
          for (const cut of active) cut();
        },
      };
      const server = createTlsServer(certificate, (req, res) => {
        const pathname = new URL(req.url ?? "/", fixtureOrigin).pathname;
        const playlist = playlists.get(pathname);
        if (playlist && ["GET", "HEAD", "OPTIONS"].includes(req.method ?? "")) {
          res
            .writeHead(200, {
              "access-control-allow-origin": "*",
              "cache-control": "no-store",
              "content-type": pathname.endsWith(".m3u8")
                ? "application/vnd.apple.mpegurl"
                : pathname.endsWith(".vtt")
                  ? "text/vtt"
                  : pathname.endsWith(".m4s") || pathname.endsWith(".mp4")
                    ? "video/mp4"
                    : "video/mp2t",
            })
            .end(req.method === "GET" ? playlist : undefined);
          return;
        }
        if (
          !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "") ||
          !mediaPaths.includes(pathname)
        ) {
          res.writeHead(404).end();
          return;
        }
        if (pathname === pacedPath && Date.now() < refuseUntil) {
          media.refused++;
          res.destroy();
          return;
        }
        const paced =
          options.paceMovie === true &&
          pathname === pacedPath &&
          req.method === "GET";
        const upstream = request(
          `${fixtureOrigin}${pathname}`,
          {
            method: req.method,
            headers: req.headers.range ? { range: req.headers.range } : {},
            timeout: 10000,
          },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            if (paced)
              void pace(response, res, () => active.has(cut)).catch(() => {
                res.destroy();
              });
            else response.pipe(res);
          },
        );
        const cut = () => {
          if (!active.delete(cut)) return;
          media.cuts++;
          upstream.destroy();
          res.destroy();
        };
        if (paced) active.add(cut);
        upstream.once("timeout", () => upstream.destroy());
        upstream.once("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        res.once("close", () => {
          active.delete(cut);
          upstream.destroy();
        });
        upstream.end();
      });
      media.origin = await listen(server, "https");
      return { server, media };
    }),
    ({ server }) => Effect.promise(() => close(server)),
  );
});

export const startHostedEngine = Effect.fn("startHostedEngine")(
  function* (options: {
    mediaOrigin: string;
    credential?: string;
    hls?: boolean;
  }) {
    const credential = options.credential ?? fakeCredential();
    const {
      libraryFolderId,
      libraryFileId,
      libraryName,
      fileId,
      episodeFileId,
      movieName,
      episodeName,
      discoveryName,
      seriesName,
      fixtureImdbId,
      seriesImdbId,
      multipleFolderId,
      multipleMovieId,
      multipleEpisodeId,
      multipleMovieName,
      multipleEpisodeName,
      recoveryCases,
    } = hostedFixture;
    const media = options.mediaOrigin;
    const state: HostedEngineState = {
      submitted: false,
      episodeSubmitted: false,
      completed: false,
      recoverySubmitted: new Set(),
      credentialRejected: false,
    };
    const calls: HostedEngineCalls = {
      folder: 0,
      playback: 0,
      discovery: 0,
      search: 0,
      transfer: 0,
      rejected: 0,
      unauthenticated: 0,
      playbackFiles: [],
    };
    return yield* Effect.acquireRelease(
      Effect.tryPromise(async () => {
        const server = createServer(async (req, res) => {
          try {
            assert.equal(req.method, "POST");
            assert.equal(req.headers.authorization, undefined);
            assert.equal(req.headers["x-chill-stremio-credential"], credential);
            assert.ok(
              [
                "GetFolder",
                "GetMovies",
                "GetTVShows",
                "GetTVShowDetail",
                "GetTVShowSeason",
                "Search",
                "AddTransfer",
                "GetTransfer",
                "ResolvePlayback",
              ].includes(req.url?.split("/").at(-1) ?? ""),
            );
            if (state.credentialRejected) {
              calls.unauthenticated++;
              res
                .writeHead(401, { "content-type": "application/json" })
                .end(
                  '{"code":"unauthenticated","message":"Generated credential rejection"}',
                );
              return;
            }
            let body = "";
            for await (const chunk of req) {
              body += String(chunk);
              assert.ok(body.length < 4096);
            }
            let response: string;
            if (req.url === "/chill.v4.UserService/GetFolder") {
              const folderId = fromJsonString(GetFolderRequestSchema, body).id;
              assert.ok(
                folderId === 0n ||
                  folderId === libraryFolderId ||
                  (folderId === multipleFolderId &&
                    state.recoverySubmitted.has("select-file")),
              );
              calls.folder++;
              response = toJsonString(
                GetFolderResponseSchema,
                create(GetFolderResponseSchema, {
                  parent: { id: folderId, name: "Library", fileType: "FOLDER" },
                  files:
                    folderId === libraryFolderId
                      ? [
                          {
                            id: libraryFileId,
                            name: libraryName,
                            fileType: "VIDEO",
                          },
                        ]
                      : folderId === multipleFolderId
                        ? [
                            {
                              id: multipleMovieId,
                              name: multipleMovieName,
                              fileType: "VIDEO",
                            },
                            {
                              id: multipleEpisodeId,
                              name: multipleEpisodeName,
                              fileType: "VIDEO",
                            },
                          ]
                        : [
                            {
                              id: libraryFolderId,
                              name: "Nested library",
                              fileType: "FOLDER",
                            },
                            ...(state.recoverySubmitted.has("select-file")
                              ? [
                                  {
                                    id: multipleFolderId,
                                    name: "Multiple files",
                                    fileType: "FOLDER",
                                  },
                                ]
                              : []),
                            ...(state.submitted && state.completed
                              ? [
                                  {
                                    id: fileId,
                                    name: movieName,
                                    fileType: "VIDEO",
                                  },
                                ]
                              : []),
                            ...(state.episodeSubmitted && state.completed
                              ? [
                                  {
                                    id: episodeFileId,
                                    name: episodeName,
                                    fileType: "VIDEO",
                                  },
                                ]
                              : []),
                          ],
                }),
              );
            } else if (req.url === "/chill.v4.UserService/GetMovies") {
              calls.discovery++;
              response = toJsonString(
                GetMoviesResponseSchema,
                create(GetMoviesResponseSchema, {
                  movies: [
                    ...recoveryCases.map(({ kind, name }) => ({
                      id: `fixture-${kind}`,
                      title: name,
                      year: 2026,
                      posterUrl: `${media}/poster.svg`,
                    })),
                    {
                      id: hostedFixture.movieId,
                      title: discoveryName,
                      year: 2026,
                      externalUrl: `https://www.imdb.com/title/${fixtureImdbId}/`,
                      posterUrl: `${media}/poster.svg`,
                      backdropUrl: `${media}/poster.svg`,
                      overview:
                        "A self-generated playback demo. No real account or provider transfer.",
                      rating: 8,
                    },
                  ],
                }),
              );
            } else if (req.url === "/chill.v4.UserService/GetTVShows") {
              response = toJsonString(
                GetTVShowsResponseSchema,
                create(GetTVShowsResponseSchema, {
                  shows: [
                    {
                      imdbId: seriesImdbId,
                      title: seriesName,
                      year: 2026,
                      posterUrl: `${media}/poster.svg`,
                      overview: "A generated series synopsis.",
                    },
                  ],
                }),
              );
            } else if (req.url === "/chill.v4.UserService/GetTVShowDetail") {
              assert.equal(
                fromJsonString(GetTVShowDetailRequestSchema, body).imdbId,
                seriesImdbId,
              );
              response = toJsonString(
                GetTVShowDetailResponseSchema,
                create(GetTVShowDetailResponseSchema, {
                  show: {
                    imdbId: seriesImdbId,
                    title: seriesName,
                    year: 2026,
                    posterUrl: `${media}/poster.svg`,
                    backdropUrl: `${media}/poster.svg`,
                    overview: "A generated series synopsis.",
                  },
                  seasons: [{ seasonNumber: 1 }],
                }),
              );
            } else if (req.url === "/chill.v4.UserService/GetTVShowSeason") {
              const seasonRequest = fromJsonString(
                GetTVShowSeasonRequestSchema,
                body,
              );
              assert.equal(seasonRequest.imdbId, seriesImdbId);
              assert.equal(seasonRequest.seasonNumber, 1);
              response = toJsonString(
                GetTVShowSeasonResponseSchema,
                create(GetTVShowSeasonResponseSchema, {
                  imdbId: seriesImdbId,
                  seasonNumber: 1,
                  episodes: [
                    {
                      seasonNumber: 1,
                      episodeNumber: 1,
                      name: "A generated first episode",
                      overview: "The episode context stays with its releases.",
                      stillUrl: `${media}/poster.svg`,
                      airDate: "2026-01-01",
                    },
                  ],
                }),
              );
            } else if (req.url === "/chill.v4.UserService/Search") {
              const { query } = fromJsonString(UserSearchRequestSchema, body);
              assert.ok(
                [
                  `${discoveryName} 2026`,
                  `${seriesName} S01E01`,
                  ...recoveryCases.map(({ name }) => `${name} 2026`),
                ].includes(query),
              );
              const isEpisode = query === `${seriesName} S01E01`;
              const recovery = recoveryCases.find(
                ({ name }) => query === `${name} 2026`,
              );
              calls.search++;
              response = toJsonString(
                SearchResponseSchema,
                create(SearchResponseSchema, {
                  query,
                  results: [
                    {
                      id: recovery
                        ? `fixture-${recovery.kind}-release`
                        : isEpisode
                          ? "fixture-episode-release"
                          : "fixture-release",
                      title: recovery
                        ? recovery.name
                        : isEpisode
                          ? `${seriesName} S01E01 1080p`
                          : `${discoveryName} 1080p`,
                      imdbId: recovery
                        ? ""
                        : isEpisode
                          ? seriesImdbId
                          : fixtureImdbId,
                      releaseInfo: isEpisode
                        ? { season: 1, episode: 1 }
                        : undefined,
                      indexer: "fixture",
                      link: recovery
                        ? `https://fixture.invalid/${recovery.kind}.torrent`
                        : isEpisode
                          ? "https://fixture.invalid/episode.torrent"
                          : "https://fixture.invalid/movie.torrent",
                      size: 1048576n,
                      seeders: 24n,
                    },
                  ],
                }),
              );
            } else if (req.url === "/chill.v4.UserService/AddTransfer") {
              const { url } = fromJsonString(AddTransferRequestSchema, body);
              assert.ok(
                [
                  "https://fixture.invalid/movie.torrent",
                  "https://fixture.invalid/episode.torrent",
                  ...recoveryCases.map(
                    ({ kind }) => `https://fixture.invalid/${kind}.torrent`,
                  ),
                ].includes(url),
              );
              const isEpisode =
                url === "https://fixture.invalid/episode.torrent";
              calls.transfer++;
              const recovery = recoveryCases.find(
                ({ kind }) => url === `https://fixture.invalid/${kind}.torrent`,
              );
              if (recovery) {
                assert.ok(
                  !state.recoverySubmitted.has(recovery.kind),
                  "Recovery scenario submitted twice",
                );
                state.recoverySubmitted.add(recovery.kind);
                if (recovery.kind === "unknown") {
                  res
                    .writeHead(503, { "content-type": "application/json" })
                    .end(
                      '{"code":"unavailable","message":"Generated lost submission response"}',
                    );
                  return;
                }
              }
              if (isEpisode) state.episodeSubmitted = true;
              else if (!recovery) state.submitted = true;
              response = toJsonString(
                AddTransferResponseSchema,
                create(AddTransferResponseSchema, {
                  transfer: recovery
                    ? {
                        id: recovery.transferId,
                        status:
                          recovery.kind === "failed" ? "ERROR" : "COMPLETED",
                        percentDone: recovery.kind === "failed" ? 0 : 100,
                        isFinished: true,
                        errorMessage:
                          recovery.kind === "failed"
                            ? "Generated transfer failure"
                            : "",
                        fileId:
                          recovery.kind === "select-file"
                            ? multipleFolderId
                            : undefined,
                        saveParentId: 0n,
                      }
                    : {
                        id: isEpisode ? 2n : 1n,
                        status: state.completed ? "COMPLETED" : "DOWNLOADING",
                        percentDone: state.completed ? 100 : 37,
                        isFinished: state.completed,
                        fileId: state.completed
                          ? isEpisode
                            ? episodeFileId
                            : fileId
                          : undefined,
                        saveParentId: 0n,
                      },
                }),
              );
            } else if (req.url === "/chill.v4.UserService/GetTransfer") {
              const { id } = fromJsonString(GetTransferRequestSchema, body);
              const recovery = recoveryCases.find(
                (entry) =>
                  entry.transferId === id &&
                  state.recoverySubmitted.has(entry.kind),
              );
              assert.ok(
                id === 1n ||
                  (id === 2n && state.episodeSubmitted) ||
                  (recovery && recovery.kind !== "unknown"),
              );
              response = toJsonString(
                GetTransferResponseSchema,
                create(GetTransferResponseSchema, {
                  transfer: recovery
                    ? {
                        id,
                        status:
                          recovery.kind === "failed" ? "ERROR" : "COMPLETED",
                        percentDone: recovery.kind === "failed" ? 0 : 100,
                        isFinished: true,
                        errorMessage:
                          recovery.kind === "failed"
                            ? "Generated transfer failure"
                            : "",
                        fileId:
                          recovery.kind === "select-file"
                            ? multipleFolderId
                            : undefined,
                        saveParentId: 0n,
                      }
                    : {
                        id,
                        status: state.completed ? "COMPLETED" : "DOWNLOADING",
                        percentDone: state.completed ? 100 : 37,
                        isFinished: state.completed,
                        fileId: state.completed
                          ? id === 2n
                            ? episodeFileId
                            : fileId
                          : undefined,
                        saveParentId: 0n,
                      },
                }),
              );
            } else {
              assert.equal(req.url, "/chill.v4.UserService/ResolvePlayback");
              const requestedFile = fromJsonString(
                ResolvePlaybackRequestSchema,
                body,
              ).fileId;
              assert.ok(
                requestedFile === libraryFileId ||
                  requestedFile === fileId ||
                  (requestedFile === episodeFileId && state.episodeSubmitted) ||
                  ([multipleMovieId, multipleEpisodeId].includes(
                    requestedFile,
                  ) &&
                    state.recoverySubmitted.has("select-file")),
              );
              calls.playback++;
              calls.playbackFiles.push(String(requestedFile));
              response = toJsonString(
                ResolvePlaybackResponseSchema,
                create(ResolvePlaybackResponseSchema, {
                  result: {
                    case: "ready",
                    value: {
                      media: {
                        url: options.hls
                          ? `${media}/hls/${requestedFile === episodeFileId || requestedFile === multipleEpisodeId ? "episode1" : "movie"}/master.m3u8`
                          : `${media}/media/${requestedFile === episodeFileId || requestedFile === multipleEpisodeId ? "episode1" : "movie"}.mp4`,
                        expiry: { case: "expiryUnknown", value: true },
                      },
                      subtitles: [
                        {
                          id: "fixture-english",
                          language: "eng",
                          file: "english.vtt",
                        },
                        {
                          id: "fixture-spanish",
                          language: "spa",
                          file: "spanish.vtt",
                        },
                      ].map(({ id, language, file }) => ({
                        id,
                        language,
                        format: SubtitleFormat.VTT,
                        source: {
                          url: `${media}/media/${file}`,
                          expiry: {
                            case: "expiryUnknown" as const,
                            value: true,
                          },
                        },
                      })),
                      format: {
                        container: options.hls
                          ? Container.UNSPECIFIED
                          : Container.MP4,
                        videoCodec: VideoCodec.H264,
                        audioCodec: AudioCodec.AAC,
                      },
                    },
                  },
                }),
              );
            }
            res
              .writeHead(200, {
                "content-type": "application/json",
                "cache-control": "no-store",
              })
              .end(response);
          } catch {
            calls.rejected++;
            res
              .writeHead(400, { "content-type": "application/json" })
              .end(
                '{"code":"invalid_argument","message":"Fixture request rejected"}',
              );
          }
        });
        return {
          server,
          origin: await listen(server),
          credential,
          state,
          calls,
        };
      }),
      ({ server }) => Effect.promise(() => close(server)),
    );
  },
);
