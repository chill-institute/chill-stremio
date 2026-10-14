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
  listing?: { attempts: number; intervalMs: number };
}

const Streams = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
    }),
  ),
});

const validOrigin = (value: string) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    url.origin === value &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
  );
};

export const runOwnedPlayback = Effect.fn("live.runOwnedPlayback")(function* (
  options: OwnedOptions,
) {
  const { provider } = options;
  const mediaOrigin = options.mediaOrigin ?? liveVersions.apiBase;
  const listing = options.listing ?? { attempts: 30, intervalMs: 10_000 };
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
    yield* Effect.tryPromise((signal) =>
      reserve(ledgerDirectory, 2, source.bytes, undefined, { signal }),
    );
    proof.reservation = { creations: 2, bytes: source.bytes };

    stage = "upload";
    const folder = yield* trackAcquisition(
      attempt,
      "file",
      provider.createFolder(folderName),
      checkpoint,
    );
    const file = yield* trackAcquisition(
      attempt,
      "file",
      provider.uploadFile(source.path, ownedTitle.fileName, folder.id),
      checkpoint,
    );
    proof.uploaded = true;

    stage = "listing";
    const base = `${options.origin}/s/${options.credential}`;
    const streams = `${base}/stream/movie/${ownedTitle.imdbId}.json`;
    const listedAt = performance.now();
    let selected: string | undefined;
    for (let poll = 1; poll <= listing.attempts && !selected; poll++) {
      if (poll > 1) yield* Effect.sleep(listing.intervalMs);
      proof.listingPolls = poll;
      const response = yield* request(streams);
      if (response.status !== 200) {
        yield* discard(response);
        continue;
      }
      const body = yield* Effect.tryPromise({
        try: () => response.json(),
        catch: () => fail(stage),
      });
      const rows = (yield* Schema.decodeUnknownEffect(Streams)(body).pipe(
        Effect.mapError(() => fail(stage)),
      )).streams.filter((row) => row.name === "Play from put.io");
      proof.ownedRows = rows.length;
      selected = rows.find((row) => {
        if (!row.url || !URL.canParse(row.url)) return false;
        const url = new URL(row.url);
        if (
          url.origin !== options.origin ||
          !url.pathname.startsWith(`/s/${options.credential}/play/movie/`)
        )
          return false;
        try {
          return (
            decodeURIComponent(url.pathname.split("/").at(-1) ?? "") ===
            `owned:${file.id}.m3u8`
          );
        } catch {
          return false;
        }
      })?.url;
    }
    if (!selected) return yield* fail(stage);
    proof.listedAfterMs = Math.round(performance.now() - listedAt);

    stage = "head";
    const head = yield* request(selected, { method: "HEAD" });
    proof.headStatus = head.status;
    if (head.status !== 200) return yield* fail(stage);

    stage = "redirect";
    const selection = yield* request(selected);
    yield* discard(selection);
    proof.redirectStatus = selection.status;
    const location = selection.headers.get("location") ?? "";
    const target = URL.canParse(location) ? new URL(location) : undefined;
    proof.locationMediaOrigin = target?.origin === mediaOrigin;
    proof.locationHls = target?.pathname.endsWith(".m3u8") ?? false;
    proof.locationNamesFile =
      target?.pathname.includes(`/files/${file.id}/`) ?? false;
    if (
      selection.status !== 302 ||
      !target ||
      target.origin !== mediaOrigin ||
      !target.pathname.endsWith(".m3u8") ||
      target.pathname.includes("/notice/")
    )
      return yield* fail(stage);

    stage = "decode";
    const decodeStarted = performance.now();
    const decoded = yield* options.decode(location);
    proof.decode = {
      frames: decoded.frames,
      codec: decoded.codec,
      width: decoded.width,
      height: decoded.height,
      ms: Math.round(performance.now() - decodeStarted),
    };
    if (decoded.frames < 1) return yield* fail(stage);
    stage = "done";
  }).pipe(
    Effect.timeout("10 minutes"),
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
