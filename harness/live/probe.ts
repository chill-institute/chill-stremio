import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import {
  AllowanceFailure,
  allowanceLimits,
  readLedger,
  reserve,
  utcDay,
} from "./allowance.ts";
import {
  classifyEgress,
  egressProxyPresent,
  rangeStatusViaProxy,
} from "./egress.ts";
import {
  hlsAdvertisesSubtitles,
  muxFixtureCaptions,
  overlayFixtureSubtitles,
  proveLivePlayback,
  proveUrlRenewal,
  rangeStatus,
  rangeSupported,
} from "./playback.ts";
import {
  accountInfo,
  addTransfer,
  cancelTransfers,
  createFolder,
  deleteFiles,
  downloadSubtitle,
  downloadUrl,
  getStartFrom,
  hlsCueText,
  hlsPlaylist,
  listSubtitles,
  PutioFailure,
  resetStartFrom,
  setStartFrom,
  uploadFile,
  waitForTransfer,
} from "./putio.ts";
import {
  designatedAccountPresent,
  designatedPutioTokenPresent,
  redactLive,
} from "./redact.ts";
import {
  ensureLiveSource,
  fixtureSrt,
  liveFolderName,
  liveMediaBase,
  liveSubtitleName,
  liveUploadName,
} from "./source.ts";
import { liveVersions } from "./versions.ts";
import { measureLivePayloads, liveRunnerDirectory } from "./runner.ts";
import {
  createLiveAttempt,
  trackAcquisition,
  withLiveLifecycle,
  writeRecoveryJournal,
} from "./lifecycle.ts";

class LiveFailure extends Schema.TaggedError<LiveFailure>()("LiveFailure", {
  message: Schema.String,
}) {}

const cache = ".cache/live";
const command = process.argv[2] ?? "probe";
const stamp = new Date().toISOString().replaceAll(":", "-");
const directory = `artifacts/live-${stamp}`;
const attempt = createLiveAttempt();
const checkpoint = writeRecoveryJournal(
  attempt,
  `${cache}/recovery/${stamp}.json`,
);
let reportWritten = false;
const report: Record<string, unknown> = {
  status: "blocked",
  client: "put.io live",
  versions: liveVersions,
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  live: attempt.evidence,
};

const simulateQuota = Effect.fn("live.simulateQuota")(function* (
  directory: string,
) {
  const scenarios: {
    name: string;
    status: "passed" | "failed";
    error?: string;
  }[] = [];
  const record = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      scenarios.push({ name, status: "passed" });
    } catch (cause) {
      scenarios.push({
        name,
        status: "failed",
        error: redactLive(String(cause)),
      });
    }
  };
  const overLimit = async (path: string, transfers: number, bytes: number) => {
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "allowance.json"),
      JSON.stringify({
        day: utcDay(),
        reservedTransfers: 0,
        reservedBytes: 0,
      }),
    );
    await reserve(path, transfers, bytes);
    try {
      await reserve(path, 1, 1);
    } catch (cause) {
      if (cause instanceof AllowanceFailure) return;
      throw cause;
    }
    throw new Error("Over-limit reservation was accepted");
  };
  yield* Effect.promise(async () => {
    await record("quota-bytes-exhausted", () =>
      overLimit(`${directory}/bytes`, 1, liveVersions.byteLimit),
    );
    await record("unreadable-ledger-stops", async () => {
      const path = `${directory}/broken`;
      await mkdir(path, { recursive: true });
      await writeFile(`${path}/allowance.json`, "{");
      try {
        await readLedger(`${path}/allowance.json`);
      } catch (cause) {
        if (cause instanceof AllowanceFailure) return;
        throw cause;
      }
      throw new Error("Invalid ledger was accepted");
    });
  });
  return scenarios;
});

const remainingAfter = (options: {
  account: boolean;
  token: boolean;
  source: boolean;
  acquisition: boolean;
  playback: boolean;
  range: boolean;
  subtitles: boolean;
  pauseResume: boolean;
  urlRenewal: boolean;
  transfer: boolean;
  egress: boolean;
}) =>
  [
    options.account ? undefined : "designated-putio-account",
    options.token ? undefined : "designated-putio-token",
    options.source ? undefined : "approved-lawful-source",
    options.acquisition ? undefined : "ready-and-uncached-acquisition",
    options.playback ? undefined : "decoded-playback",
    options.range ? undefined : "range-seek",
    options.subtitles ? undefined : "subtitles",
    options.pauseResume ? undefined : "pause-resume",
    options.urlRenewal ? undefined : "url-renewal",
    options.transfer ? undefined : "torrent-or-url-transfer-acquisition",
    options.egress ? undefined : "distinct-egress-urls",
    "native-live",
  ].filter((item): item is string => Boolean(item));

const folderSubtitle = Effect.fn("live.folderSubtitle")(function* (
  fileId: number,
) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const items = yield* listSubtitles(fileId).pipe(
      Effect.catch(() => Effect.succeed([])),
    );
    const match = items.find((item) => item.source === "folder") ?? items[0];
    if (match) return { key: match.key, source: match.source ?? "listed" };
    yield* Effect.sleep("2 seconds");
  }
  const playlist = yield* hlsPlaylist(fileId).pipe(
    Effect.catch(() => Effect.succeed("")),
  );
  if (hlsAdvertisesSubtitles(playlist)) return { key: "hls", source: "hls" };
  return yield* new LiveFailure({
    message: "put.io did not list folder subtitles or advertise HLS captions",
  });
});

const proveSubtitles = Effect.fn("live.proveSubtitles")(function* (
  fileId: number,
  playbackDir: string,
) {
  const listed = yield* folderSubtitle(fileId);
  const captions =
    listed.key === "hls"
      ? yield* hlsCueText(fileId)
      : yield* downloadSubtitle(fileId, listed.key);
  if (!captions.includes(liveVersions.fixtureSubtitle))
    return yield* new LiveFailure({
      message: "put.io subtitle download missed the fixture English cue",
    });
  const overlay = yield* overlayFixtureSubtitles(playbackDir, captions).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  );
  return {
    status: "passed" as const,
    source: listed.source,
    cue: true as const,
    overlay: overlay ? ("rendered" as const) : ("skipped" as const),
    identityPixels: overlay?.identityPixels,
    subtitlePixels: overlay?.subtitlePixels,
  };
});

export const runLive = Effect.fn("live.run")(function* (directory: string) {
  const ledgerDirectory = yield* Effect.tryPromise(() => liveRunnerDirectory());
  const expectedUsername = process.env[liveVersions.usernameEnv]?.trim();
  if (!expectedUsername)
    return yield* new LiveFailure({
      message: "Designated put.io username is missing",
    });
  const account = yield* accountInfo();
  if (account.username !== expectedUsername)
    return yield* new LiveFailure({
      message: "put.io token username does not match the designated login",
    });
  attempt.evidence.accountStatus = account.account_status;
  const source = yield* ensureLiveSource();
  attempt.evidence.source = {
    kind: "self-generated-fixture",
    file: source.file,
    bytes: source.bytes,
    sha256: source.sha256,
  };
  const playbackDir = join(directory, "playback");
  yield* Effect.tryPromise(() => mkdir(playbackDir, { recursive: true }));
  const muxed = join(playbackDir, "muxed.mp4");
  const mediaPath = yield* muxFixtureCaptions(
    source.path,
    source.captions,
    muxed,
  ).pipe(
    Effect.map(() => muxed),
    Effect.catch(() =>
      Effect.tryPromise(() => copyFile(source.path, muxed)).pipe(
        Effect.as(muxed),
      ),
    ),
  );
  const srtPath = join(playbackDir, liveSubtitleName(stamp));
  const vttPath = join(playbackDir, `${liveMediaBase(stamp)}.vtt`);
  yield* Effect.tryPromise(() =>
    Promise.all([
      writeFile(srtPath, fixtureSrt()),
      copyFile(source.captions, vttPath),
    ]),
  );
  const payloads = yield* Effect.tryPromise(() =>
    measureLivePayloads({
      media: mediaPath,
      srt: srtPath,
      vtt: vttPath,
    }),
  );
  const ledger = yield* Effect.tryPromise((signal) =>
    reserve(ledgerDirectory, payloads.transfers, payloads.bytes, undefined, {
      signal,
    }),
  );
  attempt.evidence.allowance = ledger;
  const acquisition = {
    method: "files-upload",
    createdFolder: false,
    uploadedFile: false,
    putioTransfer: false,
    reused: false,
  };
  attempt.evidence.acquisition = acquisition;
  const folder = yield* trackAcquisition(
    attempt,
    "file",
    createFolder(liveFolderName(stamp)),
    checkpoint,
  );
  acquisition.createdFolder = true;
  const uploaded = yield* trackAcquisition(
    attempt,
    "file",
    uploadFile(mediaPath, liveUploadName(stamp), folder.id),
    checkpoint,
  );
  acquisition.uploadedFile = true;
  yield* trackAcquisition(
    attempt,
    "file",
    uploadFile(srtPath, liveSubtitleName(stamp), folder.id, "text/plain"),
    checkpoint,
  );
  yield* trackAcquisition(
    attempt,
    "file",
    uploadFile(vttPath, `${liveMediaBase(stamp)}.vtt`, folder.id, "text/vtt"),
    checkpoint,
  );
  const playbackEvidence: Record<string, unknown> = {};
  attempt.evidence.playback = playbackEvidence;
  const firstUrl = yield* downloadUrl(uploaded.id);
  const paused = yield* rangeStatus(firstUrl, "bytes=0-65535");
  playbackEvidence.pauseResume = { paused };
  yield* Effect.sleep("20 seconds");
  const resumed = yield* rangeStatus(firstUrl, "bytes=65536-131071");
  playbackEvidence.pauseResume = { paused, resumed };
  if (!rangeSupported(paused) || !rangeSupported(resumed))
    return yield* new LiveFailure({
      message: `put.io download did not resume after pause (${paused}, ${resumed})`,
    });
  const secondUrl = yield* downloadUrl(uploaded.id);
  const renewal = yield* proveUrlRenewal(firstUrl, secondUrl);
  playbackEvidence.urlRenewal = {
    ...renewal,
    firstResumed: resumed,
    waitedSeconds: 20,
  };
  const proxyConfigured = egressProxyPresent();
  const proxyRange = proxyConfigured
    ? yield* rangeStatusViaProxy(secondUrl, "bytes=0-1023").pipe(
        Effect.catch(() => Effect.succeed(0)),
      )
    : undefined;
  const egress = classifyEgress({
    defaultRange: renewal.secondRange,
    proxyConfigured,
    proxyRange,
  });
  attempt.evidence.egress = egress;
  const playback = yield* proveLivePlayback([firstUrl, secondUrl], playbackDir);
  Object.assign(playbackEvidence, {
    decoded: {
      kind: playback.decoded.kind,
      identityPixels: playback.decoded.identityPixels,
      marker: playback.decoded.marker,
    },
    seek: {
      kind: playback.seek.kind,
      identityPixels: playback.seek.identityPixels,
      marker: playback.seek.marker,
    },
    audioDbfs: playback.audioDbfs,
    rangeStart: playback.rangeStart,
    rangeMid: playback.rangeMid,
  });
  const startFrom = yield* setStartFrom(uploaded.id, 20).pipe(
    Effect.flatMap(() => getStartFrom(uploaded.id)),
    Effect.tap(() => resetStartFrom(uploaded.id)),
    Effect.catch(() => Effect.succeed<number | undefined>(undefined)),
  );
  const persistedStart = startFrom === 20 ? 20 : undefined;
  playbackEvidence.startFrom = persistedStart;
  const subtitles = yield* proveSubtitles(uploaded.id, playbackDir).pipe(
    Effect.catch((cause) =>
      Effect.succeed({
        status: "blocked" as const,
        reason: redactLive(String(cause)),
      }),
    ),
  );
  playbackEvidence.subtitles = subtitles;
  let transfer: {
    status: "passed" | "blocked";
    type?: string;
    reason?: string;
  } = { status: "blocked", reason: "not-run" };
  const added = yield* trackAcquisition(
    attempt,
    "transfer",
    addTransfer(secondUrl, folder.id),
    checkpoint,
  ).pipe(
    Effect.catch((cause) =>
      Effect.succeed(
        cause instanceof PutioFailure || cause instanceof LiveFailure
          ? { error: redactLive(String(cause)) }
          : { error: redactLive(String(cause)) },
      ),
    ),
  );
  if ("error" in added) {
    transfer = { status: "blocked", reason: added.error };
  } else {
    const finished = yield* waitForTransfer(added.id).pipe(
      Effect.catch((cause) =>
        Effect.succeed({ error: redactLive(String(cause)) }),
      ),
    );
    if ("error" in finished) {
      transfer = { status: "blocked", reason: finished.error };
    } else {
      if (finished.file_id && finished.file_id > 0) {
        attempt.files.push(finished.file_id);
        yield* checkpoint;
      }
      transfer = {
        status: "passed",
        type: finished.type ?? undefined,
      };
    }
  }
  attempt.evidence.transfer = transfer;
  acquisition.putioTransfer = transfer.status === "passed";
  acquisition.method =
    transfer.status === "passed" ? "files-upload+url-transfer" : "files-upload";
  return { playback: { subtitles }, transfer, egress };
});

const program = Effect.gen(function* () {
  if (command !== "setup" && command !== "probe")
    return yield* new LiveFailure({ message: "Use setup or probe" });
  yield* Effect.tryPromise(() => mkdir(cache, { recursive: true }));
  if (command === "setup") {
    const source = yield* ensureLiveSource();
    console.log(
      JSON.stringify({
        status: "ready",
        versions: liveVersions,
        source: {
          kind: "self-generated-fixture",
          file: source.file,
          bytes: source.bytes,
          sha256: source.sha256,
        },
      }),
    );
    return;
  }
  yield* Effect.tryPromise(() => mkdir(directory, { recursive: true }));
  const simulated = yield* simulateQuota(`${directory}/quota`);
  report.simulated = simulated;
  const account = designatedAccountPresent();
  const putioToken = designatedPutioTokenPresent();
  const readAllowance = () =>
    Effect.promise(async () => {
      try {
        const ledgerDirectory = await liveRunnerDirectory();
        return await readLedger(join(ledgerDirectory, "allowance.json"));
      } catch (cause) {
        return {
          day: utcDay(),
          reservedTransfers: null,
          reservedBytes: null,
          error: redactLive(String(cause)),
        };
      }
    });
  let live: Record<string, unknown> = {
    status: "not-run",
    reason: putioToken
      ? "Designated put.io token is present; approved lawful source still required before any put.io call"
      : account
        ? `${liveVersions.putioTokenEnv} is required with the designated test login. Do not borrow Engine or production tokens.`
        : "Load the designated test credentials before the probe. Do not borrow Engine or production tokens.",
  };
  let remaining = remainingAfter({
    account,
    token: putioToken,
    source: false,
    acquisition: false,
    playback: false,
    range: false,
    subtitles: false,
    pauseResume: false,
    urlRenewal: false,
    transfer: false,
    egress: false,
  });
  let status: "passed" | "failed" | "blocked" = "blocked";
  if (account && putioToken) {
    const result = yield* Effect.scoped(runLive(directory));
    status = "passed";
    live = {
      status: "passed",
      ...attempt.evidence,
    };
    remaining = remainingAfter({
      account: true,
      token: true,
      source: true,
      acquisition: true,
      playback: true,
      range: true,
      subtitles: result.playback.subtitles.status === "passed",
      pauseResume: true,
      urlRenewal: true,
      transfer: result.transfer.status === "passed",
      egress: result.egress.status === "passed",
    });
  }
  const ledger = yield* readAllowance();
  const limits = "error" in ledger ? liveVersions : allowanceLimits(ledger);
  Object.assign(report, {
    status,
    client: "put.io live",
    versions: liveVersions,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    credential: {
      designatedAccount: account ? "present" : "missing",
      designatedPutioToken: putioToken ? "present" : "missing",
      ignoredGenericHooks: ["PUTIO_OAUTH_TOKEN", "PUTIO_OAUTH_CLIENT_SECRET"],
    },
    allowance: {
      day: ledger.day,
      reservedTransfers: ledger.reservedTransfers,
      reservedBytes: ledger.reservedBytes,
      byteLimit: limits.byteLimit,
      error: "error" in ledger ? ledger.error : undefined,
    },
    simulated,
    live,
    remaining,
    playback:
      live.status === "passed" ? "decoded-from-putio-download" : "not-run",
  });
  yield* Effect.tryPromise(() =>
    rm(join(directory, "playback", "download.mp4"), { force: true }),
  );
}).pipe(Effect.timeout(liveVersions.probeTimeoutMs));

const terminalProgram =
  command === "setup"
    ? program
    : withLiveLifecycle(attempt, program, {
        cancelTransfers,
        deleteFiles,
        checkpoint,
        publish: (outcome) =>
          Effect.tryPromise(async () => {
            const status =
              outcome.status === "failed" ? "failed" : report.status;
            Object.assign(report, {
              status,
              primary: outcome.primary,
              cleanup: outcome.cleanup,
            });
            await mkdir(directory, { recursive: true });
            await writeFile(
              `${directory}/results.json`,
              `${JSON.stringify(report, null, 2)}\n`,
            );
            reportWritten = true;
            process.exitCode = status === "passed" ? 0 : 1;
            console.log(
              JSON.stringify({ status, results: `${directory}/results.json` }),
            );
          }),
      });

if (import.meta.main)
  NodeRuntime.runMain(
    terminalProgram.pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          process.exitCode = 1;
          if (!reportWritten)
            console.log(
              JSON.stringify({
                status: "blocked",
                error: redactLive(String(cause)),
              }),
            );
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
    { disableErrorReporting: true },
  );
