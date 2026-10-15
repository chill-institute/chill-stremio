import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Option, Schema } from "effect";
import { isCredential, redactCredentials } from "../../src/credential.ts";
import { createEngineRpc, EngineError } from "../../src/engine.ts";
import { reserve } from "./allowance.ts";
import { sameAccountRoot } from "./binding.ts";
import {
  createLiveAttempt,
  trackAcquisition,
  withLiveLifecycle,
  writeRecoveryJournal,
} from "./lifecycle.ts";
import { decodeVideo } from "./playback.ts";
import * as putio from "./putio.ts";
import { liveRunnerDirectory } from "./runner.ts";
import { ensureLiveSource } from "./source.ts";
import { liveVersions } from "./versions.ts";

class OwnedProbeFailure extends Schema.TaggedError<OwnedProbeFailure>()(
  "OwnedProbeFailure",
  { stage: Schema.String },
) {}

/** A 1968 public-domain film; the uploaded content is the generated fixture. */
export const ownedTitle = {
  imdbId: "tt0063350",
  fileName: "Night.of.the.Living.Dead.1968.1080p.WEB.mkv",
};

/** An episode of a 1962 series; the uploaded content is the generated fixture. */
export const ownedEpisode = {
  imdbId: "tt0055662",
  season: 1,
  episode: 2,
  fileName: "The.Beverly.Hillbillies.S01E02.720p.WEB.mkv",
};

export interface Listing {
  attempts: number;
  intervalMs: number;
}

/** Reads a stream list up to `attempts` times until `read` finds its row. */
export const pollListing = Effect.fn("live.pollListing")(function* <A, E, R>(
  listing: Listing,
  read: (poll: number) => Effect.Effect<A | undefined, E, R>,
) {
  for (let poll = 1; poll <= listing.attempts; poll++) {
    if (poll > 1) yield* Effect.sleep(listing.intervalMs);
    const found = yield* read(poll);
    if (found !== undefined) return found;
  }
  return undefined;
});

export interface OwnedWebCleanup {
  browserClosed: boolean;
  contextClosed: boolean;
  webClosed: boolean;
}

export interface OwnedWebInput {
  /** The personal manifest; it carries the credential. */
  manifestUrl: string;
  credential: string;
  stremioId: string;
  /** The movie's stream list path on the adapter origin. */
  streamPath: string;
  /** The row's media URL the stream list must offer. */
  selectedUrl: string;
  listing: Listing;
  cleanup: OwnedWebCleanup;
  onStage: (stage: string) => void;
}

export interface OwnedWebProof {
  client: string;
  browser: string;
  streamListings: number;
  /** GET requests for the selected row's media URL. */
  selections: number;
  playlistResponses: number;
  segmentResponses: number;
  currentTime: readonly [number, number];
  decodedFrames: readonly [number, number];
  fixture: {
    width: number;
    height: number;
    markers: readonly [number, number];
  };
}

/** The Stremio Web step runs only when `LIVE_OWNED_WEB` is `1`. */
export const ownedWebStep = (value: string | undefined): OwnedOptions["web"] =>
  value?.trim() === "1"
    ? (input) =>
        Effect.tryPromise(() => import("./hosted-browser.ts")).pipe(
          Effect.flatMap((browser) => browser.proveOwnedWebPlayback(input)),
        )
    : undefined;

export interface OwnedProvider {
  accountInfo: () => Effect.Effect<{ username: string }, unknown>;
  listFolderIds: (id: number) => Effect.Effect<readonly number[], unknown>;
  createFolder: (name: string) => Effect.Effect<{ id: number }, unknown>;
  uploadFile: (
    path: string,
    name: string,
    parentId: number,
  ) => Effect.Effect<{ id: number }, unknown>;
  deleteFiles: (ids: readonly number[]) => Effect.Effect<void, unknown>;
  fileAbsent: (id: number) => Effect.Effect<boolean, unknown>;
  getFile: (
    id: number,
  ) => Effect.Effect<{ fileType?: string } | undefined, unknown>;
}

export interface OwnedOptions {
  credential: string;
  /** The deployed adapter's origin. */
  origin: string;
  engineBaseUrl: string;
  /** The origin a ready selection must redirect to. */
  mediaOrigin?: string;
  username: string | undefined;
  ledgerDirectory: () => Promise<string>;
  provider: OwnedProvider;
  source: Effect.Effect<{ path: string; bytes: number }, unknown>;
  decode: (
    url: string,
  ) => Effect.Effect<
    { frames: number; codec: string; width: number; height: number },
    unknown
  >;
  artifact: string;
  journal: string;
  nonce: string;
  listing?: Listing;
  /** Plays the movie's row in Stremio Web; unset skips the step. */
  web?: (input: OwnedWebInput) => Effect.Effect<OwnedWebProof, unknown>;
}

const Streams = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
    }),
  ),
});

export const validOrigin = (value: string) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.origin === value &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
  );
};

/** Whether a selection redirected to an HLS playlist on the put.io API origin. */
export function mediaLocation(
  status: number,
  location: string,
  mediaOrigin: string,
) {
  const target = URL.canParse(location) ? new URL(location) : undefined;
  const checks = {
    locationMediaOrigin: target?.origin === mediaOrigin,
    locationHls: target?.pathname.endsWith(".m3u8") ?? false,
  };
  return {
    target,
    checks,
    ok:
      status === 302 &&
      checks.locationMediaOrigin &&
      checks.locationHls &&
      !target?.pathname.includes("/notice/"),
  };
}

export const runOwnedPlayback = Effect.fn("live.runOwnedPlayback")(function* (
  options: OwnedOptions,
) {
  const { provider } = options;
  const mediaOrigin = options.mediaOrigin ?? liveVersions.apiBase;
  const listing: Listing = options.listing ?? {
    attempts: 30,
    intervalMs: 10_000,
  };
  const attempt = createLiveAttempt();
  const folderName = `${liveVersions.folderPrefix}-owned-${options.nonce}`;
  attempt.recovery = { folderName };
  const checkpoint = writeRecoveryJournal(attempt, options.journal);
  const proof: Record<string, unknown> = {
    source: "generated-fixture",
    credential: "designated-account",
  };
  let stage = "configuration";
  const fail = (at: string) => new OwnedProbeFailure({ stage: at });
  const request = (url: string, init: RequestInit = {}) =>
    Effect.tryPromise({
      try: (signal) => fetch(url, { ...init, signal, redirect: "manual" }),
      catch: () => fail(stage),
    }).pipe(Effect.timeout("20 seconds"));
  const discard = (response: Response) =>
    Effect.ignore(
      Effect.tryPromise(() => response.body?.cancel() ?? Promise.resolve()),
    );
  const started = performance.now();

  /** Lists a title until its Play from put.io row names the upload, then plays it. */
  const playOwned = Effect.fn("live.playOwned")(function* (
    title: {
      type: "movie" | "series";
      id: string;
      fileId: number;
      /** Prefix of this title's stage codes. */
      stages: string;
    },
    record: Record<string, unknown>,
  ) {
    stage = `${title.stages}listing`;
    const base = `${options.origin}/s/${options.credential}`;
    const streams = `${base}/stream/${title.type}/${title.id}.json`;
    const listedAt = performance.now();
    const selected = yield* pollListing(listing, (poll) =>
      Effect.gen(function* () {
        record.listingPolls = poll;
        const response = yield* request(streams);
        if (response.status !== 200) {
          yield* discard(response);
          return undefined;
        }
        const body = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: () => fail(stage),
        });
        const rows = (yield* Schema.decodeUnknownEffect(Streams)(body).pipe(
          Effect.mapError(() => fail(stage)),
        )).streams.filter((row) => row.name === "Play from put.io");
        record.ownedRows = rows.length;
        return rows.find((row) => {
          if (!row.url || !URL.canParse(row.url)) return false;
          const url = new URL(row.url);
          if (
            url.origin !== options.origin ||
            !url.pathname.startsWith(
              `/s/${options.credential}/play/${title.type}/`,
            )
          )
            return false;
          try {
            return (
              decodeURIComponent(url.pathname.split("/").at(-1) ?? "") ===
              `owned:${title.fileId}.m3u8`
            );
          } catch {
            return false;
          }
        })?.url;
      }),
    );
    if (!selected) {
      // Tells an upload put.io typed as something other than a video apart
      // from a lookup that left it out.
      const file = yield* Effect.option(provider.getFile(title.fileId));
      const fileType = Option.getOrUndefined(file)?.fileType;
      record.uploadFileType =
        fileType && /^[A-Z_]{1,32}$/.test(fileType) ? fileType : "unknown";
      return yield* fail(stage);
    }
    record.listedAfterMs = Math.round(performance.now() - listedAt);

    stage = `${title.stages}head`;
    const head = yield* request(selected, { method: "HEAD" });
    record.headStatus = head.status;
    if (head.status !== 200) return yield* fail(stage);

    stage = `${title.stages}redirect`;
    const selection = yield* request(selected);
    yield* discard(selection);
    record.redirectStatus = selection.status;
    const location = selection.headers.get("location") ?? "";
    const media = mediaLocation(selection.status, location, mediaOrigin);
    Object.assign(record, media.checks);
    record.locationNamesFile =
      media.target?.pathname.includes(`/files/${title.fileId}/`) ?? false;
    if (!media.ok) return yield* fail(stage);

    stage = `${title.stages}decode`;
    const decodeStarted = performance.now();
    const decoded = yield* options.decode(location);
    record.decode = {
      frames: decoded.frames,
      codec: decoded.codec,
      width: decoded.width,
      height: decoded.height,
      ms: Math.round(performance.now() - decodeStarted),
    };
    if (decoded.frames < 1) return yield* fail(stage);
    return selected;
  });

  const work = Effect.gen(function* () {
    if (!isCredential(options.credential) || !validOrigin(options.origin))
      return yield* fail(stage);
    const rpc = yield* createEngineRpc({
      baseUrl: options.engineBaseUrl,
      credential: options.credential,
    });
    stage = "allowance";
    const ledgerDirectory = yield* Effect.tryPromise(options.ledgerDirectory);
    stage = "account";
    const account = yield* provider.accountInfo();
    if (!options.username || account.username !== options.username)
      return yield* fail(stage);
    stage = "account-binding";
    if (!(yield* sameAccountRoot(rpc, provider.listFolderIds)))
      return yield* fail(stage);
    stage = "source";
    const source = yield* options.source;
    stage = "reservation";
    // The folder and two uploads of the fixture.
    yield* Effect.tryPromise((signal) =>
      reserve(ledgerDirectory, 3, 2 * source.bytes, undefined, { signal }),
    );
    proof.reservation = { creations: 3, bytes: 2 * source.bytes };

    stage = "upload";
    const folder = yield* trackAcquisition(
      attempt,
      "file",
      provider.createFolder(folderName),
      checkpoint,
    );
    const movie = yield* trackAcquisition(
      attempt,
      "file",
      provider.uploadFile(source.path, ownedTitle.fileName, folder.id),
      checkpoint,
    );
    const episode = yield* trackAcquisition(
      attempt,
      "file",
      provider.uploadFile(source.path, ownedEpisode.fileName, folder.id),
      checkpoint,
    );
    proof.uploaded = true;

    const base = `${options.origin}/s/${options.credential}`;
    const moviePath = `/s/${options.credential}/stream/movie/${ownedTitle.imdbId}.json`;
    const selected = yield* playOwned(
      {
        type: "movie",
        id: ownedTitle.imdbId,
        fileId: movie.id,
        stages: "",
      },
      proof,
    );
    const episodeProof: Record<string, unknown> = {};
    proof.episode = episodeProof;
    yield* playOwned(
      {
        type: "series",
        id: `${ownedEpisode.imdbId}:${ownedEpisode.season}:${ownedEpisode.episode}`,
        fileId: episode.id,
        stages: "episode-",
      },
      episodeProof,
    );

    if (!options.web) {
      proof.web = "skipped";
      stage = "done";
      return;
    }
    stage = "web";
    const cleanup = {
      browserClosed: false,
      contextClosed: false,
      webClosed: false,
    };
    const web: Record<string, unknown> = { cleanup };
    proof.web = web;
    const played = yield* options.web({
      manifestUrl: `${base}/manifest.json`,
      credential: options.credential,
      stremioId: ownedTitle.imdbId,
      streamPath: moviePath,
      selectedUrl: selected,
      listing,
      cleanup,
      onStage: (value) => {
        stage = `web-${value}`;
      },
    });
    stage = "web-proof";
    // Copied field by field so nothing else the step returns reaches the receipt.
    Object.assign(web, {
      client: played.client,
      browser: played.browser,
      streamListings: played.streamListings,
      selections: played.selections,
      playlistResponses: played.playlistResponses,
      segmentResponses: played.segmentResponses,
      currentTime: [...played.currentTime],
      decodedFrames: [...played.decodedFrames],
      fixture: {
        width: played.fixture.width,
        height: played.fixture.height,
        markers: [...played.fixture.markers],
      },
    });
    if (
      played.selections < 1 ||
      played.playlistResponses < 1 ||
      played.segmentResponses < 1 ||
      !(played.currentTime[1] > played.currentTime[0]) ||
      !(played.decodedFrames[1] > played.decodedFrames[0]) ||
      !(played.fixture.markers[1] > played.fixture.markers[0])
    )
      return yield* fail(stage);
    stage = "web-cleanup";
    if (!Object.values(cleanup).every(Boolean)) return yield* fail(stage);
    web.status = "passed";
    stage = "done";
  }).pipe(
    Effect.timeout("20 minutes"),
    Effect.catchCause((cause) => {
      const error = Cause.findErrorOption(cause);
      proof.failureStage =
        Option.isSome(error) && error.value instanceof OwnedProbeFailure
          ? error.value.stage
          : stage;
      if (Option.isSome(error) && error.value instanceof EngineError)
        proof.failureCode = error.value.code;
      return Effect.fail(fail(String(proof.failureStage)));
    }),
  );

  // Deletion counts only once put.io no longer has any of the run's files.
  const deleteFiles = (ids: readonly number[]) =>
    provider.deleteFiles(ids).pipe(
      Effect.andThen(
        Effect.gen(function* () {
          for (let check = 0; check < 4; check++) {
            if (check > 0) yield* Effect.sleep("1 second");
            const absent = yield* Effect.forEach(ids, provider.fileAbsent);
            if (absent.every(Boolean)) {
              proof.absenceConfirmed = true;
              return;
            }
          }
          proof.absenceConfirmed = false;
          return yield* fail("cleanup");
        }),
      ),
    );

  yield* withLiveLifecycle(attempt, work, {
    cancelTransfers: () => Effect.void,
    deleteFiles,
    checkpoint,
    publish: (outcome) =>
      Effect.tryPromise(async () => {
        proof.totalMs = Math.round(performance.now() - started);
        await mkdir(options.artifact, { recursive: true, mode: 0o700 });
        await writeFile(
          `${options.artifact}/results.json`,
          redactCredentials(
            `${JSON.stringify(
              {
                status: outcome.status,
                endpoint:
                  options.origin === "https://stremio.chill.institute"
                    ? "default"
                    : "override",
                proof,
                primary: outcome.primary,
                cleanup: outcome.cleanup,
              },
              null,
              2,
            )}\n`,
          ),
          { mode: 0o600 },
        );
        console.log(`${options.artifact}/results.json`);
      }),
  });
  return attempt.outcome;
});

if (import.meta.main) {
  const stamp = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  NodeRuntime.runMain(
    runOwnedPlayback({
      credential: process.env.CHILL_STREMIO_CREDENTIAL?.trim() ?? "",
      origin:
        process.env.CHILL_PUBLIC_STREMIO_ORIGIN?.trim() ||
        "https://stremio.chill.institute",
      engineBaseUrl:
        process.env.CHILL_ENGINE_BASE_URL?.trim() ||
        "https://api.chill.institute/v4",
      username: process.env[liveVersions.usernameEnv]?.trim(),
      ledgerDirectory: () => liveRunnerDirectory(),
      provider: putio,
      source: ensureLiveSource(),
      decode: (url) =>
        decodeVideo(url).pipe(Effect.provide(NodeServices.layer)),
      artifact: `artifacts/live-owned-${stamp}`,
      journal: `.cache/live/recovery/owned-${stamp}.json`,
      nonce: randomBytes(16).toString("hex"),
      web: ownedWebStep(process.env.LIVE_OWNED_WEB),
    }).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          if (outcome?.status !== "passed") process.exitCode = 1;
        }),
      ),
      Effect.catchCause(() =>
        Effect.sync(() => {
          process.exitCode = 1;
          console.log('{"status":"failed","code":"owned_probe_failed"}');
        }),
      ),
    ),
    { disableErrorReporting: true },
  );
}
