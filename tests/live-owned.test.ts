import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import * as proto from "@chill-institute/contracts/chill/v4/api_pb";
import { Effect, Exit, Schema } from "effect";
import { test } from "vite-plus/test";
import { readLedger, utcDay } from "../harness/live/allowance.ts";
import {
  ownedConvertStep,
  ownedEpisode,
  ownedTitle,
  ownedWebStep,
  runOwnedPlayback,
  type Mp4Status,
  type OwnedConvert,
  type OwnedOptions,
  type OwnedProvider,
  type OwnedWebInput,
  type OwnedWebProof,
} from "../harness/live/owned.ts";
import { Mp4StatusFailure } from "../harness/live/putio.ts";
import { liveVersions } from "../harness/live/versions.ts";
import { versions } from "../harness/versions.ts";
import { startHostedAdapter } from "../src/hosted.ts";
import { statusMediaKinds, statusPlaylist } from "../src/status-media.ts";

const credential = `v4.local.${"O".repeat(300)}`;
const nonce = "0".repeat(32);
const mediaOrigin = "https://media.fixture.test";
const sourceBytes = 1234;
const convertBytes = 1300;
const mib = 1024 * 1024;

/**
 * How put.io and Engine treat the convert step's Matroska upload:
 * - `converts`: queued, converted, then streamed
 * - `not-required`: streamed as uploaded
 * - `read-only`: the first stream listing starts its conversion
 * - `selection`: Engine refuses to start the conversion
 * - `not-started`: Engine accepts, but put.io never starts
 * - `timeout`: put.io keeps converting
 * - `error`: put.io's conversion fails
 * - `listed-late`: the library lists the converted video only once put.io
 *   has reported it completed twice
 * - `finishes-unseen`: put.io finishes between a poll's MP4 read and its
 *   stream list read
 * - `plays-elsewhere`, `plays-mp4`, `plays-other-file`: Engine's playlist for
 *   the converted video is outside the media origin, not HLS, or another file's
 * - `plays-new-playlist`: each Engine read of the converted video names a new
 *   playlist
 */
type ConvertMode =
  | "converts"
  | "not-required"
  | "read-only"
  | "selection"
  | "not-started"
  | "timeout"
  | "error"
  | "listed-late"
  | "finishes-unseen"
  | "plays-elsewhere"
  | "plays-mp4"
  | "plays-other-file"
  | "plays-new-playlist";

function fakePutio(
  convert?: ConvertMode,
  outputBytes = 2 * mib,
  /** Whether an upload's local source exists when put.io receives it. */
  exists: (path: string) => boolean = () => true,
) {
  // Parent folder by file ID; 0 is the account root.
  const files = new Map<
    number,
    { name: string; parent: number; fileType: "FOLDER" | "VIDEO" }
  >([
    [101, { name: "Existing folder", parent: 0, fileType: "FOLDER" }],
    [102, { name: "Existing video.mkv", parent: 0, fileType: "VIDEO" }],
  ]);
  const deleted: number[][] = [];
  const uploads: {
    path: string;
    name: string;
    mediaType?: string;
    present: boolean;
  }[] = [];
  // Uploads put.io streams only after converting them.
  const matroska = new Set<number>();
  // Each conversion's step in `script`; a status read moves it on.
  const converting = new Map<number, number>();
  // MP4 reads that reported COMPLETED, by file.
  const completedReads = new Map<number, number>();
  const script: readonly Mp4Status[] =
    convert === "timeout"
      ? ["IN_QUEUE", "IN_QUEUE", "CONVERTING"]
      : convert === "error"
        ? ["IN_QUEUE", "IN_QUEUE", "ERROR"]
        : ["IN_QUEUE", "IN_QUEUE", "IN_QUEUE", "CONVERTING", "COMPLETED"];
  const status = (id: number): Mp4Status => {
    const step = converting.get(id);
    return step === undefined
      ? "NOT_AVAILABLE"
      : (script[Math.min(step, script.length - 1)] ?? "ERROR");
  };
  let next = 731_001;
  const add = (name: string, parent: number, fileType: "FOLDER" | "VIDEO") => {
    const id = next++;
    files.set(id, { name, parent, fileType });
    return { id };
  };
  const provider: OwnedProvider = {
    accountInfo: () => Effect.succeed({ username: "fixture" }),
    listFolderIds: (id) =>
      Effect.sync(() =>
        [...files].filter(([, file]) => file.parent === id).map(([id]) => id),
      ),
    createFolder: (name) => Effect.sync(() => add(name, 0, "FOLDER")),
    uploadFile: (path, name, parent, mediaType) =>
      Effect.sync(() => {
        uploads.push({ path, name, mediaType, present: exists(path) });
        const file = add(name, parent, "VIDEO");
        if (mediaType === "video/x-matroska" && convert !== "not-required")
          matroska.add(file.id);
        return file;
      }),
    deleteFiles: (ids) =>
      Effect.sync(() => {
        deleted.push([...ids]);
        for (const id of ids) {
          files.delete(id);
          for (const [child, file] of files)
            if (file.parent === id) files.delete(child);
        }
      }),
    fileAbsent: (id) => Effect.sync(() => !files.has(id)),
    getFile: (id) => Effect.sync(() => files.get(id)),
    mp4Status: (id) =>
      Effect.sync(() => {
        const step = converting.get(id);
        if (step !== undefined) converting.set(id, step + 1);
        const value = status(id);
        if (value !== "COMPLETED")
          return {
            status: value,
            percentDone: value === "CONVERTING" ? 57 : 0,
          };
        completedReads.set(id, (completedReads.get(id) ?? 0) + 1);
        return { status: value, percentDone: 100, size: outputBytes };
      }),
  };
  return {
    files,
    deleted,
    uploads,
    matroska,
    converting,
    completedReads,
    status,
    finish: (id: number) => converting.set(id, script.length - 1),
    provider,
  };
}

type Mode =
  | "playable"
  | "never-listed"
  | "episode-never-listed"
  | "episode-late"
  | "pending"
  | "elsewhere"
  | "other-account";

async function fakeEngine(
  putio: ReturnType<typeof fakePutio>,
  mode: Mode,
  convert?: ConvertMode,
) {
  let episodeLookups = 0;
  let playlists = 0;
  // File IDs StartPlaybackConversion was asked to convert, in order.
  const conversions: number[] = [];
  /** The converted upload's playlist, or the wrong one a `plays-` mode names. */
  const convertedUrl = (fileId: bigint) => {
    switch (convert) {
      case "plays-elsewhere":
        return `https://elsewhere.fixture.test/v2/files/${fileId}/hls/media.m3u8`;
      case "plays-mp4":
        return `${mediaOrigin}/v2/files/${fileId}/stream`;
      case "plays-other-file":
        return `${mediaOrigin}/v2/files/102/hls/media.m3u8`;
      case "plays-new-playlist":
        return `${mediaOrigin}/v2/files/${fileId}/hls/${++playlists}/media.m3u8`;
      default:
        return `${mediaOrigin}/v2/files/${fileId}/hls/media.m3u8`;
    }
  };
  const owned = (fileName: string) =>
    [...putio.files]
      .filter(([, file]) => file.name === fileName)
      .map(([id, file]) => ({
        id: BigInt(id),
        name: file.name,
        fileType: "VIDEO",
      }));
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.headers.authorization !== undefined ||
        request.headers["x-chill-stremio-credential"] !== credential
      ) {
        response.writeHead(401).end('{"code":"unauthenticated"}');
        return;
      }
      let body = "";
      for await (const chunk of request) body += String(chunk);
      response.setHeader("content-type", "application/json");
      switch (request.url?.split("/").at(-1)) {
        case "GetFolder": {
          const { id } = fromJsonString(proto.GetFolderRequestSchema, body);
          const folder = Number(id);
          if (folder !== 0 && putio.files.get(folder)?.fileType !== "FOLDER") {
            response.writeHead(404).end('{"code":"not_found"}');
            return;
          }
          const files =
            mode === "other-account" && folder === 0
              ? [101n, 909n].map((id) => ({
                  id,
                  name: "Root entry",
                  fileType: "FOLDER",
                }))
              : [...putio.files]
                  .filter(([, file]) => file.parent === folder)
                  .map(([id, file]) => ({
                    id: BigInt(id),
                    name: file.name,
                    fileType: file.fileType,
                  }));
          response.end(
            toJsonString(
              proto.GetFolderResponseSchema,
              create(proto.GetFolderResponseSchema, {
                parent: { id, fileType: "FOLDER" },
                files,
              }),
            ),
          );
          return;
        }
        case "GetMovies":
          response.end(
            toJsonString(
              proto.GetMoviesResponseSchema,
              create(proto.GetMoviesResponseSchema, {
                movies: [
                  {
                    id: "public-domain-film",
                    externalUrl: `https://www.imdb.com/title/${ownedTitle.imdbId}/`,
                    title: "Night of the Living Dead",
                    year: 1968,
                  },
                ],
              }),
            ),
          );
          return;
        case "Search": {
          const { query } = fromJsonString(proto.UserSearchRequestSchema, body);
          response.end(
            toJsonString(
              proto.SearchResponseSchema,
              create(proto.SearchResponseSchema, { query }),
            ),
          );
          return;
        }
        case "GetTVShowDetail": {
          const { imdbId } = fromJsonString(
            proto.GetTVShowDetailRequestSchema,
            body,
          );
          response.end(
            toJsonString(
              proto.GetTVShowDetailResponseSchema,
              create(proto.GetTVShowDetailResponseSchema, {
                show: { imdbId, title: "The Beverly Hillbillies", year: 1962 },
                seasons: [{ seasonNumber: 1 }],
              }),
            ),
          );
          return;
        }
        case "GetTVShowSeason": {
          const { imdbId, seasonNumber } = fromJsonString(
            proto.GetTVShowSeasonRequestSchema,
            body,
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
        case "FindOwnedVideos": {
          const { title, year, season, episode } = fromJsonString(
            proto.FindOwnedVideosRequestSchema,
            body,
          );
          let videos: ReturnType<typeof owned> = [];
          if (
            mode !== "never-listed" &&
            title === "Night of the Living Dead" &&
            year === 1968 &&
            !season
          )
            videos = owned(ownedTitle.fileName);
          if (
            title === "The Beverly Hillbillies" &&
            season === ownedEpisode.season &&
            episode === ownedEpisode.episode &&
            mode !== "episode-never-listed" &&
            // Indexed only by the second lookup.
            (mode !== "episode-late" || ++episodeLookups > 1)
          )
            videos = owned(ownedEpisode.fileName);
          response.end(
            toJsonString(
              proto.FindOwnedVideosResponseSchema,
              create(proto.FindOwnedVideosResponseSchema, { videos }),
            ),
          );
          return;
        }
        case "ResolvePlayback": {
          const { fileId } = fromJsonString(
            proto.ResolvePlaybackRequestSchema,
            body,
          );
          const id = Number(fileId);
          if (putio.matroska.has(id)) {
            if (convert === "read-only" && !putio.converting.has(id))
              putio.converting.set(id, 0);
            if (
              convert === "finishes-unseen" &&
              putio.status(id) === "CONVERTING"
            )
              putio.finish(id);
            // put.io's HLS answers conversion required until it converts.
            const status = putio.status(id);
            if (status === "NOT_AVAILABLE" || status === "IN_QUEUE") {
              response.end(
                '{"unavailable":{"reason":"UNAVAILABLE_REASON_CONVERSION_REQUIRED"}}',
              );
              return;
            }
            if (
              status !== "COMPLETED" ||
              (convert === "listed-late" &&
                (putio.completedReads.get(id) ?? 0) < 2)
            ) {
              response.end(
                '{"pending":{"reason":"PENDING_REASON_PROCESSING"}}',
              );
              return;
            }
          }
          if (mode === "pending") {
            response.end('{"pending":{"reason":"PENDING_REASON_PROCESSING"}}');
            return;
          }
          const origin =
            mode === "elsewhere"
              ? "https://elsewhere.fixture.test"
              : mediaOrigin;
          response.end(
            toJsonString(
              proto.ResolvePlaybackResponseSchema,
              create(proto.ResolvePlaybackResponseSchema, {
                result: {
                  case: "ready",
                  value: {
                    media: {
                      url: `${putio.matroska.has(id) ? convertedUrl(fileId) : `${origin}/v2/files/${fileId}/hls/media.m3u8`}?oauth_token=fixture-download-grant`,
                      expiry: { case: "expiryUnknown", value: true },
                    },
                  },
                },
              }),
            ),
          );
          return;
        }
        case "StartPlaybackConversion": {
          const id = Number(
            fromJsonString(proto.StartPlaybackConversionRequestSchema, body)
              .fileId,
          );
          conversions.push(id);
          const refused = convert === "selection";
          if (
            !refused &&
            convert !== "not-started" &&
            putio.matroska.has(id) &&
            !putio.converting.has(id)
          )
            putio.converting.set(id, 0);
          response.end(
            toJsonString(
              proto.StartPlaybackConversionResponseSchema,
              create(proto.StartPlaybackConversionResponseSchema, {
                result: refused
                  ? { case: "unavailable", value: { reason: 2 } }
                  : { case: "pending", value: { reason: 1 } },
              }),
            ),
          );
          return;
        }
        default:
          response.writeHead(404).end('{"code":"not_found"}');
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end('{"code":"internal"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const engineBaseUrl = `http://127.0.0.1:${address.port}`;
  const hosted = await startHostedAdapter({
    statusMedia: new Map(
      statusMediaKinds.map((kind) => [
        kind,
        {
          mp4: Buffer.from("fixture-status-video"),
          m3u8: Buffer.from(statusPlaylist(kind)),
          ts: Buffer.alloc(188 * 2, 0x47),
        },
      ]),
    ),
    engineBaseUrl,
    webOrigin: "http://127.0.0.1:3000",
  });
  return {
    engineBaseUrl,
    origin: hosted.origin,
    conversions,
    close: async () => {
      await hosted.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const Receipt = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    endpoint: Schema.String,
    proof: Schema.Struct({
      failureStage: Schema.optional(Schema.String),
      failureCode: Schema.optional(Schema.String),
      uploaded: Schema.optional(Schema.Boolean),
      listingPolls: Schema.optional(Schema.Number),
      uploadFileType: Schema.optional(Schema.String),
      episode: Schema.optional(
        Schema.Struct({
          listingPolls: Schema.optional(Schema.Number),
          ownedRows: Schema.optional(Schema.Number),
          headStatus: Schema.optional(Schema.Number),
          redirectStatus: Schema.optional(Schema.Number),
          locationMediaOrigin: Schema.optional(Schema.Boolean),
          locationHls: Schema.optional(Schema.Boolean),
          locationNamesFile: Schema.optional(Schema.Boolean),
          decode: Schema.optional(Schema.Struct({ frames: Schema.Number })),
        }),
      ),
      web: Schema.optional(
        Schema.Union([
          Schema.Literal("skipped"),
          Schema.Struct({
            status: Schema.optional(Schema.String),
            streamListings: Schema.optional(Schema.Number),
            selections: Schema.optional(Schema.Number),
            playlistResponses: Schema.optional(Schema.Number),
            segmentResponses: Schema.optional(Schema.Number),
            currentTime: Schema.optional(Schema.Array(Schema.Number)),
            decodedFrames: Schema.optional(Schema.Array(Schema.Number)),
            cleanup: Schema.Struct({
              browserClosed: Schema.Boolean,
              contextClosed: Schema.Boolean,
              webClosed: Schema.Boolean,
            }),
          }),
        ]),
      ),
      ownedRows: Schema.optional(Schema.Number),
      headStatus: Schema.optional(Schema.Number),
      redirectStatus: Schema.optional(Schema.Number),
      locationMediaOrigin: Schema.optional(Schema.Boolean),
      locationHls: Schema.optional(Schema.Boolean),
      locationNamesFile: Schema.optional(Schema.Boolean),
      decode: Schema.optional(
        Schema.Struct({
          frames: Schema.Number,
          codec: Schema.String,
          width: Schema.Number,
          height: Schema.Number,
          ms: Schema.Number,
        }),
      ),
      convert: Schema.optional(
        Schema.Union([
          Schema.Literal("skipped"),
          Schema.Struct({
            status: Schema.optional(Schema.String),
            uploadFileType: Schema.optional(Schema.String),
            readOnly: Schema.optional(
              Schema.Struct({
                metaStatus: Schema.Number,
                subtitlesStatus: Schema.Number,
                headStatus: Schema.Number,
                optionsStatus: Schema.Number,
                prefetchStatus: Schema.Number,
                mp4Status: Schema.Array(Schema.String),
              }),
            ),
            selectionStatus: Schema.optional(Schema.Number),
            selectionPreparing: Schema.optional(Schema.Boolean),
            started: Schema.optional(
              Schema.Struct({
                status: Schema.optional(Schema.String),
                reads: Schema.optional(Schema.Number),
                readErrors: Schema.Number,
              }),
            ),
            wait: Schema.optional(
              Schema.Struct({
                polls: Schema.optional(Schema.Number),
                reads: Schema.Record(
                  Schema.String,
                  Schema.Struct({
                    convert: Schema.Number,
                    preparing: Schema.Number,
                    empty: Schema.Number,
                    other: Schema.Number,
                  }),
                ),
                lastStatus: Schema.optional(Schema.String),
                lastPercent: Schema.optional(Schema.Number),
                readErrors: Schema.Number,
                finalStatus: Schema.optional(Schema.String),
              }),
            ),
            reselect: Schema.optional(
              Schema.Struct({
                status: Schema.Number,
                locationMediaOrigin: Schema.Boolean,
                locationHls: Schema.Boolean,
                locationNamesFile: Schema.Boolean,
                sameHls: Schema.Boolean,
              }),
            ),
            decode: Schema.optional(Schema.Struct({ frames: Schema.Number })),
            sizeExceeded: Schema.optional(Schema.Boolean),
            excessCharged: Schema.optional(Schema.Boolean),
          }),
        ]),
      ),
      absenceConfirmed: Schema.optional(Schema.Boolean),
      reservation: Schema.optional(
        Schema.Struct({ creations: Schema.Number, bytes: Schema.Number }),
      ),
    }),
    cleanup: Schema.Struct({
      status: Schema.String,
      pendingAcquisitions: Schema.Number,
    }),
  }),
);

async function runLane(
  mode: Mode,
  options: {
    /** Frames each decode reports, or a function of the decoded URL. */
    frames?: number | ((url: string) => number);
    reservedBytes?: number;
    provider?: (provider: OwnedProvider) => OwnedProvider;
    web?: OwnedOptions["web"];
    convert?: ConvertMode;
    /** The size put.io reports for its MP4 of the Matroska upload. */
    outputBytes?: number;
    convertSource?: OwnedConvert["source"];
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "live-owned-"));
  // Local upload sources that exist right now.
  const local = new Set(["movie.mp4"]);
  const putio = fakePutio(options.convert, options.outputBytes, (path) =>
    local.has(path),
  );
  const engine = await fakeEngine(putio, mode, options.convert);
  const decoded: string[] = [];
  let convertSourceRemoved = false;
  const convert: OwnedConvert | undefined = options.convert && {
    source:
      options.convertSource ??
      (() =>
        Effect.acquireRelease(
          Effect.sync(() => {
            local.add("convert.mkv");
            return { path: "convert.mkv", bytes: convertBytes };
          }),
          () =>
            Effect.sync(() => {
              local.delete("convert.mkv");
              convertSourceRemoved = true;
            }),
        )),
    settleMs: 1,
    started: { attempts: 3, intervalMs: 1 },
    ready: { attempts: 6, intervalMs: 1 },
  };
  try {
    await writeFile(
      join(directory, "allowance.json"),
      JSON.stringify({
        day: utcDay(),
        reservedTransfers: 2,
        reservedBytes: options.reservedBytes ?? 100,
      }),
      { mode: 0o600 },
    );
    const exit = await Effect.runPromiseExit(
      runOwnedPlayback({
        credential,
        origin: engine.origin,
        engineBaseUrl: engine.engineBaseUrl,
        mediaOrigin,
        username: "fixture",
        ledgerDirectory: async () => directory,
        provider: options.provider?.(putio.provider) ?? putio.provider,
        source: Effect.succeed({ path: "movie.mp4", bytes: sourceBytes }),
        // Any URL decodes, so only the lane's own checks can refuse one.
        decode: (url) =>
          Effect.sync(() => {
            decoded.push(url);
            return {
              frames:
                typeof options.frames === "function"
                  ? options.frames(url)
                  : (options.frames ?? 240),
              codec: "h264",
              width: 1280,
              height: 720,
            };
          }),
        artifact: join(directory, "artifact"),
        journal: join(directory, "recovery", "owned.json"),
        nonce,
        listing: { attempts: 3, intervalMs: 10 },
        web: options.web,
        convert,
      }),
    );
    const receiptText = await readFile(
      join(directory, "artifact", "results.json"),
      "utf8",
    );
    const journalPath = join(directory, "recovery", "owned.json");
    const journal = await readFile(journalPath, "utf8").catch(() => "");
    return {
      exit,
      putio,
      decoded,
      conversions: engine.conversions,
      convertSourceRemoved,
      receiptText,
      receipt: Schema.decodeUnknownSync(Receipt)(receiptText),
      journal,
      journalMode: journal ? (await stat(journalPath)).mode & 0o777 : 0,
      ledger: await readLedger(join(directory, "allowance.json")),
    };
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const assertPrivateReceipt = (text: string) => {
  for (const secret of [
    credential,
    "v4.local.",
    ownedTitle.fileName,
    "Night",
    ownedEpisode.fileName,
    "Hillbillies",
    nonce,
    "731001",
    "731002",
    "731003",
    "owned:",
    "http",
    "fixture-download-grant",
  ])
    assert.ok(!text.includes(secret), secret);
};

const assertCleaned = (run: Awaited<ReturnType<typeof runLane>>) => {
  assert.deepEqual(run.putio.deleted, [[731_001, 731_002, 731_003]]);
  assert.deepEqual([...run.putio.files.keys()], [101, 102]);
  assert.equal(run.receipt.proof.absenceConfirmed, true);
  assert.equal(run.receipt.cleanup.status, "acknowledged");
};

test("a video already in put.io and an owned episode play through the adapter and only their uploads are removed", async () => {
  const run = await runLane("playable");
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(run.receipt.status, "passed");
  assert.equal(run.receipt.endpoint, "override");
  assert.deepEqual(run.receipt.proof.reservation, {
    creations: 3,
    bytes: 2 * sourceBytes,
  });
  assert.equal(run.ledger.reservedTransfers, 2 + 3);
  assert.equal(run.ledger.reservedBytes, 100 + 2 * sourceBytes);
  assert.equal(run.receipt.proof.ownedRows, 1);
  assert.equal(run.receipt.proof.headStatus, 200);
  assert.equal(run.receipt.proof.redirectStatus, 302);
  assert.equal(run.receipt.proof.locationMediaOrigin, true);
  assert.equal(run.receipt.proof.locationHls, true);
  assert.equal(run.receipt.proof.locationNamesFile, true);
  const { ms, ...decoded } = run.receipt.proof.decode ?? { ms: -1 };
  assert.deepEqual(decoded, {
    frames: 240,
    codec: "h264",
    width: 1280,
    height: 720,
  });
  assert.ok(ms >= 0);
  assert.deepEqual(run.decoded, [
    `${mediaOrigin}/v2/files/731002/hls/media.m3u8?oauth_token=fixture-download-grant`,
    `${mediaOrigin}/v2/files/731003/hls/media.m3u8?oauth_token=fixture-download-grant`,
  ]);
  const episode = run.receipt.proof.episode;
  assert.equal(episode?.listingPolls, 1);
  assert.equal(episode?.ownedRows, 1);
  assert.equal(episode?.headStatus, 200);
  assert.equal(episode?.redirectStatus, 302);
  assert.equal(episode?.locationHls, true);
  assert.equal(episode?.locationNamesFile, true);
  assert.equal(episode?.decode?.frames, 240);
  assert.equal(run.receipt.proof.web, "skipped");
  assert.equal(run.receipt.proof.convert, "skipped");
  assertCleaned(run);
  assertPrivateReceipt(run.receiptText);
  assert.equal(run.journalMode, 0o600);
  assert.ok(
    run.journal.includes(`${liveVersions.folderPrefix}-owned-${nonce}`),
  );
});

for (const failure of [
  {
    mode: "pending",
    stage: "redirect",
    name: "a selection the adapter answers with a decodable status clip",
  },
  {
    mode: "elsewhere",
    stage: "redirect",
    name: "a selection redirected outside the put.io API origin",
  },
  {
    mode: "never-listed",
    stage: "listing",
    name: "a page that never lists the upload",
  },
] as const)
  test(`${failure.name} fails and still removes the uploads`, async () => {
    const run = await runLane(failure.mode);
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.status, "failed");
    assert.equal(run.receipt.proof.failureStage, failure.stage);
    assert.equal(
      run.receipt.proof.uploadFileType,
      failure.stage === "listing" ? "VIDEO" : undefined,
    );
    assert.deepEqual(run.decoded, []);
    assertCleaned(run);
    assertPrivateReceipt(run.receiptText);
  });

test("a selection that decodes no video frames fails", async () => {
  const run = await runLane("playable", { frames: 0 });
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "decode");
  assertCleaned(run);
});

test("an upload put.io still lists after deletion leaves cleanup uncertain", async () => {
  const run = await runLane("playable", {
    provider: (provider) => ({ ...provider, deleteFiles: () => Effect.void }),
  });
  assert.ok(Exit.isSuccess(run.exit), "playback itself passed");
  assert.equal(run.receipt.status, "failed");
  assert.equal(run.receipt.proof.absenceConfirmed, false);
  assert.equal(run.receipt.cleanup.status, "uncertain");
  assertPrivateReceipt(run.receiptText);
});

test("a failed upload still removes the run's folder", async () => {
  const run = await runLane("playable", {
    provider: (provider) => ({
      ...provider,
      uploadFile: () => Effect.fail(new Error("put.io HTTP 500")),
    }),
  });
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "upload");
  assert.deepEqual(run.putio.deleted, [[731_001]]);
  assert.deepEqual([...run.putio.files.keys()], [101, 102]);
  assert.equal(run.receipt.proof.absenceConfirmed, true);
});

for (const refusal of [
  { name: "an exhausted allowance", stage: "reservation" },
  { name: "a credential for another account", stage: "account-binding" },
] as const)
  test(`${refusal.name} stops before any upload`, async () => {
    const run = await runLane(
      refusal.stage === "reservation" ? "playable" : "other-account",
      refusal.stage === "reservation"
        ? { reservedBytes: liveVersions.byteLimit }
        : {},
    );
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, refusal.stage);
    assert.deepEqual(run.putio.deleted, []);
    assert.deepEqual([...run.putio.files.keys()], [101, 102]);
    assert.equal(run.ledger.reservedTransfers, 2);
    assert.equal(run.receipt.cleanup.status, "acknowledged");
  });

test("an episode page that never lists its upload fails after the movie and removes both", async () => {
  const run = await runLane("episode-never-listed");
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "episode-listing");
  assert.equal(run.receipt.proof.episode?.listingPolls, 3);
  assert.equal(run.decoded.length, 1, "only the movie decoded");
  assertCleaned(run);
  assertPrivateReceipt(run.receiptText);
});

test("an episode put.io indexes late is listed on a later poll", async () => {
  const run = await runLane("episode-late");
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(run.receipt.status, "passed");
  assert.equal(run.receipt.proof.episode?.listingPolls, 2);
  assert.equal(run.decoded.length, 2);
  assertCleaned(run);
});

test("the Stremio Web step runs only when LIVE_OWNED_WEB is 1", () => {
  for (const value of [undefined, "", "0", "true", "yes"])
    assert.equal(ownedWebStep(value), undefined, String(value));
  assert.equal(typeof ownedWebStep("1"), "function");
});

const webProof: OwnedWebProof = {
  client: "f".repeat(40),
  browser: "100.0.0.0",
  streamListings: 1,
  selections: 1,
  playlistResponses: 2,
  segmentResponses: 3,
  currentTime: [1.5, 3.5],
  decodedFrames: [36, 84],
  fixture: { width: 640, height: 360, markers: [2, 4] },
};

function fakeWeb(
  play: (input: OwnedWebInput) => OwnedWebProof = () => webProof,
  closes = true,
) {
  const calls: OwnedWebInput[] = [];
  const web: OwnedOptions["web"] = (input) =>
    Effect.sync(() => {
      calls.push(input);
      input.onStage("playback");
      Object.assign(input.cleanup, {
        browserClosed: closes,
        contextClosed: true,
        webClosed: true,
      });
      return play(input);
    });
  return { calls, web };
}

test("the Stremio Web step plays the listed movie row and keeps the receipt private", async () => {
  const browser = fakeWeb((input) => {
    // Fields the receipt does not name stay out of it.
    const played = { ...webProof, mediaUrl: input.selectedUrl };
    return played;
  });
  const run = await runLane("playable", { web: browser.web });
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(run.receipt.status, "passed");
  assert.equal(browser.calls.length, 1);
  const [input] = browser.calls;
  assert.ok(input);
  assert.equal(input.stremioId, ownedTitle.imdbId);
  assert.equal(input.credential, credential);
  assert.ok(input.manifestUrl.endsWith(`/s/${credential}/manifest.json`));
  assert.equal(
    input.streamPath,
    `/s/${credential}/stream/movie/${ownedTitle.imdbId}.json`,
  );
  assert.ok(
    decodeURIComponent(input.selectedUrl).endsWith("/owned:731002.m3u8"),
  );
  assert.deepEqual(input.listing, { attempts: 3, intervalMs: 10 });
  const web = run.receipt.proof.web;
  assert.ok(web && web !== "skipped");
  assert.equal(web.status, "passed");
  assert.equal(web.segmentResponses, 3);
  assert.deepEqual(web.decodedFrames, [36, 84]);
  assertCleaned(run);
  assertPrivateReceipt(run.receiptText);
});

for (const failure of [
  {
    name: "a Web step that fails with the credential in its error",
    stage: "web-playback",
    web: fakeWeb((input) => {
      throw new Error(`${input.manifestUrl} ${input.selectedUrl}`);
    }),
  },
  {
    name: "a Web step that saw no put.io segment",
    stage: "web-proof",
    web: fakeWeb(() => ({ ...webProof, segmentResponses: 0 })),
  },
  {
    name: "a Web step whose time did not advance",
    stage: "web-proof",
    web: fakeWeb(() => ({ ...webProof, currentTime: [2, 2] })),
  },
  {
    name: "a Web step that selected no row",
    stage: "web-proof",
    web: fakeWeb(() => ({ ...webProof, selections: 0 })),
  },
  {
    name: "a Web step that saw no put.io playlist",
    stage: "web-proof",
    web: fakeWeb(() => ({ ...webProof, playlistResponses: 0 })),
  },
  {
    name: "a Web step that decoded no new frame",
    stage: "web-proof",
    web: fakeWeb(() => ({ ...webProof, decodedFrames: [84, 84] })),
  },
  {
    name: "a Web step whose fixture marker did not advance",
    stage: "web-proof",
    web: fakeWeb(() => ({
      ...webProof,
      fixture: { ...webProof.fixture, markers: [4, 4] },
    })),
  },
  {
    name: "a Web step that left Chromium open",
    stage: "web-cleanup",
    web: fakeWeb(undefined, false),
  },
] as const)
  test(`${failure.name} fails and still removes both uploads`, async () => {
    const run = await runLane("playable", { web: failure.web.web });
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.status, "failed");
    assert.equal(run.receipt.proof.failureStage, failure.stage);
    assert.equal(run.decoded.length, 2, "FFmpeg proof ran first");
    assertCleaned(run);
    assertPrivateReceipt(run.receiptText);
  });

test("the convert step runs only when LIVE_OWNED_CONVERT is 1", () => {
  for (const value of [undefined, "", "0", "true", " 1x"])
    assert.equal(ownedConvertStep(value), undefined, String(value));
  assert.equal(typeof ownedConvertStep("1")?.source, "function");
});

const libraryId = 731_004;

const convertProof = (run: Awaited<ReturnType<typeof runLane>>) => {
  const convert = run.receipt.proof.convert;
  assert.ok(convert && convert !== "skipped");
  return convert;
};

const assertConvertCleaned = (run: Awaited<ReturnType<typeof runLane>>) => {
  assert.deepEqual(run.putio.deleted, [[731_001, 731_002, 731_003, libraryId]]);
  assert.deepEqual([...run.putio.files.keys()], [101, 102]);
  assert.equal(run.receipt.proof.absenceConfirmed, true);
  assert.equal(run.receipt.cleanup.status, "acknowledged");
  assert.equal(run.convertSourceRemoved, true);
  for (const secret of [String(libraryId), "chill:file", "chill%3Afile"])
    assert.ok(!run.receiptText.includes(secret), secret);
};

test("a library Matroska upload converts once when its Convert row is selected, then plays", async () => {
  const run = await runLane("playable", { convert: "converts" });
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(run.receipt.status, "passed");
  // Listings, read-only requests, the title rows and the reselection never convert.
  assert.deepEqual(run.conversions, [libraryId]);
  const reservation = {
    creations: 5,
    bytes: 2 * sourceBytes + convertBytes + liveVersions.convertOutputBytes,
  };
  assert.deepEqual(run.receipt.proof.reservation, reservation);
  assert.equal(run.ledger.reservedTransfers, 2 + 5);
  assert.equal(run.ledger.reservedBytes, 100 + reservation.bytes);
  assert.deepEqual(run.putio.uploads.at(-1), {
    path: "convert.mkv",
    name: `${liveVersions.folderPrefix}-owned-${nonce}.mkv`,
    mediaType: "video/x-matroska",
    present: true,
  });
  const convert = convertProof(run);
  assert.equal(convert.status, "passed");
  assert.deepEqual(convert.readOnly, {
    metaStatus: 200,
    subtitlesStatus: 200,
    headStatus: 200,
    optionsStatus: 204,
    prefetchStatus: 204,
    mp4Status: ["NOT_AVAILABLE", "NOT_AVAILABLE"],
  });
  assert.equal(convert.selectionStatus, 302);
  assert.equal(convert.selectionPreparing, true);
  assert.equal(convert.started?.status, "IN_QUEUE");
  assert.equal(convert.started?.readErrors, 0);
  // The fake Engine answers a queued upload as conversion required, so the
  // library offers Convert, and a converting one as pending, so it lists the
  // preparing row.
  assert.deepEqual(convert.wait?.reads, {
    IN_QUEUE: { convert: 1, preparing: 0, empty: 0, other: 0 },
    CONVERTING: { convert: 0, preparing: 1, empty: 0, other: 0 },
  });
  assert.equal(convert.wait?.readErrors, 0);
  assert.equal(convert.wait?.finalStatus, "COMPLETED");
  assert.deepEqual(convert.reselect, {
    status: 302,
    locationMediaOrigin: true,
    locationHls: true,
    locationNamesFile: true,
    sameHls: true,
  });
  assert.equal(convert.decode?.frames, 240);
  assert.equal(convert.sizeExceeded, undefined);
  assert.equal(
    run.decoded.at(-1),
    `${mediaOrigin}/v2/files/${libraryId}/hls/media.m3u8?oauth_token=fixture-download-grant`,
  );
  assertConvertCleaned(run);
  assertPrivateReceipt(run.receiptText);
});

for (const timing of [
  {
    convert: "listed-late",
    name: "that put.io reports completed before the library lists it",
    completedReads: 3,
    completedLists: { convert: 0, preparing: 1, empty: 0, other: 0 },
  },
  {
    convert: "finishes-unseen",
    name: "that put.io finishes after a poll's MP4 read",
    completedReads: 1,
    completedLists: undefined,
  },
] as const)
  test(`an MP4 larger than the reserved ceiling ${timing.name} charges its excess once`, async () => {
    const run = await runLane("playable", {
      convert: timing.convert,
      outputBytes: liveVersions.convertOutputBytes + mib,
    });
    assert.equal(run.receipt.status, "passed");
    assert.equal(
      run.putio.completedReads.get(libraryId),
      timing.completedReads,
    );
    const convert = convertProof(run);
    assert.deepEqual(convert.wait?.reads.COMPLETED, timing.completedLists);
    assert.equal(convert.wait?.finalStatus, "COMPLETED");
    assert.equal(convert.sizeExceeded, true);
    assert.equal(convert.excessCharged, true);
    assert.equal(
      run.ledger.reservedBytes,
      100 + (run.receipt.proof.reservation?.bytes ?? 0) + mib,
    );
  });

const reselect = {
  status: 302,
  locationMediaOrigin: true,
  locationHls: true,
  locationNamesFile: true,
  sameHls: true,
};

for (const failure of [
  {
    convert: "plays-elsewhere",
    check: "locationMediaOrigin",
    name: "outside the put.io API origin",
  },
  { convert: "plays-mp4", check: "locationHls", name: "to a file stream" },
  {
    convert: "plays-other-file",
    check: "locationNamesFile",
    name: "to another file's playlist",
  },
  {
    convert: "plays-new-playlist",
    check: "sameHls",
    name: "to a playlist the library did not list",
  },
] as const)
  test(`a converted video whose reselection redirects ${failure.name} fails before decoding`, async () => {
    const run = await runLane("playable", { convert: failure.convert });
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, "convert-reselect");
    assert.deepEqual(convertProof(run).reselect, {
      ...reselect,
      [failure.check]: false,
    });
    assert.equal(run.decoded.length, 2, "only the title uploads decoded");
    assertConvertCleaned(run);
    assertPrivateReceipt(run.receiptText);
  });

test("a converted video that decodes no frames fails", async () => {
  const run = await runLane("playable", {
    convert: "converts",
    frames: (url) => (url.includes(`/files/${libraryId}/`) ? 0 : 240),
  });
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "convert-decode");
  const convert = convertProof(run);
  assert.deepEqual(convert.reselect, reselect);
  assert.equal(convert.decode?.frames, 0);
  assert.equal(run.decoded.length, 3);
  assertConvertCleaned(run);
  assertPrivateReceipt(run.receiptText);
});

/**
 * Fails the probe's MP4 reads at these 1-based positions with `code`. In the
 * converts mode reads 1 and 2 precede the selection and 3 waits for put.io to
 * start; a failed read leaves the fake's script where it was.
 */
const failingReads =
  (positions: readonly number[], code: Mp4StatusFailure["code"]) =>
  (provider: OwnedProvider): OwnedProvider => {
    let reads = 0;
    return {
      ...provider,
      mp4Status: (id) =>
        Effect.suspend(() =>
          positions.includes(++reads)
            ? Effect.fail(new Mp4StatusFailure({ code }))
            : provider.mp4Status(id),
        ),
    };
  };

test("MP4 reads that fail while put.io converts are retried unless three fail in a row", async () => {
  const run = await runLane("playable", {
    convert: "converts",
    // One wait for the start, two library polls, then the final read.
    provider: failingReads([3, 5, 6, 10], "mp4_request"),
  });
  assert.equal(run.receipt.status, "passed");
  const convert = convertProof(run);
  assert.equal(convert.started?.readErrors, 1);
  assert.equal(convert.started?.reads, 2);
  assert.equal(convert.wait?.readErrors, 3);
  assert.equal(convert.wait?.polls, 5, "failed reads use up polls");
  assert.equal(convert.wait?.finalStatus, "COMPLETED");
  assert.equal(convert.decode?.frames, 240);
});

for (const failure of [
  {
    name: "an MP4 read that fails before the selection",
    positions: [1],
    code: "mp4_request",
    stage: "convert-read-only",
    conversions: [],
  },
  {
    name: "three failed MP4 reads in a row while put.io starts",
    positions: [3, 4, 5],
    code: "mp4_request",
    stage: "convert-not-started",
    conversions: [libraryId],
  },
  {
    name: "three failed MP4 reads in a row while put.io converts",
    positions: [4, 5, 6],
    code: "mp4_request",
    stage: "convert-wait",
    conversions: [libraryId],
  },
  {
    name: "an MP4 status for another file",
    positions: [4],
    code: "mp4_id_mismatch",
    stage: "convert-wait",
    conversions: [libraryId],
  },
] as const)
  test(`${failure.name} fails with its code and still removes every upload`, async () => {
    const run = await runLane("playable", {
      convert: "converts",
      provider: failingReads(failure.positions, failure.code),
    });
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, failure.stage);
    assert.equal(run.receipt.proof.failureCode, failure.code);
    assert.deepEqual(run.conversions, failure.conversions);
    const convert = convertProof(run);
    if (failure.stage !== "convert-read-only")
      assert.equal(
        (failure.stage === "convert-wait" ? convert.wait : convert.started)
          ?.readErrors,
        failure.positions.length,
      );
    assertConvertCleaned(run);
    assertPrivateReceipt(run.receiptText);
  });

test("a Matroska copy that fails its check stops before any upload", async () => {
  const run = await runLane("playable", {
    convert: "converts",
    convertSource: () => Effect.fail(new Error("ffprobe found no Matroska")),
  });
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "convert-source");
  assert.deepEqual(run.putio.uploads, []);
  assert.equal(run.ledger.reservedTransfers, 2);
  assert.equal(run.receipt.cleanup.status, "acknowledged");
});

for (const failure of [
  {
    convert: "not-required",
    stage: "convert-not-required",
    conversions: [],
    name: "a Matroska upload put.io streams as uploaded",
  },
  {
    convert: "read-only",
    stage: "convert-read-only",
    conversions: [],
    name: "a conversion that starts before the row is selected",
  },
  {
    convert: "selection",
    stage: "convert-selection",
    conversions: [libraryId],
    name: "a conversion Engine refuses to start",
  },
  {
    convert: "not-started",
    stage: "convert-not-started",
    conversions: [libraryId],
    name: "a selection put.io never starts converting",
  },
  {
    convert: "timeout",
    stage: "convert-timeout",
    conversions: [libraryId],
    name: "a conversion that outlasts the wait",
  },
  {
    convert: "error",
    stage: "convert-error",
    conversions: [libraryId],
    name: "a conversion put.io reports failed",
  },
] as const)
  test(`${failure.name} fails and still removes every upload`, async () => {
    const run = await runLane("playable", { convert: failure.convert });
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.status, "failed");
    assert.equal(run.receipt.proof.failureStage, failure.stage);
    assert.deepEqual(run.conversions, failure.conversions);
    assert.equal(run.decoded.length, 2, "only the title uploads decoded");
    if (failure.stage === "convert-timeout")
      assert.deepEqual(
        [
          convertProof(run).wait?.lastStatus,
          convertProof(run).wait?.lastPercent,
        ],
        ["CONVERTING", 50],
      );
    assertConvertCleaned(run);
    assertPrivateReceipt(run.receiptText);
  });

test("the browser image carries the Playwright release the harness pins", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const tag =
    /^FROM mcr\.microsoft\.com\/playwright:v(\S+)-noble@sha256:[0-9a-f]{64} AS browser$/m.exec(
      dockerfile,
    )?.[1];
  assert.equal(tag, versions.playwright);
});
