import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import * as proto from "@chill-institute/contracts/chill/v4/api_pb";
import { Effect, Exit, Schema } from "effect";
import { test, vi } from "vite-plus/test";
import {
  AllowanceFailure,
  readLedger,
  reserve,
  utcDay,
} from "../harness/live/allowance.ts";
import {
  namedEpisode,
  runAcquisition,
  type AcquireProvider,
} from "../harness/live/acquire.ts";
import { listFolder, listFolderIds } from "../harness/live/putio.ts";
import { liveVersions } from "../harness/live/versions.ts";

const credential = `v4.local.${"A".repeat(300)}`;
const imdbId = "tt0000001";
const releaseId = "00000000-0000-4000-8000-000000000001";
const decoyReleaseId = "00000000-0000-4000-8000-000000000002";
const packReleaseId = "00000000-0000-4000-8000-000000000003";
const maxBytes = "987654";
const episodePin = { imdbId, releaseId, episode: "1:2", maxBytes };
const packPin = {
  imdbId,
  releaseId: `pack:${packReleaseId}`,
  episode: "1:2",
  maxBytes,
};
const episodeTarget = `chill:episode:${imdbId}:1:2`;
const mediaOrigin = "https://media.fixture.test";
const folder = 73_101_101;
const baselineTransfer = 73_101_501;
const baselineFile = 73_101_601;
const newTransfer = 73_101_701;
const strayTransfer = 73_101_702;
const newFile = 73_101_801;
// A season folder's entries; the second episode is the pinned one.
const packFirstEpisode = 73_101_811;
const packPinnedEpisode = 73_101_812;
const packSampleFolder = 73_101_813;
const packSampleVideo = 73_101_814;
const packInfo = 73_101_815;
const seededBytes = 100;

interface FakeTransfer {
  id: number;
  status: string;
  size: number;
  file_id: number | null;
  save_parent_id: number;
  created_at: string;
}

interface FakeOptions {
  /** How far put.io's clock is ahead of this host's. */
  skewMs?: number;
  /** Runs before each transfer listing; "fail" answers it with an error. */
  onList?: (
    call: number,
    transfers: Map<number, FakeTransfer>,
  ) => "fail" | undefined;
  /** How many reads of the new file answer 404 before it appears. */
  fileMisses?: number;
  /** What the new transfer saves: one video (the default) or a season folder. */
  saved?: "video" | "season";
  /** The saved video's name. */
  videoName?: string;
  /** The file the adapter plays; defaults to the saved video or pinned episode. */
  played?: number;
  /** Deleting a folder leaves its entries behind. */
  orphanEntries?: boolean;
  /** Folder reads answer with an error. */
  folderFails?: boolean;
  /** The transfer saves entries dated before the run, as a retained file is. */
  savedBefore?: boolean;
}

interface FakeFile {
  parent: number;
  created: string;
  name: string;
  type: "FOLDER" | "VIDEO" | "FILE";
}

function fakePutio(options: FakeOptions = {}) {
  const providerNow = () =>
    new Date(Date.now() + (options.skewMs ?? 0)).toISOString().slice(0, 19);
  let lists = 0;
  let fileMisses = options.fileMisses ?? 0;
  const old = "2020-01-01T00:00:00";
  const files = new Map<number, FakeFile>([
    [folder, { parent: 0, created: old, name: "Root entry", type: "FOLDER" }],
    [
      baselineFile,
      {
        parent: folder,
        created: old,
        name: "Fixture.Show.S01E02.720p.mkv",
        type: "VIDEO",
      },
    ],
  ]);
  const transfers = new Map<number, FakeTransfer>([
    [
      baselineTransfer,
      {
        id: baselineTransfer,
        status: "COMPLETED",
        size: 4321,
        file_id: baselineFile,
        save_parent_id: folder,
        created_at: "2020-01-01T00:00:00",
      },
    ],
  ]);
  const events: string[] = [];
  const cancelled: number[][] = [];
  const deleted: number[][] = [];
  const provider: AcquireProvider = {
    accountInfo: () =>
      Effect.sync(() => {
        events.push("account");
        return { username: "fixture" };
      }),
    listFolderIds: (id) =>
      Effect.sync(() =>
        [...files].filter(([, file]) => file.parent === id).map(([id]) => id),
      ),
    listTransfers: () =>
      Effect.suspend(() => {
        events.push("list");
        if (options.onList?.(++lists, transfers) === "fail")
          return Effect.fail(new Error("put.io HTTP 502"));
        return Effect.succeed(
          [...transfers.values()].map((transfer) => ({ ...transfer })),
        );
      }),
    serverTime: () => Effect.sync(() => Date.now() + (options.skewMs ?? 0)),
    getTransfer: (id) =>
      Effect.suspend(() => {
        const transfer = transfers.get(id);
        return transfer
          ? Effect.succeed({ ...transfer })
          : Effect.fail(new Error("put.io HTTP 404"));
      }),
    // Cancel only stops a seeding transfer; otherwise it drops the transfer
    // from the list. Files stay either way.
    cancelTransfers: (ids) =>
      Effect.sync(() => {
        events.push("cancel");
        cancelled.push([...ids]);
        for (const id of ids) {
          const transfer = transfers.get(id);
          if (transfer?.status === "SEEDING") transfer.status = "COMPLETED";
          else transfers.delete(id);
        }
      }),
    getFile: (id) =>
      Effect.sync(() => {
        const file = files.get(id);
        if (file && id === newFile && fileMisses > 0) {
          fileMisses--;
          return undefined;
        }
        return file
          ? {
              id,
              name: file.name,
              parentId: file.parent,
              createdAt: file.created,
              fileType: file.type,
            }
          : undefined;
      }),
    listFolder: (id) =>
      Effect.suspend(() => {
        events.push("folder");
        if (options.folderFails)
          return Effect.fail(new Error("put.io HTTP 502"));
        return Effect.succeed(
          [...files]
            .filter(([, file]) => file.parent === id)
            .map(([id, file]) => ({
              id,
              name: file.name,
              fileType: file.type,
            })),
        );
      }),
    // Deleting a folder deletes everything under it.
    deleteFiles: (ids) =>
      Effect.sync(() => {
        events.push("delete");
        deleted.push([...ids]);
        const remove = (id: number) => {
          files.delete(id);
          if (options.orphanEntries) return;
          for (const [child, file] of files)
            if (file.parent === id) remove(child);
        };
        for (const id of ids) remove(id);
      }),
    fileAbsent: (id) => Effect.sync(() => !files.has(id)),
  };
  const createTransfer = (id: number, size: number) =>
    transfers.set(id, {
      id,
      status: "DOWNLOADING",
      size,
      file_id: null,
      save_parent_id: folder,
      created_at: providerNow(),
    });
  const complete = (id: number) => {
    const transfer = transfers.get(id);
    if (!transfer || transfer.file_id) return;
    const created = options.savedBefore ? old : providerNow();
    const save = (
      id: number,
      parent: number,
      name: string,
      type: FakeFile["type"],
    ) => files.set(id, { parent, created, name, type });
    if (options.saved === "season") {
      save(newFile, folder, "Fixture.Show.S01.1080p", "FOLDER");
      save(packFirstEpisode, newFile, "Fixture.Show.S01E01.1080p.mkv", "VIDEO");
      save(
        packPinnedEpisode,
        newFile,
        "Fixture.Show.S01E02.1080p.mkv",
        "VIDEO",
      );
      save(packSampleFolder, newFile, "Sample", "FOLDER");
      save(packSampleVideo, packSampleFolder, "sample.mkv", "VIDEO");
      save(packInfo, newFile, "Fixture.Show.S01.nfo", "FILE");
    } else
      save(
        newFile,
        folder,
        options.videoName ?? "Fixture.Movie.2020.1080p.mkv",
        "VIDEO",
      );
    Object.assign(transfer, { status: "SEEDING", file_id: newFile });
  };
  const played = () =>
    options.played ??
    (options.saved === "season" ? packPinnedEpisode : newFile);
  return {
    files,
    transfers,
    events,
    cancelled,
    deleted,
    provider,
    createTransfer,
    complete,
    played,
  };
}

type Hop =
  | "status"
  | "pending"
  | "media"
  | "media-notice"
  | "refuse"
  | `notice:${string}`;

interface Script {
  /**
   * "swapped" lists each series release under the other row's name;
   * "other-episode" and "movie-path" list the pinned releases with another
   * episode's target or under the movie path.
   */
  rows?: "pinned" | "missing" | "swapped" | "other-episode" | "movie-path";
  /** Status URLs carry the episode, as the adapter's do for a season pack. */
  statusEpisode?: boolean;
  play?: "status" | "reuse" | "lost" | "direct" | "direct-ambiguous";
  hops?: Hop[];
  /** What status reads answer once `hops` runs out. */
  rest?: Hop;
  size?: number;
}

async function fakeServices(
  putio: ReturnType<typeof fakePutio>,
  script: Script,
) {
  const requests: { method: string; path: string }[] = [];
  const hops = [...(script.hops ?? ["media"])];
  let wait = 1;
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({
        method: request.method ?? "",
        path: `${url.pathname}${url.search}`,
      });
      const base = `http://${request.headers.host}/s/${credential}`;
      const statusUrl = (wait: number) =>
        `${base}/status/${newTransfer}${script.statusEpisode ? "/1/2" : ""}.m3u8?wait=${wait}`;
      const redirect = (location: string) =>
        response.writeHead(302, { Location: location }).end();
      const media = () => {
        putio.complete(newTransfer);
        return `${mediaOrigin}/v2/files/${putio.played()}/hls/media.m3u8?oauth_token=fixture-grant`;
      };
      if (!url.pathname.startsWith("/s/")) {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        assert.equal(request.headers["x-chill-stremio-credential"], credential);
        assert.equal(url.pathname.split("/").at(-1), "GetFolder");
        assert.equal(fromJsonString(proto.GetFolderRequestSchema, body).id, 0n);
        response.setHeader("content-type", "application/json");
        response.end(
          toJsonString(
            proto.GetFolderResponseSchema,
            create(proto.GetFolderResponseSchema, {
              parent: { id: 0n, fileType: "FOLDER" },
              files: [...putio.files]
                .filter(([, file]) => file.parent === 0)
                .map(([id]) => ({
                  id: BigInt(id),
                  name: "Root entry",
                  fileType: "FOLDER",
                })),
            }),
          ),
        );
        return;
      }
      const path = url.pathname.slice(`/s/${credential}`.length);
      if (path === `/stream/movie/${imdbId}.json`) {
        const play = (release: string) =>
          `${base}/play/movie/${imdbId}/${release}.m3u8`;
        const streams = [
          {
            name: "Download to put.io",
            title: "Decoy",
            url: play(decoyReleaseId),
          },
          ...(script.rows === "missing"
            ? []
            : [
                {
                  name: "Download to put.io",
                  title: "Fixture",
                  url: play(releaseId),
                },
              ]),
        ];
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ streams }));
        return;
      }
      if (path === `/stream/series/${imdbId}:1:2.json`) {
        const play = (release: string, decoy = false) =>
          `${base}/play/${!decoy && script.rows === "movie-path" ? "movie" : "series"}/${encodeURIComponent(
            !decoy && script.rows === "other-episode"
              ? `chill:episode:${imdbId}:1:3`
              : episodeTarget,
          )}/${encodeURIComponent(release)}.m3u8`;
        const swapped = script.rows === "swapped";
        const streams = [
          {
            name: "Download to put.io",
            title: "Decoy",
            url: play(decoyReleaseId, true),
          },
          ...(script.rows === "missing"
            ? []
            : [
                {
                  name: swapped
                    ? "Download season to put.io"
                    : "Download to put.io",
                  title: "Fixture",
                  url: play(releaseId),
                },
                {
                  name: swapped
                    ? "Download to put.io"
                    : "Download season to put.io",
                  title: "Season 1 pack",
                  url: play(`pack:${packReleaseId}`),
                },
              ]),
        ];
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ streams }));
        return;
      }
      if (path.startsWith("/play/")) {
        if (request.method === "HEAD") {
          response.writeHead(200).end();
          return;
        }
        const size = script.size ?? 4321;
        switch (script.play ?? "status") {
          case "status":
            putio.createTransfer(newTransfer, size);
            return redirect(statusUrl(1));
          case "reuse":
            return redirect(`${base}/status/${baselineTransfer}.m3u8?wait=1`);
          case "lost":
            putio.createTransfer(newTransfer, size);
            return redirect(`${base}/notice/unknown.m3u8`);
          case "direct":
            putio.createTransfer(newTransfer, size);
            return redirect(media());
          case "direct-ambiguous":
            putio.createTransfer(newTransfer, size);
            putio.createTransfer(strayTransfer, size);
            return redirect(media());
        }
      }
      if (path.startsWith("/status/")) {
        const hop = hops.shift() ?? script.rest ?? "media";
        if (hop === "status") return redirect(statusUrl(Math.min(++wait, 5)));
        if (hop === "pending") return redirect(`${base}/notice/pending.m3u8`);
        if (hop === "refuse") {
          response.writeHead(503).end();
          return;
        }
        if (hop === "media") return redirect(media());
        if (hop === "media-notice") {
          putio.complete(newTransfer);
          return redirect(`${mediaOrigin}/notice/pending.m3u8`);
        }
        return redirect(`${base}/notice/${hop.slice("notice:".length)}.m3u8`);
      }
      response.writeHead(404).end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
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
    proof: Schema.Struct({
      failureStage: Schema.optional(Schema.String),
      pinnedRow: Schema.optional(Schema.Boolean),
      reserved: Schema.optional(Schema.Boolean),
      headStatus: Schema.optional(Schema.Number),
      attribution: Schema.optional(Schema.String),
      statusHops: Schema.Number,
      pendingNotices: Schema.Number,
      statusRefusals: Schema.optional(Schema.Number),
      sizeBucket: Schema.optional(Schema.String),
      sizeExceeded: Schema.optional(Schema.Boolean),
      excessCharged: Schema.optional(Schema.Boolean),
      locationMediaOrigin: Schema.optional(Schema.Boolean),
      locationHls: Schema.optional(Schema.Boolean),
      locationNamesFile: Schema.optional(Schema.Boolean),
      release: Schema.optional(Schema.String),
      playedInTransfer: Schema.optional(Schema.Boolean),
      playedEpisodeMatches: Schema.optional(Schema.Boolean),
      packVideos: Schema.optional(Schema.Number),
      selectionToFirstStatusMs: Schema.optional(Schema.Number),
      selectionToCompletionMs: Schema.optional(Schema.Number),
      selectionToMediaMs: Schema.optional(Schema.Number),
      transferFilesRecorded: Schema.optional(Schema.Number),
      decode: Schema.optional(
        Schema.Struct({
          frames: Schema.Number,
          codec: Schema.String,
          width: Schema.Number,
          height: Schema.Number,
          ms: Schema.Number,
        }),
      ),
    }),
    cleanup: Schema.Struct({
      status: Schema.String,
      pendingAcquisitions: Schema.Number,
      verification: Schema.optional(Schema.String),
    }),
  }),
);

type Decode = number | "fail" | "hang";

async function runLane(
  script: Script,
  options: {
    pin?: {
      imdbId?: string;
      releaseId?: string;
      episode?: string;
      maxBytes?: string;
    };
    decode?: Decode;
    reservedBytes?: number;
    acquisitionMs?: number;
    putio?: FakeOptions;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "live-acquire-"));
  const putio = fakePutio(options.putio);
  const services = await fakeServices(putio, script);
  const decoded: string[] = [];
  const decode = options.decode ?? 240;
  try {
    await writeFile(
      join(directory, "allowance.json"),
      JSON.stringify({
        day: utcDay(),
        reservedTransfers: 2,
        reservedBytes: options.reservedBytes ?? seededBytes,
      }),
      { mode: 0o600 },
    );
    const exit = await Effect.runPromiseExit(
      runAcquisition({
        credential,
        origin: services.origin,
        engineBaseUrl: services.origin,
        mediaOrigin,
        username: "fixture",
        pin: options.pin ?? { imdbId, releaseId, maxBytes },
        ledgerDirectory: async () => directory,
        provider: putio.provider,
        // Any URL decodes, so only the lane's own checks can refuse one.
        decode: (url) =>
          Effect.suspend(() => {
            putio.events.push("decode");
            decoded.push(url);
            if (decode === "fail")
              return Effect.fail(new Error("no video stream"));
            if (decode === "hang") return Effect.never;
            return Effect.succeed({
              frames: decode,
              codec: "h264",
              width: 1280,
              height: 720,
            });
          }),
        artifact: join(directory, "artifact"),
        journal: join(directory, "recovery", "acquire.json"),
        timing: {
          acquisitionMs: options.acquisitionMs ?? 10_000,
          pollIntervalMs: 5,
          decodeMs: 200,
          verifyIntervalMs: 1,
        },
      }),
    );
    const receiptText = await readFile(
      join(directory, "artifact", "results.json"),
      "utf8",
    );
    const journalPath = join(directory, "recovery", "acquire.json");
    const journal = await readFile(journalPath, "utf8").catch(() => "");
    return {
      exit,
      putio,
      decoded,
      requests: services.requests,
      receiptText,
      receipt: Schema.decodeUnknownSync(Receipt)(receiptText),
      journal,
      journalMode: journal ? (await stat(journalPath)).mode & 0o777 : 0,
      ledger: await readLedger(join(directory, "allowance.json")),
      reserveAgain: () => reserve(directory, 1, 1),
    };
  } finally {
    await services.close();
    await rm(directory, { recursive: true, force: true });
  }
}

type Run = Awaited<ReturnType<typeof runLane>>;

const playRequests = (run: Run, method: string) =>
  run.requests.filter(
    (request) => request.method === method && request.path.includes("/play/"),
  );

const assertPrivateReceipt = (text: string) => {
  for (const secret of [
    credential,
    "v4.local.",
    imdbId,
    releaseId,
    decoyReleaseId,
    packReleaseId,
    maxBytes,
    "S01",
    "Season",
    "73101",
    "http",
    "fixture-grant",
    "Fixture",
    "Decoy",
  ])
    assert.ok(!text.includes(secret), secret);
};

const assertPreexistingUntouched = (run: Run) => {
  assert.ok(run.putio.transfers.has(baselineTransfer));
  assert.ok(run.putio.files.has(baselineFile));
  for (const ids of run.putio.cancelled)
    assert.ok(!ids.includes(baselineTransfer));
  for (const ids of run.putio.deleted) assert.ok(!ids.includes(baselineFile));
};

/** The new transfer's file was recorded before cancellation and removed. */
const assertCleaned = (run: Run) => {
  // The first cancel stops seeding; the second removes the transfer.
  assert.deepEqual(run.putio.cancelled, [[newTransfer], [newTransfer]]);
  assert.deepEqual(run.putio.deleted, [[newFile]]);
  assert.ok(!run.putio.files.has(newFile));
  assert.ok(!run.putio.transfers.has(newTransfer));
  assert.equal(run.receipt.cleanup.status, "acknowledged");
  assert.equal(run.receipt.cleanup.verification, "verified");
  assert.equal(run.receipt.proof.transferFilesRecorded, 1);
  assertPreexistingUntouched(run);
};

test("the pinned release is acquired with one selection, decoded, and removed", async () => {
  const run = await runLane({
    hops: ["status", "pending", "refuse", "pending", "media"],
  });
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(run.receipt.status, "passed");
  assert.equal(playRequests(run, "HEAD").length, 1);
  assert.deepEqual(
    playRequests(run, "GET").map((request) => request.path),
    [`/s/${credential}/play/movie/${imdbId}/${releaseId}.m3u8`],
  );
  const statusPath = `/s/${credential}/status/${newTransfer}.m3u8`;
  // Pending notices repeat the last status URL; the adapter is never asked for a notice.
  assert.deepEqual(
    run.requests
      .filter((request) => request.path.includes("/status/"))
      .map((request) => request.path),
    [
      `${statusPath}?wait=1`,
      `${statusPath}?wait=2`,
      `${statusPath}?wait=2`,
      `${statusPath}?wait=2`,
      `${statusPath}?wait=2`,
    ],
  );
  assert.ok(!run.requests.some((request) => request.path.includes("/notice/")));
  assert.equal(run.receipt.proof.statusHops, 5);
  assert.equal(run.receipt.proof.pendingNotices, 2);
  assert.equal(run.receipt.proof.statusRefusals, 1);
  assert.equal(run.receipt.proof.attribution, "status-url");
  assert.equal(run.receipt.proof.sizeBucket, "under-1-gib");
  assert.equal(run.receipt.proof.locationMediaOrigin, true);
  assert.equal(run.receipt.proof.locationHls, true);
  assert.equal(run.receipt.proof.locationNamesFile, true);
  assert.equal(run.receipt.proof.release, "movie");
  assert.deepEqual(
    run.requests
      .filter((request) => request.path.includes("/stream/"))
      .map((request) => request.path),
    [`/s/${credential}/stream/movie/${imdbId}.json`],
  );
  assert.ok(!run.putio.events.includes("folder"));
  assert.equal(run.receipt.proof.playedInTransfer, undefined);
  assert.equal(run.receipt.proof.playedEpisodeMatches, undefined);
  assert.equal(run.receipt.proof.packVideos, undefined);
  for (const timing of [
    run.receipt.proof.selectionToFirstStatusMs,
    run.receipt.proof.selectionToCompletionMs,
    run.receipt.proof.selectionToMediaMs,
  ])
    assert.ok(typeof timing === "number" && timing >= 0);
  const { ms, ...decoded } = run.receipt.proof.decode ?? { ms: -1 };
  assert.deepEqual(decoded, {
    frames: 240,
    codec: "h264",
    width: 1280,
    height: 720,
  });
  assert.ok(ms >= 0);
  assert.deepEqual(run.decoded, [
    `${mediaOrigin}/v2/files/${newFile}/hls/media.m3u8?oauth_token=fixture-grant`,
  ]);
  // Record, then stop seeding, then decode, then delete.
  const order = run.putio.events.filter((event) => event !== "account");
  const cancelAt = order.indexOf("cancel");
  assert.equal(order[cancelAt - 1], "list");
  assert.deepEqual(order.slice(cancelAt), [
    "cancel",
    "decode",
    "list",
    "list",
    "cancel",
    "list",
    "delete",
    "list",
  ]);
  assertCleaned(run);
  assert.deepEqual(run.ledger, {
    day: utcDay(),
    reservedTransfers: 3,
    reservedBytes: seededBytes + Number(maxBytes),
  });
  assertPrivateReceipt(run.receiptText);
  assert.equal(run.journalMode, 0o600);
  for (const id of [baselineTransfer, newTransfer, newFile])
    assert.ok(run.journal.includes(String(id)), String(id));
  assert.ok(!run.journal.includes(credential));
});

for (const [label, pin] of [
  ["no pin", {}],
  ["no byte limit", { imdbId, releaseId }],
  ["a person ID", { imdbId: "nm0000001", releaseId, maxBytes }],
  ["a bare prefix", { imdbId: "tt", releaseId, maxBytes }],
  [
    "a release that is not a UUID",
    { imdbId, releaseId: "release-1", maxBytes },
  ],
  ["a zero byte limit", { imdbId, releaseId, maxBytes: "0" }],
  ["a fractional byte limit", { imdbId, releaseId, maxBytes: "1.5" }],
  ["a negative byte limit", { imdbId, releaseId, maxBytes: "-1" }],
  ["an unsafe byte limit", { imdbId, releaseId, maxBytes: "9007199254740993" }],
  ["an empty episode", { ...episodePin, episode: "" }],
  ["an episode without a season", { ...episodePin, episode: "2" }],
  ["a zero season", { ...episodePin, episode: "0:2" }],
  ["a zero episode", { ...episodePin, episode: "1:0" }],
  ["a zero-padded episode", { ...episodePin, episode: "01:02" }],
  ["a negative episode", { ...episodePin, episode: "1:-2" }],
  ["an episode range", { ...episodePin, episode: "1:2:3" }],
  [
    "an episode past the adapter's range",
    { ...episodePin, episode: "1:10000" },
  ],
  ["a season pack without an episode", { ...packPin, episode: undefined }],
  ["a bare pack prefix", { ...packPin, releaseId: "pack:" }],
  [
    "an upper-case pack prefix",
    { ...packPin, releaseId: `PACK:${packReleaseId}` },
  ],
  [
    "a doubled pack prefix",
    { ...packPin, releaseId: `pack:pack:${packReleaseId}` },
  ],
  ["an owned video", { ...episodePin, releaseId: "owned:73101801" }],
] as const)
  test(`${label} fails at configuration before any call`, async () => {
    const run = await runLane({}, { pin });
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, "configuration");
    assert.deepEqual(run.requests, []);
    assert.deepEqual(run.putio.events, []);
    assert.equal(run.ledger.reservedBytes, seededBytes);
    assertPrivateReceipt(run.receiptText);
  });

test("an absent pinned row fails without reservation or any selection", async () => {
  const run = await runLane({ rows: "missing" });
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "pinned-row-missing");
  assert.equal(run.receipt.proof.pinnedRow, false);
  assert.equal(run.receipt.proof.reserved, undefined);
  assert.deepEqual(run.ledger, {
    day: utcDay(),
    reservedTransfers: 2,
    reservedBytes: seededBytes,
  });
  assert.deepEqual(playRequests(run, "HEAD"), []);
  assert.deepEqual(playRequests(run, "GET"), []);
  assert.deepEqual(run.putio.cancelled, []);
  assert.deepEqual(run.putio.deleted, []);
  assertPrivateReceipt(run.receiptText);
});

for (const failure of [
  { hops: ["notice:failed"], stage: "adapter-failed" },
  { hops: ["status", "notice:select-file"], stage: "adapter-select-file" },
  { hops: ["notice:reconnect"], stage: "adapter-reconnect" },
] satisfies { hops: Hop[]; stage: string }[])
  test(`a ${failure.stage.slice("adapter-".length)} notice fails at ${failure.stage} and cancels the run's transfer`, async () => {
    const run = await runLane({ hops: failure.hops });
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, failure.stage);
    assert.equal(playRequests(run, "GET").length, 1);
    assert.deepEqual(run.decoded, []);
    assert.deepEqual(run.putio.cancelled, [[newTransfer]]);
    assert.deepEqual(run.putio.deleted, []);
    assert.equal(run.receipt.cleanup.verification, "verified");
    assertPreexistingUntouched(run);
    assertPrivateReceipt(run.receiptText);
  });

test("a lost submission is attributed only to the one new transfer", async () => {
  const run = await runLane({ play: "lost" });
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "adapter-unknown");
  assert.deepEqual(run.putio.cancelled, [[newTransfer]]);
  assert.equal(run.receipt.cleanup.pendingAcquisitions, 0);
  assert.equal(run.receipt.cleanup.verification, "verified");
  assertPreexistingUntouched(run);
});

test("a transfer larger than the pin is cancelled and its excess charged past the cap", async () => {
  const size = 1_234_567;
  const reservedBytes = liveVersions.byteLimit - Number(maxBytes);
  const run = await runLane(
    { hops: ["status", "media"], size },
    { reservedBytes },
  );
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "size-exceeded");
  assert.equal(run.receipt.proof.sizeExceeded, true);
  assert.equal(run.receipt.proof.excessCharged, true);
  assert.deepEqual(run.putio.cancelled, [[newTransfer]]);
  assert.deepEqual(run.decoded, []);
  assert.equal(
    run.ledger.reservedBytes,
    liveVersions.byteLimit - Number(maxBytes) + size,
  );
  assert.ok(run.ledger.reservedBytes > liveVersions.byteLimit);
  await assert.rejects(run.reserveAgain, AllowanceFailure);
  assertPreexistingUntouched(run);
  assertPrivateReceipt(run.receiptText);
});

test("an excess put.io reports only after a notice is still charged", async () => {
  const size = 1_234_567;
  const run = await runLane({ play: "lost", size });
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "adapter-unknown");
  assert.equal(run.receipt.proof.sizeExceeded, true);
  assert.equal(run.receipt.proof.excessCharged, true);
  assert.equal(run.ledger.reservedBytes, seededBytes + size);
  assert.deepEqual(run.putio.cancelled, [[newTransfer]]);
});

test("an oversized finished transfer is cancelled only after its file is recorded", async () => {
  const size = Number(maxBytes) + 5000;
  const run = await runLane(
    { play: "direct", size },
    // The size gate's own listing fails; the lifecycle lists again.
    { putio: { onList: (call) => (call === 3 ? "fail" : undefined) } },
  );
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "size-exceeded");
  assert.equal(run.receipt.proof.excessCharged, true);
  assertCleaned(run);
});

test("a finished transfer whose file was never recorded leaves cleanup unverified", async () => {
  const size = Number(maxBytes) + 5000;
  const run = await runLane(
    { play: "direct", size },
    {
      putio: {
        onList: (call) => (call === 3 || call === 4 ? "fail" : undefined),
      },
    },
  );
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "size-exceeded");
  assert.deepEqual(run.putio.deleted, []);
  assert.ok(run.putio.files.has(newFile));
  assert.equal(run.receipt.cleanup.status, "uncertain");
  assert.equal(run.receipt.cleanup.verification, "unverified");
});

test("an attribution judged ambiguous is not resolved again at cleanup", async () => {
  const run = await runLane(
    { play: "direct-ambiguous" },
    {
      // Only the stray candidate is still listed when cleanup reconciles.
      putio: {
        onList: (call, transfers) => {
          if (call === 3) transfers.delete(newTransfer);
          return undefined;
        },
      },
    },
  );
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "attribution");
  assert.deepEqual(run.putio.cancelled, []);
  assert.deepEqual(run.putio.deleted, []);
  assert.ok(run.putio.transfers.has(strayTransfer));
  assert.equal(run.receipt.cleanup.pendingAcquisitions, 1);
  assert.equal(run.receipt.cleanup.status, "uncertain");
  assert.notEqual(run.receipt.cleanup.verification, "verified");
});

test("ownership uses put.io's clock, not this host's", async () => {
  const run = await runLane(
    { hops: ["media"] },
    { putio: { skewMs: -30_000 } },
  );
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(run.receipt.status, "passed");
  assertCleaned(run);
});

test("a file put.io briefly answered 404 for is checked again before verifying", async () => {
  const run = await runLane({ hops: ["media"] }, { putio: { fileMisses: 1 } });
  assert.equal(run.receipt.status, "failed");
  assert.equal(run.receipt.cleanup.verification, "unverified");
  assert.deepEqual(run.putio.deleted, []);
  assert.ok(run.putio.files.has(newFile));
});

for (const reuse of [
  {
    play: "reuse",
    name: "a pre-existing transfer named by the adapter",
    pending: 0,
  },
  {
    play: "direct-ambiguous",
    name: "two new transfers with no status URL",
    pending: 1,
  },
] as const)
  test(`attribution to ${reuse.name} fails without cancelling or deleting it`, async () => {
    const run = await runLane({ play: reuse.play });
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, "attribution");
    assert.deepEqual(run.putio.cancelled, []);
    assert.deepEqual(run.putio.deleted, []);
    assert.deepEqual(run.decoded, []);
    assert.equal(run.receipt.cleanup.pendingAcquisitions, reuse.pending);
    assert.notEqual(run.receipt.cleanup.verification, "verified");
    assertPreexistingUntouched(run);
    assertPrivateReceipt(run.receiptText);
  });

for (const decode of ["fail", "hang", 0] as const)
  test(`a completed transfer whose decode ${decode === "hang" ? "times out" : decode === 0 ? "has no frames" : "fails"} is still recorded, cancelled and removed`, async () => {
    const run = await runLane({ hops: ["media"] }, { decode });
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.status, "failed");
    assert.equal(run.receipt.proof.failureStage, "decode");
    assertCleaned(run);
    assertPrivateReceipt(run.receiptText);
  });

test("a decodable status clip on the media origin fails the Location check", async () => {
  const run = await runLane({ hops: ["media-notice"] });
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "location");
  assert.equal(run.receipt.proof.locationMediaOrigin, true);
  assert.equal(run.receipt.proof.locationHls, true);
  assert.deepEqual(run.decoded, []);
  assertCleaned(run);
  assertPrivateReceipt(run.receiptText);
});

test("a selection that plays without a status URL is attributed to the one new transfer", async () => {
  const run = await runLane({ play: "direct" });
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(run.receipt.status, "passed");
  assert.equal(run.receipt.proof.attribution, "baseline-difference");
  assert.equal(run.receipt.proof.statusHops, 0);
  assertCleaned(run);
});

test("an acquisition that never completes times out and cancels its transfer", async () => {
  const run = await runLane(
    { hops: ["status"], rest: "pending" },
    { acquisitionMs: 300 },
  );
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "acquisition-timeout");
  assert.equal(playRequests(run, "GET").length, 1);
  assert.deepEqual(run.putio.cancelled, [[newTransfer]]);
  assert.equal(run.receipt.cleanup.verification, "verified");
});

test("namedEpisode reads one season and episode from a file name", () => {
  for (const [name, expected] of [
    ["Fixture.Show.S01E02.1080p.mkv", { season: 1, episode: 2 }],
    ["fixture show s1e2.mp4", { season: 1, episode: 2 }],
    ["Fixture Show - S01.E02 - Title.mkv", { season: 1, episode: 2 }],
    ["Fixture.Show.1x02.mkv", { season: 1, episode: 2 }],
    ["Fixture.Show.S01E02-E02.mkv", { season: 1, episode: 2 }],
    ["Fixture.Show.S01E02E03.mkv", undefined],
    ["Fixture.Show.S01E02-03.mkv", undefined],
    ["Fixture.Show.S01.1080p.x264.mkv", undefined],
    ["Fixture.Movie.1920x1080.mkv", undefined],
    ["FixtureS01E02.mkv", undefined],
  ] as const)
    assert.deepEqual(namedEpisode(name), expected, name);
});

const episodeGet = (release: string) =>
  `/s/${credential}/play/series/${encodeURIComponent(episodeTarget)}/${encodeURIComponent(release)}.m3u8`;

test("a pinned episode release reads the episode listing and plays that episode", async () => {
  const run = await runLane(
    { hops: ["status", "pending", "media"] },
    {
      pin: episodePin,
      putio: { videoName: "Fixture.Show.S01E02.1080p.mkv" },
    },
  );
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(run.receipt.status, "passed");
  assert.deepEqual(
    run.requests
      .filter((request) => request.path.includes("/stream/"))
      .map((request) => request.path),
    [`/s/${credential}/stream/series/${imdbId}:1:2.json`],
  );
  assert.equal(playRequests(run, "HEAD").length, 1);
  assert.deepEqual(
    playRequests(run, "GET").map((request) => request.path),
    [episodeGet(releaseId)],
  );
  assert.equal(run.receipt.proof.release, "episode");
  assert.equal(run.receipt.proof.pinnedRow, true);
  assert.equal(run.receipt.proof.pendingNotices, 1);
  assert.equal(run.receipt.proof.playedInTransfer, true);
  assert.equal(run.receipt.proof.playedEpisodeMatches, true);
  assert.equal(run.receipt.proof.packVideos, undefined);
  assert.ok((run.receipt.proof.decode?.frames ?? 0) > 0);
  assertCleaned(run);
  assert.deepEqual(run.ledger, {
    day: utcDay(),
    reservedTransfers: 3,
    reservedBytes: seededBytes + Number(maxBytes),
  });
  assertPrivateReceipt(run.receiptText);
});

test("a pinned season pack plays the pinned episode from its folder and removes the whole tree", async () => {
  const run = await runLane(
    {
      statusEpisode: true,
      hops: ["status", "pending", "refuse", "media"],
    },
    { pin: packPin, putio: { saved: "season" } },
  );
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(run.receipt.status, "passed");
  assert.deepEqual(
    playRequests(run, "GET").map((request) => request.path),
    [episodeGet(`pack:${packReleaseId}`)],
  );
  const statusPath = `/s/${credential}/status/${newTransfer}/1/2.m3u8`;
  assert.deepEqual(
    run.requests
      .filter((request) => request.path.includes("/status/"))
      .map((request) => request.path),
    [
      `${statusPath}?wait=1`,
      `${statusPath}?wait=2`,
      `${statusPath}?wait=2`,
      `${statusPath}?wait=2`,
    ],
  );
  assert.equal(run.receipt.proof.release, "season-pack");
  assert.equal(run.receipt.proof.attribution, "status-url");
  assert.equal(run.receipt.proof.playedInTransfer, true);
  assert.equal(run.receipt.proof.playedEpisodeMatches, true);
  // Two episodes and the sample.
  assert.equal(run.receipt.proof.packVideos, 3);
  assert.deepEqual(run.decoded, [
    `${mediaOrigin}/v2/files/${packPinnedEpisode}/hls/media.m3u8?oauth_token=fixture-grant`,
  ]);
  // The saved folder is deleted once; nothing under it remains.
  assertCleaned(run);
  for (const id of [
    packFirstEpisode,
    packPinnedEpisode,
    packSampleFolder,
    packSampleVideo,
    packInfo,
  ])
    assert.ok(!run.putio.files.has(id), String(id));
  assert.ok(run.journal.includes(String(packSampleVideo)));
  assertPrivateReceipt(run.receiptText);
});

test("a season folder whose entries outlive its deletion leaves cleanup unverified", async () => {
  const run = await runLane(
    { statusEpisode: true, hops: ["media"] },
    { pin: packPin, putio: { saved: "season", orphanEntries: true } },
  );
  assert.equal(run.receipt.status, "failed");
  assert.deepEqual(run.putio.deleted, [[newFile]]);
  assert.ok(!run.putio.files.has(newFile));
  assert.ok(run.putio.files.has(packPinnedEpisode));
  assert.ok(!run.putio.transfers.has(newTransfer));
  assert.equal(run.receipt.cleanup.verification, "present");
});

for (const [label, pin, rows] of [
  ["a season pack pin never selects the other kind of row", packPin, "swapped"],
  [
    "an episode release pin never selects the other kind of row",
    episodePin,
    "swapped",
  ],
  [
    "a season pack pin never selects another episode's row",
    packPin,
    "other-episode",
  ],
  [
    "an episode release pin never selects another episode's row",
    episodePin,
    "other-episode",
  ],
  [
    "an episode release pin never selects a movie row",
    episodePin,
    "movie-path",
  ],
] as const)
  test(label, async () => {
    const run = await runLane({ rows }, { pin });
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, "pinned-row-missing");
    assert.equal(run.receipt.proof.pinnedRow, false);
    assert.equal(run.receipt.proof.reserved, undefined);
    assert.equal(run.ledger.reservedBytes, seededBytes);
    assert.deepEqual(playRequests(run, "HEAD"), []);
    assert.deepEqual(playRequests(run, "GET"), []);
    assert.deepEqual(run.putio.cancelled, []);
    assertPrivateReceipt(run.receiptText);
  });

for (const mismatch of [
  {
    name: "a season pack whose status URL omits the episode",
    script: { hops: ["media"] },
    pin: packPin,
  },
  {
    name: "an episode release whose status URL names an episode",
    script: { statusEpisode: true, hops: ["media"] },
    pin: episodePin,
  },
] satisfies { name: string; script: Script; pin: typeof episodePin }[])
  test(`${mismatch.name} fails at redirect and cancels the run's transfer`, async () => {
    const run = await runLane(mismatch.script, { pin: mismatch.pin });
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, "redirect");
    assert.equal(playRequests(run, "GET").length, 1);
    assert.deepEqual(run.decoded, []);
    assert.deepEqual(run.putio.cancelled, [[newTransfer]]);
    assert.equal(run.receipt.cleanup.verification, "verified");
    assertPreexistingUntouched(run);
  });

for (const identity of [
  {
    name: "an episode release saving another episode",
    pin: episodePin,
    putio: { videoName: "Fixture.Show.S01E03.1080p.mkv" },
    inTransfer: true,
  },
  {
    name: "a season pack playing another episode from its folder",
    pin: packPin,
    putio: { saved: "season", played: packFirstEpisode },
    inTransfer: true,
  },
  {
    name: "a season pack playing a video outside its folder",
    pin: packPin,
    putio: { saved: "season", played: baselineFile },
    inTransfer: false,
  },
] satisfies {
  name: string;
  pin: typeof episodePin;
  putio: FakeOptions;
  inTransfer: boolean;
}[])
  test(`${identity.name} fails at episode-identity before decoding and is removed`, async () => {
    const run = await runLane(
      { statusEpisode: identity.pin === packPin, hops: ["media"] },
      { pin: identity.pin, putio: identity.putio },
    );
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, "episode-identity");
    assert.equal(run.receipt.proof.playedInTransfer, identity.inTransfer);
    assert.equal(run.receipt.proof.playedEpisodeMatches, false);
    assert.deepEqual(run.decoded, []);
    assertCleaned(run);
    assertPrivateReceipt(run.receiptText);
  });

test("a season pack failing before the identity check still checks every saved entry", async () => {
  for (const [putio, verification] of [
    [{ saved: "season" }, "verified"],
    [{ saved: "season", orphanEntries: true }, "present"],
    [{ saved: "season", folderFails: true }, "unverified"],
  ] satisfies [FakeOptions, string][]) {
    const run = await runLane(
      { statusEpisode: true, hops: ["media-notice"] },
      { pin: packPin, putio },
    );
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, "location");
    assert.deepEqual(run.putio.deleted, [[newFile]]);
    assert.ok(!run.putio.transfers.has(newTransfer));
    assert.equal(run.receipt.cleanup.verification, verification);
    assert.equal(
      run.journal.includes(String(packSampleVideo)),
      !putio.folderFails,
    );
    assertPreexistingUntouched(run);
  }
});

test("an episode whose saved file the run did not create fails at episode-identity and deletes nothing", async () => {
  const run = await runLane(
    { hops: ["media"] },
    {
      pin: episodePin,
      putio: { videoName: "Fixture.Show.S01E02.1080p.mkv", savedBefore: true },
    },
  );
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "episode-identity");
  assert.equal(run.receipt.proof.playedEpisodeMatches, undefined);
  assert.deepEqual(run.decoded, []);
  assert.deepEqual(run.putio.deleted, []);
  assert.ok(run.putio.files.has(newFile));
  assert.equal(run.receipt.cleanup.verification, "unverified");
  assertPreexistingUntouched(run);
});

test("the folder read returns put.io's entry names and types", async () => {
  vi.stubEnv(liveVersions.putioTokenEnv, "fixture-token");
  const fetchMock = vi.spyOn(globalThis, "fetch");
  const page = () =>
    Response.json({
      status: "OK",
      files: [
        { id: 11, name: "Fixture.Show.S01E01.mkv", file_type: "VIDEO" },
        { id: 12, name: "Sample", file_type: "FOLDER" },
        { id: 13, name: "Fixture.nfo" },
      ],
    });
  try {
    fetchMock.mockResolvedValueOnce(page()).mockResolvedValueOnce(page());
    assert.deepEqual(await Effect.runPromise(listFolder(7)), [
      { id: 11, name: "Fixture.Show.S01E01.mkv", fileType: "VIDEO" },
      { id: 12, name: "Sample", fileType: "FOLDER" },
      { id: 13, name: "Fixture.nfo", fileType: undefined },
    ]);
    assert.equal(
      fetchMock.mock.calls[0]?.[0],
      `${liveVersions.apiBase}/v2/files/list?parent_id=7&per_page=1000`,
    );
    assert.deepEqual(await Effect.runPromise(listFolderIds(7)), [11, 12, 13]);
  } finally {
    fetchMock.mockRestore();
    vi.unstubAllEnvs();
  }
});
