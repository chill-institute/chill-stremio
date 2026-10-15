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
  ownedEpisode,
  ownedTitle,
  ownedWebStep,
  runOwnedPlayback,
  type OwnedOptions,
  type OwnedProvider,
  type OwnedWebInput,
  type OwnedWebProof,
} from "../harness/live/owned.ts";
import { liveVersions } from "../harness/live/versions.ts";
import { versions } from "../harness/versions.ts";
import { startHostedAdapter } from "../src/hosted.ts";
import { statusMediaKinds, statusPlaylist } from "../src/status-media.ts";

const credential = `v4.local.${"O".repeat(300)}`;
const nonce = "0".repeat(32);
const mediaOrigin = "https://media.fixture.test";
const sourceBytes = 1234;

function fakePutio() {
  // Parent folder by file ID; 0 is the account root.
  const files = new Map<number, { name: string; parent: number }>([
    [101, { name: "Existing folder", parent: 0 }],
    [102, { name: "Existing video.mkv", parent: 0 }],
  ]);
  const deleted: number[][] = [];
  let next = 731_001;
  const add = (name: string, parent: number) => {
    const id = next++;
    files.set(id, { name, parent });
    return { id };
  };
  const provider: OwnedProvider = {
    accountInfo: () => Effect.succeed({ username: "fixture" }),
    listFolderIds: (id) =>
      Effect.sync(() =>
        [...files].filter(([, file]) => file.parent === id).map(([id]) => id),
      ),
    createFolder: (name) => Effect.sync(() => add(name, 0)),
    uploadFile: (_path, name, parent) => Effect.sync(() => add(name, parent)),
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
  };
  return { files, deleted, provider };
}

type Mode =
  | "playable"
  | "never-listed"
  | "episode-never-listed"
  | "episode-late"
  | "pending"
  | "elsewhere"
  | "other-account";

async function fakeEngine(putio: ReturnType<typeof fakePutio>, mode: Mode) {
  let episodeLookups = 0;
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
          assert.equal(
            fromJsonString(proto.GetFolderRequestSchema, body).id,
            0n,
          );
          const root = [...putio.files]
            .filter(([, file]) => file.parent === 0)
            .map(([id]) => BigInt(id));
          response.end(
            toJsonString(
              proto.GetFolderResponseSchema,
              create(proto.GetFolderResponseSchema, {
                parent: { id: 0n, fileType: "FOLDER" },
                files: (mode === "other-account" ? [101n, 909n] : root).map(
                  (id) => ({ id, name: "Root entry", fileType: "FOLDER" }),
                ),
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
                      url: `${origin}/v2/files/${fileId}/hls/media.m3u8?oauth_token=fixture-download-grant`,
                      expiry: { case: "expiryUnknown", value: true },
                    },
                  },
                },
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
      uploaded: Schema.optional(Schema.Boolean),
      listingPolls: Schema.optional(Schema.Number),
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
    frames?: number;
    reservedBytes?: number;
    provider?: (provider: OwnedProvider) => OwnedProvider;
    web?: OwnedOptions["web"];
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "live-owned-"));
  const putio = fakePutio();
  const engine = await fakeEngine(putio, mode);
  const decoded: string[] = [];
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
              frames: options.frames ?? 240,
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

test("the browser image carries the Playwright release the harness pins", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const tag =
    /^FROM mcr\.microsoft\.com\/playwright:v(\S+)-noble@sha256:[0-9a-f]{64} AS browser$/m.exec(
      dockerfile,
    )?.[1];
  assert.equal(tag, versions.playwright);
});
