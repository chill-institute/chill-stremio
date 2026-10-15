import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Option, Schema, Semaphore } from "effect";
import { isCredential, redactCredentials } from "../../src/credential.ts";
import { createEngineRpc, EngineError } from "../../src/engine.ts";
import { statusMediaKinds } from "../../src/status-media.ts";
import { charge, reserve } from "./allowance.ts";
import { sameAccountRoot } from "./binding.ts";
import {
  createLiveAttempt,
  trackAcquisition,
  withLiveLifecycle,
  writeRecoveryJournal,
  type Verification,
} from "./lifecycle.ts";
import {
  mediaLocation,
  validOrigin,
  type Listing,
  type OwnedWebCleanup,
} from "./owned.ts";
import { decodeVideo } from "./playback.ts";
import * as putio from "./putio.ts";
import { liveRunnerDirectory } from "./runner.ts";
import { liveVersions } from "./versions.ts";

class AcquireProbeFailure extends Schema.TaggedError<AcquireProbeFailure>()(
  "AcquireProbeFailure",
  { stage: Schema.String },
) {}

const gib = 1024 ** 3;

/** The adapter's release ID prefix for an episode's season pack. */
const packPrefix = "pack:";

const Pin = Schema.Struct({
  imdbId: Schema.String.check(Schema.isPattern(/^tt[0-9]{1,10}$/)),
  releaseId: Schema.String.check(
    Schema.isPattern(
      /^(?:pack:)?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
    ),
  ),
  // The adapter's own range for episode stream IDs.
  episode: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,3}:[1-9][0-9]{0,3}$/)),
  ),
  maxBytes: Schema.String.check(
    Schema.isPattern(/^[1-9][0-9]*$/),
    Schema.makeFilter((value) => Number.isSafeInteger(Number(value))),
  ),
});

type ProviderTransfer = typeof putio.Transfer.Type;

interface SavedEntry {
  id: number;
  name: string;
  fileType?: string | undefined;
}

/**
 * The one season and episode a file name carries as `S01E02` or `1x02`;
 * a multi-episode name carries none. A `-720p` after the episode is a
 * resolution, not an end episode.
 */
export function namedEpisode(name: string) {
  const groups = (
    /(?<![a-z0-9])s(?<season>\d{1,4})[ ._-]?e(?<episode>\d{1,4})(?:[ ._-]?e(?<end>\d{1,4})|-(?<last>\d{1,4})(?![0-9pi]))?(?![0-9])/i.exec(
      name,
    ) ??
    /(?<![a-z0-9])(?<season>\d{1,2})x(?<episode>\d{2,3})(?:-(?:\d{1,2}x)?(?<end>\d{2,3}))?(?![0-9a-z])/i.exec(
      name,
    )
  )?.groups;
  if (!groups) return undefined;
  const season = Number(groups.season);
  const episode = Number(groups.episode);
  const end = groups.end ?? groups.last;
  if (end !== undefined && Number(end) !== episode) return undefined;
  return { season, episode };
}

export interface AcquireProvider {
  accountInfo: () => Effect.Effect<{ username: string }, unknown>;
  listFolderIds: (id: number) => Effect.Effect<readonly number[], unknown>;
  listTransfers: () => Effect.Effect<readonly ProviderTransfer[], unknown>;
  /** put.io's own clock in epoch milliseconds, read without mutation. */
  serverTime: () => Effect.Effect<number, unknown>;
  getTransfer: (id: number) => Effect.Effect<ProviderTransfer, unknown>;
  cancelTransfers: (ids: readonly number[]) => Effect.Effect<void, unknown>;
  getFile: (id: number) => Effect.Effect<
    | {
        id: number;
        name?: string | undefined;
        parentId?: number | undefined;
        createdAt?: string | undefined;
        fileType?: string | undefined;
      }
    | undefined,
    unknown
  >;
  listFolder: (id: number) => Effect.Effect<readonly SavedEntry[], unknown>;
  deleteFiles: (ids: readonly number[]) => Effect.Effect<void, unknown>;
  fileAbsent: (id: number) => Effect.Effect<boolean, unknown>;
}

/** A status clip other than pending that Stremio Web was sent to. */
export class AcquireWebNotice extends Schema.TaggedError<AcquireWebNotice>()(
  "AcquireWebNotice",
  { notice: Schema.String },
) {}

export interface AcquireWebInput {
  /** The personal manifest; it carries the credential. */
  manifestUrl: string;
  credential: string;
  /** Stremio's detail route: the movie, or the series and the pinned episode. */
  detail: { type: "movie" | "series"; id: string; videoId: string };
  /** The stream list path on the adapter origin. */
  streamPath: string;
  rowName: string;
  /** The pinned row's media URL; no other row may be selected. */
  selectedUrl: string;
  listing: Listing;
  cleanup: OwnedWebCleanup;
  onStage: (stage: string) => void;
  /** Runs just before the first click; from then on the selection counts as sent. */
  beforeSelection: Effect.Effect<void, unknown>;
  /** Called once when the page first requests put.io media. */
  onMedia: () => void;
}

export interface AcquireWebProof {
  client: string;
  browser: string;
  streamListings: number;
  /** Clicks on the pinned row: the first and one after each pending clip. */
  rowSelections: number;
  /** GET requests for the pinned media URL, the page's own retries included. */
  selections: number;
  /** Requests for any other media URL on the adapter, each refused. */
  otherSelections: number;
  statusRequests: number;
  pendingNotices: number;
  playlistResponses: number;
  segmentResponses: number;
  /** put.io file IDs the page's media requests name; never in the receipt. */
  playedFiles: readonly number[];
  currentTime: readonly [number, number];
  decodedFrames: readonly [number, number];
  selectionToMediaMs: number;
}

/** Stremio Web makes the selection only when `LIVE_ACQUIRE_WEB` is `1`. */
export const acquireWebStep = (
  value: string | undefined,
): AcquireOptions["web"] =>
  value?.trim() === "1"
    ? (input) =>
        Effect.tryPromise(() => import("./hosted-browser.ts")).pipe(
          Effect.flatMap((browser) => browser.proveAcquiredWebPlayback(input)),
        )
    : undefined;

export interface AcquireOptions {
  credential: string;
  /** The deployed adapter's origin. */
  origin: string;
  engineBaseUrl: string;
  /** The origin a ready selection must redirect to. */
  mediaOrigin?: string;
  username: string | undefined;
  /** The approved release, supplied privately at run time. */
  pin: {
    imdbId?: string;
    releaseId?: string;
    /** `<season>:<episode>` for an episode or its season pack. */
    episode?: string;
    maxBytes?: string;
  };
  ledgerDirectory: () => Promise<string>;
  provider: AcquireProvider;
  decode: (
    url: string,
  ) => Effect.Effect<
    { frames: number; codec: string; width: number; height: number },
    unknown
  >;
  artifact: string;
  journal: string;
  timing?: Partial<typeof defaultTiming>;
  /** Selects the pinned row in Stremio Web instead of the lane's own GET. */
  web?: (input: AcquireWebInput) => Effect.Effect<AcquireWebProof, unknown>;
}

const defaultTiming = {
  acquisitionMs: 20 * 60_000,
  pollIntervalMs: 10_000,
  requestMs: 60_000,
  decodeMs: 2 * 60_000,
  verifyAttempts: 4,
  verifyIntervalMs: 1_000,
  /** Stremio Web's time beyond the acquisition limit: setup, listing and playback. */
  webMs: 8 * 60_000,
};

/** put.io timestamps carry no zone and are UTC. */
const providerTime = (value: string | null | undefined) => {
  if (!value) return undefined;
  const time = Date.parse(
    /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`,
  );
  return Number.isFinite(time) ? time : undefined;
};

const sizeBucket = (bytes: number) =>
  bytes < gib ? "under-1-gib" : bytes <= 4 * gib ? "up-to-4-gib" : "over-4-gib";

const finished = new Set(["COMPLETED", "SEEDING"]);

type Hop =
  | { kind: "status"; id: number; url: string }
  | { kind: "notice"; notice: string }
  | { kind: "external"; url: string }
  | { kind: "invalid" };

type FileResolution = "unresolved" | "owned" | "absent" | "retained";

export const runAcquisition = Effect.fn("live.runAcquisition")(function* (
  options: AcquireOptions,
) {
  const { provider } = options;
  const timing = { ...defaultTiming, ...options.timing };
  const mediaOrigin = options.mediaOrigin ?? liveVersions.apiBase;
  const attempt = createLiveAttempt();
  // Replaced by put.io's clock before the baseline; created_at uses that clock.
  let runStart = Number.POSITIVE_INFINITY;
  const baselineTransfers = new Set<number>();
  const baselineFiles = new Set<number>();
  const freshTransfers = new Set<number>();
  const transferFiles: {
    transfer: number;
    file: number;
    saveParent: number | null;
    resolution: FileResolution;
  }[] = [];
  const recovery: Record<string, unknown> = {
    baselineTransfers: [] as number[],
    freshTransfers: [] as number[],
    transferFiles,
  };
  attempt.recovery = recovery;
  // Stremio Web's step and the transfer watcher would otherwise race on the
  // journal's temporary file.
  const journal = Semaphore.makeUnsafe(1);
  const checkpoint = Semaphore.withPermit(journal)(
    writeRecoveryJournal(attempt, options.journal),
  );
  const proof: Record<string, unknown> = {
    source: "approved-release",
    credential: "designated-account",
    statusHops: 0,
    pendingNotices: 0,
  };
  let stage = "configuration";
  let selectionSent = false;
  let selectionStarted = 0;
  let statusId: number | undefined;
  let attributed: number | undefined;
  let sizeSeen = false;
  let charged = false;
  // Set once more than one candidate was seen; nothing is then attributed by
  // baseline difference, so cleanup stays uncertain rather than guessing.
  let ambiguous = false;
  // Set once Stremio Web's selection left a transfer beside the attributed
  // one; it is never attributed, so its acquisition stays pending.
  let unattributed = false;
  // Set once the transfer finished or served media, so it must have a file.
  let fileExpected = false;
  let pin: {
    imdbId: string;
    releaseId: string;
    maxBytes: number;
    episode?: { season: number; episode: number };
    pack: boolean;
  } = { imdbId: "", releaseId: "", maxBytes: 0, pack: false };
  // Files found under the transfer's saved folder; deleting it removes them.
  const savedFiles = new Set<number>();
  // Each owned saved entry's tree as last listed; undefined once a listing
  // failed or passed the walk limits.
  const savedTrees = new Map<number, readonly SavedEntry[] | undefined>();
  let ledgerDirectory = "";
  const cancelled = new Set<number>();
  const fail = (at: string) => new AcquireProbeFailure({ stage: at });
  const since = () => Math.round(performance.now() - selectionStarted);
  const createdSince = (value: string | null | undefined) => {
    const time = providerTime(value);
    return time !== undefined && time >= runStart;
  };

  const request = (url: string, method = "GET") =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(url, {
          method,
          signal,
          redirect: "manual",
        });
        await response.body?.cancel().catch(() => undefined);
        return {
          status: response.status,
          location: response.headers.get("location") ?? "",
        };
      },
      catch: () => fail(stage),
    }).pipe(
      Effect.timeout(timing.requestMs),
      Effect.mapError(() => fail(stage)),
    );

  const personal = `/s/${options.credential}`;
  const classify = (location: string): Hop => {
    if (!URL.canParse(location)) return { kind: "invalid" };
    const url = new URL(location);
    if (url.origin !== options.origin)
      return { kind: "external", url: url.href };
    if (!url.pathname.startsWith(`${personal}/`)) return { kind: "invalid" };
    const rest = url.pathname.slice(personal.length);
    // Only a season pack's status URL carries the episode it plays.
    const status =
      /^\/status\/([1-9][0-9]{0,14})(\/[1-9][0-9]{0,3}\/[1-9][0-9]{0,3})?\.m3u8$/.exec(
        rest,
      );
    const carried =
      pin.pack && pin.episode
        ? `/${pin.episode.season}/${pin.episode.episode}`
        : undefined;
    if (
      status?.[1] &&
      status[2] === carried &&
      /^(?:\?wait=[0-5])?$/.test(url.search)
    )
      return { kind: "status", id: Number(status[1]), url: url.href };
    const notice = /^\/notice\/([a-z-]{1,32})\.m3u8$/.exec(rest);
    if (notice?.[1] && url.search === "")
      return {
        kind: "notice",
        notice: statusMediaKinds.find((kind) => kind === notice[1]) ?? "notice",
      };
    return { kind: "invalid" };
  };

  /** Stops each transfer at most once while the run is in progress. */
  const cancelOnce = (ids: readonly number[]) => {
    const due = ids.filter((id) => !cancelled.has(id));
    if (due.length === 0) return Effect.void;
    return provider.cancelTransfers(due).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          for (const id of due) cancelled.add(id);
        }),
      ),
    );
  };

  /** put.io's cancel only stops a seeding transfer; a later cancel removes it. */
  const removeTransfers = (ids: readonly number[]) =>
    Effect.gen(function* () {
      for (let round = 0; round < 3; round++) {
        const listed = yield* provider.listTransfers();
        const due = ids.filter((id) =>
          listed.some((transfer) => transfer.id === id),
        );
        if (due.length === 0) return;
        yield* provider.cancelTransfers(due);
      }
    });

  /** Charges bytes put.io reported past the pin, once, even past the cap. */
  const chargeExcess = (size: number) =>
    Effect.gen(function* () {
      proof.sizeExceeded = true;
      if (charged) return;
      charged = true;
      proof.excessCharged = yield* Effect.tryPromise(() =>
        charge(ledgerDirectory, size - pin.maxBytes),
      ).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    });

  /** The transfer's saved file, or every entry under its saved folder, within the adapter's walk limits. */
  const savedTree = Effect.fn("live.acquire.savedTree")(function* (
    rootId: number,
  ) {
    const root = yield* provider.getFile(rootId);
    if (!root?.name) return yield* fail(stage);
    if (root.fileType !== "FOLDER")
      return [{ id: rootId, name: root.name, fileType: root.fileType }];
    const entries: SavedEntry[] = [];
    const pending = [{ id: rootId, depth: 0 }];
    const visited = new Set<number>();
    for (let next = pending.shift(); next; next = pending.shift()) {
      if (visited.has(next.id) || visited.size >= 32 || next.depth > 8)
        return yield* fail(stage);
      visited.add(next.id);
      for (const entry of yield* provider.listFolder(next.id)) {
        entries.push(entry);
        if (entries.length > 5000) return yield* fail(stage);
        if (entry.fileType === "FOLDER")
          pending.push({ id: entry.id, depth: next.depth + 1 });
      }
    }
    return entries;
  });

  // Re-lists transfers and records the attributed transfer's file, and what a
  // saved folder holds, before any cancellation or deletion can drop them.
  // Runs on every exit after the GET.
  const record = Effect.gen(function* () {
    if (!selectionSent) return;
    const listed = yield* provider.listTransfers();
    for (const transfer of listed)
      if (
        !baselineTransfers.has(transfer.id) &&
        createdSince(transfer.created_at)
      )
        freshTransfers.add(transfer.id);
    recovery.freshTransfers = [...freshTransfers];
    if (freshTransfers.size > 1) ambiguous = true;
    recovery.ambiguous = ambiguous;
    if (attributed === undefined) {
      if (statusId !== undefined) {
        if (!baselineTransfers.has(statusId)) attributed = statusId;
      } else if (!ambiguous && freshTransfers.size === 1)
        attributed = [...freshTransfers][0];
    }
    recovery.statusTransfer = statusId;
    recovery.attributedTransfer = attributed;
    if (attributed !== undefined && !attempt.transfers.includes(attributed))
      attempt.transfers.push(attributed);
    // The adapter named a transfer, or put.io lists exactly one new one.
    if ((statusId !== undefined || attributed !== undefined) && !unattributed)
      attempt.pending = attempt.pending.filter(
        (item) => item.kind !== "transfer",
      );
    const own = listed.find((transfer) => transfer.id === attributed);
    if (own) {
      if (finished.has(own.status.trim().toUpperCase())) fileExpected = true;
      if (
        typeof own.file_id === "number" &&
        own.file_id > 0 &&
        !transferFiles.some((entry) => entry.file === own.file_id)
      )
        transferFiles.push({
          transfer: own.id,
          file: own.file_id,
          saveParent: own.save_parent_id ?? null,
          resolution: "unresolved",
        });
    }
    yield* checkpoint;
    // Exits before any size read (notices, timeouts) still pay for the excess.
    if (
      own &&
      typeof own.size === "number" &&
      Number.isSafeInteger(own.size) &&
      own.size > pin.maxBytes
    )
      yield* chargeExcess(own.size);
    for (const entry of transferFiles) {
      if (entry.resolution !== "unresolved") continue;
      if (baselineFiles.has(entry.file) || entry.saveParent === null) {
        entry.resolution = "retained";
        continue;
      }
      const file = yield* provider.getFile(entry.file);
      if (!file) entry.resolution = "absent";
      else if (
        file.parentId === entry.saveParent &&
        createdSince(file.createdAt)
      ) {
        entry.resolution = "owned";
        if (!attempt.files.includes(entry.file)) attempt.files.push(entry.file);
      } else entry.resolution = "retained";
    }
    for (const entry of transferFiles) {
      if (entry.resolution !== "owned") continue;
      const tree = Option.getOrUndefined(
        yield* savedTree(entry.file).pipe(Effect.option),
      );
      savedTrees.set(entry.file, tree);
      for (const item of tree ?? [])
        if (item.id !== entry.file) savedFiles.add(item.id);
    }
    recovery.savedFiles = [...savedFiles];
    // Counts only: what put.io saved, and how many names read as the pinned episode.
    const savedTypes: Record<string, number> = {};
    let episodeNames = 0;
    for (const tree of savedTrees.values())
      for (const item of tree ?? []) {
        const type =
          item.fileType && /^[A-Z_]{1,32}$/.test(item.fileType)
            ? item.fileType
            : "unknown";
        savedTypes[type] = (savedTypes[type] ?? 0) + 1;
        const named = pin.episode && namedEpisode(item.name);
        if (
          named &&
          named.season === pin.episode?.season &&
          named.episode === pin.episode.episode
        )
          episodeNames++;
      }
    if (savedTrees.size) {
      proof.savedTypes = savedTypes;
      if (pin.episode) proof.savedEpisodeNames = episodeNames;
    }
    yield* checkpoint;
  });

  const observe = Effect.fn("live.acquire.observe")(function* (
    transfer: ProviderTransfer,
  ) {
    const status = transfer.status.trim().toUpperCase();
    if (/^[A-Z_]{1,32}$/.test(status)) proof.providerStatus = status;
    if (finished.has(status)) {
      fileExpected = true;
      proof.selectionToCompletionMs ??= since();
    }
    const size = transfer.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1)
      return;
    sizeSeen = true;
    proof.sizeBucket = sizeBucket(size);
    if (size <= pin.maxBytes) return;
    // Without a recorded file the lifecycle reconciles before it cancels.
    yield* record.pipe(
      Effect.andThen(cancelOnce([transfer.id])),
      Effect.ignore,
    );
    yield* chargeExcess(size);
    return yield* fail("size-exceeded");
  });

  const sizeGate = (id: number) =>
    provider.getTransfer(id).pipe(
      Effect.option,
      Effect.flatMap((transfer) =>
        Option.isSome(transfer) ? observe(transfer.value) : Effect.void,
      ),
    );

  /** Checks the played file is the pinned episode inside the run's transfer. */
  const checkEpisode = Effect.fn("live.acquire.checkEpisode")(function* (
    transferId: number,
    played: number | undefined,
  ) {
    if (!pin.episode) return;
    // The adapter picks the episode from what put.io saved; this checks its pick.
    stage = "episode-identity";
    const saved = transferFiles.find(
      (entry) => entry.transfer === transferId && entry.resolution === "owned",
    );
    const tree = saved && savedTrees.get(saved.file);
    if (!tree || played === undefined) return yield* fail(stage);
    if (pin.pack)
      proof.packVideos = tree.filter(
        (entry) => entry.fileType === "VIDEO",
      ).length;
    const file = tree.find((entry) => entry.id === played);
    const named = file && namedEpisode(file.name);
    proof.playedInTransfer = file !== undefined;
    proof.playedEpisodeMatches =
      named?.season === pin.episode.season &&
      named.episode === pin.episode.episode;
    if (!proof.playedInTransfer || !proof.playedEpisodeMatches)
      return yield* fail(stage);
  });

  /** Fails once a second transfer was created since the baseline. */
  const limitTransfers = Effect.fn("live.acquire.limitTransfers")(function* (
    web: Record<string, unknown>,
  ) {
    web.transfersCreated = freshTransfers.size;
    if (freshTransfers.size <= 1 && !ambiguous) return;
    ambiguous = true;
    recovery.ambiguous = true;
    if (!unattributed && attributed !== undefined)
      attempt.pending.push({
        sequence: attempt.nextSequence++,
        kind: "transfer",
      });
    unattributed = true;
    yield* checkpoint;
    return yield* fail("web-transfers");
  });

  /**
   * Counts the transfers created since the baseline and attributes the only
   * one. A second one fails, is never attributed and leaves cleanup uncertain.
   */
  const checkTransfers = Effect.fn("live.acquire.checkTransfers")(function* (
    listed: readonly ProviderTransfer[],
    web: Record<string, unknown>,
  ) {
    for (const transfer of listed)
      if (
        !baselineTransfers.has(transfer.id) &&
        createdSince(transfer.created_at)
      )
        freshTransfers.add(transfer.id);
    recovery.freshTransfers = [...freshTransfers];
    yield* limitTransfers(web);
    const [only] = freshTransfers;
    if (attributed !== undefined || only === undefined) return;
    attributed = only;
    proof.attribution = "baseline-difference";
    proof.selectionToTransferMs = since();
    recovery.attributedTransfer = only;
    attempt.transfers.push(only);
    attempt.pending = attempt.pending.filter(
      (item) => item.kind !== "transfer",
    );
    yield* checkpoint;
  });

  /**
   * While Stremio Web waits, lists transfers on the poll interval, gates the
   * attributed one's size and ends the wait 20 minutes after the selection.
   * It only ever fails, which stops the page.
   */
  const watchWeb = Effect.fn("live.acquire.watchWeb")(function* (
    mediaReached: () => boolean,
    web: Record<string, unknown>,
  ) {
    for (;;) {
      yield* Effect.sleep(timing.pollIntervalMs);
      if (!selectionSent) continue;
      // A failed listing is read again on the next interval.
      const listed = yield* Effect.option(provider.listTransfers());
      if (Option.isSome(listed)) yield* checkTransfers(listed.value, web);
      if (attributed !== undefined) yield* sizeGate(attributed);
      if (
        !mediaReached() &&
        performance.now() >= selectionStarted + timing.acquisitionMs
      )
        return yield* fail("acquisition-timeout");
    }
  });

  /** Selects the pinned row in Stremio Web, which follows the adapter's redirects. */
  const playInWeb = Effect.fn("live.acquire.playInWeb")(function* (
    step: NonNullable<AcquireOptions["web"]>,
    playUrl: string,
  ) {
    stage = "web";
    const cleanup = {
      browserClosed: false,
      contextClosed: false,
      webClosed: false,
    };
    const web: Record<string, unknown> = { cleanup, transfersCreated: 0 };
    proof.web = web;
    let mediaReached = false;
    const videoId = pin.episode
      ? `${pin.imdbId}:${pin.episode.season}:${pin.episode.episode}`
      : pin.imdbId;
    const type = pin.episode ? "series" : "movie";
    const played = yield* Effect.raceFirst(
      step({
        manifestUrl: `${options.origin}${personal}/manifest.json`,
        credential: options.credential,
        detail: { type, id: pin.imdbId, videoId },
        streamPath: `${personal}/stream/${type}/${videoId}.json`,
        rowName: pin.pack ? "Download season to put.io" : "Download to put.io",
        selectedUrl: playUrl,
        listing: { attempts: 3, intervalMs: timing.pollIntervalMs },
        cleanup,
        onStage: (value) => {
          stage = `web-${value}`;
        },
        beforeSelection: Effect.sync(() => {
          selectionSent = true;
          selectionStarted = performance.now();
          attempt.pending.push({
            sequence: attempt.nextSequence++,
            kind: "transfer",
          });
        }).pipe(Effect.andThen(checkpoint)),
        onMedia: () => {
          mediaReached = true;
          fileExpected = true;
        },
      }).pipe(
        Effect.timeout(timing.acquisitionMs + timing.webMs),
        Effect.catch((error) =>
          Effect.fail(
            error instanceof AcquireWebNotice
              ? fail(
                  `adapter-${statusMediaKinds.find((kind) => kind === error.notice) ?? "notice"}`,
                )
              : error,
          ),
        ),
      ),
      watchWeb(() => mediaReached, web),
    );

    stage = "web-proof";
    // Copied field by field so nothing else the step returns reaches the receipt.
    Object.assign(web, {
      client: played.client,
      browser: played.browser,
      streamListings: played.streamListings,
      rowSelections: played.rowSelections,
      selections: played.selections,
      otherSelections: played.otherSelections,
      statusRequests: played.statusRequests,
      pendingNotices: played.pendingNotices,
      playlistResponses: played.playlistResponses,
      segmentResponses: played.segmentResponses,
      playedFiles: new Set(played.playedFiles).size,
      currentTime: [...played.currentTime],
      decodedFrames: [...played.decodedFrames],
    });
    proof.selectionToMediaMs = Math.round(played.selectionToMediaMs);
    if (
      played.rowSelections < 1 ||
      played.selections < 1 ||
      played.otherSelections !== 0 ||
      played.playlistResponses < 1 ||
      played.segmentResponses < 1 ||
      !(played.currentTime[1] > played.currentTime[0]) ||
      !(played.decodedFrames[1] > played.decodedFrames[0])
    )
      return yield* fail(stage);

    stage = "web-transfers";
    yield* checkTransfers(yield* provider.listTransfers(), web);
    if (attributed === undefined) return yield* fail("attribution");

    stage = "completion";
    yield* observe(yield* provider.getTransfer(attributed));
    if (!sizeSeen) return yield* fail("size-unknown");
    stage = "record";
    yield* record;
    // A transfer first listed by the record counts as well.
    stage = "web-transfers";
    yield* limitTransfers(web);
    const files = [...new Set(played.playedFiles)];
    const [playedFile] = files;
    if (files.length !== 1) return yield* fail("web-played-file");
    proof.locationNamesFile = transferFiles.some(
      (entry) => entry.file === playedFile,
    );
    yield* checkEpisode(attributed, playedFile);
    // Without a status URL only the played file ties playback to this transfer.
    const saved = transferFiles.find(
      (entry) => entry.transfer === attributed && entry.resolution === "owned",
    );
    proof.playedInTransfer =
      saved !== undefined &&
      (savedTrees.get(saved.file)?.some((entry) => entry.id === playedFile) ??
        false);
    if (!proof.playedInTransfer) return yield* fail("web-played-file");
    stage = "cancel";
    yield* cancelOnce(attempt.transfers);
    stage = "web-cleanup";
    if (!Object.values(cleanup).every(Boolean)) return yield* fail(stage);
    web.status = "passed";
  });

  const started = performance.now();

  const work = Effect.gen(function* () {
    const decoded = Schema.decodeUnknownOption(Pin)(options.pin);
    if (
      Option.isNone(decoded) ||
      !isCredential(options.credential) ||
      !validOrigin(options.origin) ||
      !options.username
    )
      return yield* fail(stage);
    const [season = 0, episode = 0] =
      decoded.value.episode?.split(":").map(Number) ?? [];
    pin = {
      imdbId: decoded.value.imdbId,
      releaseId: decoded.value.releaseId,
      maxBytes: Number(decoded.value.maxBytes),
      ...(decoded.value.episode !== undefined && {
        episode: { season, episode },
      }),
      pack: decoded.value.releaseId.startsWith(packPrefix),
    };
    if (pin.pack && !pin.episode) return yield* fail(stage);
    proof.release = pin.pack
      ? "season-pack"
      : pin.episode
        ? "episode"
        : "movie";
    const rpc = yield* createEngineRpc({
      baseUrl: options.engineBaseUrl,
      credential: options.credential,
    }).pipe(Effect.mapError(() => fail(stage)));
    stage = "allowance";
    ledgerDirectory = yield* Effect.tryPromise(options.ledgerDirectory);

    stage = "account";
    const account = yield* provider.accountInfo();
    if (account.username !== options.username) return yield* fail(stage);
    stage = "account-binding";
    if (!(yield* sameAccountRoot(rpc, provider.listFolderIds)))
      return yield* fail(stage);

    stage = "listing";
    const listing = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(
          pin.episode
            ? `${options.origin}${personal}/stream/series/${pin.imdbId}:${pin.episode.season}:${pin.episode.episode}.json`
            : `${options.origin}${personal}/stream/movie/${pin.imdbId}.json`,
          { signal, redirect: "manual" },
        );
        return { status: response.status, body: await response.text() };
      },
      catch: () => fail(stage),
    }).pipe(Effect.timeout(timing.requestMs));
    proof.listingStatus = listing.status;
    if (listing.status !== 200) return yield* fail(stage);
    const rows = (yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(
        Schema.Struct({
          streams: Schema.Array(
            Schema.Struct({
              name: Schema.optional(Schema.String),
              url: Schema.optional(Schema.String),
            }),
          ),
        }),
      ),
    )(listing.body).pipe(Effect.mapError(() => fail(stage)))).streams.filter(
      (row) =>
        row.name ===
        (pin.pack ? "Download season to put.io" : "Download to put.io"),
    );
    const episodePlay = pin.episode
      ? [
          `chill:episode:${pin.imdbId}:${pin.episode.season}:${pin.episode.episode}`,
          `${pin.releaseId}.m3u8`,
        ]
      : undefined;
    proof.downloadRows = rows.length;
    const playUrl = rows.find((row) => {
      if (!row.url || !URL.canParse(row.url)) return false;
      const url = new URL(row.url);
      const prefix = `${personal}/play/${episodePlay ? "series" : "movie"}/`;
      if (
        url.origin !== options.origin ||
        url.search !== "" ||
        !url.pathname.startsWith(prefix)
      )
        return false;
      try {
        if (episodePlay) {
          const segments = url.pathname
            .slice(prefix.length)
            .split("/")
            .map(decodeURIComponent);
          return (
            segments.length === 2 &&
            segments[0] === episodePlay[0] &&
            segments[1] === episodePlay[1]
          );
        }
        return (
          decodeURIComponent(url.pathname.split("/").at(-1) ?? "") ===
          `${pin.releaseId}.m3u8`
        );
      } catch {
        return false;
      }
    })?.url;
    proof.pinnedRow = playUrl !== undefined;
    if (!playUrl) return yield* fail("pinned-row-missing");

    stage = "baseline";
    runStart = Math.floor((yield* provider.serverTime()) / 1000) * 1000;
    recovery.runStart = new Date(runStart).toISOString();
    for (const transfer of yield* provider.listTransfers()) {
      baselineTransfers.add(transfer.id);
      if (typeof transfer.file_id === "number")
        baselineFiles.add(transfer.file_id);
    }
    recovery.baselineTransfers = [...baselineTransfers];
    recovery.baselineFiles = [...baselineFiles];
    proof.baselineTransfers = baselineTransfers.size;
    yield* checkpoint;

    stage = "reservation";
    yield* Effect.tryPromise((signal) =>
      reserve(ledgerDirectory, 1, pin.maxBytes, undefined, { signal }),
    );
    proof.reserved = true;

    stage = "head";
    const head = yield* request(playUrl, "HEAD");
    proof.headStatus = head.status;
    if (head.status !== 200) return yield* fail(stage);

    if (options.web) {
      yield* playInWeb(options.web, playUrl);
      stage = "done";
      return;
    }

    stage = "selection";
    let location = "";
    const transfer = yield* trackAcquisition(
      attempt,
      "transfer",
      Effect.gen(function* () {
        selectionSent = true;
        selectionStarted = performance.now();
        const response = yield* request(playUrl);
        proof.selectionStatus = response.status;
        if (response.status !== 302) return yield* fail(stage);
        location = response.location;
        const hop = classify(location);
        if (hop.kind === "status") {
          statusId = hop.id;
          proof.selectionToFirstStatusMs = since();
          if (baselineTransfers.has(hop.id)) {
            proof.attribution = "pre-existing";
            return yield* fail("attribution");
          }
          attributed = hop.id;
          proof.attribution = "status-url";
          return { id: hop.id };
        }
        if (hop.kind === "notice") return yield* fail(`adapter-${hop.notice}`);
        if (hop.kind !== "external") return yield* fail("redirect");
        // Engine answered without a status URL: only one new transfer may be it.
        const fresh = (yield* provider.listTransfers()).filter(
          (item) =>
            !baselineTransfers.has(item.id) && createdSince(item.created_at),
        );
        proof.freshTransfers = fresh.length;
        for (const item of fresh) freshTransfers.add(item.id);
        recovery.freshTransfers = [...freshTransfers];
        if (fresh.length > 1) ambiguous = true;
        const only = fresh.length === 1 ? fresh[0] : undefined;
        if (!only) return yield* fail("attribution");
        attributed = only.id;
        proof.attribution = "baseline-difference";
        return { id: only.id };
      }),
      checkpoint,
    );

    stage = "acquisition";
    const deadline = selectionStarted + timing.acquisitionMs;
    let lastRequest = selectionStarted;
    let statusUrl: string | undefined;
    let hop = classify(location);
    while (hop.kind !== "external") {
      if (hop.kind === "status") {
        if (hop.id !== statusId) return yield* fail("redirect");
        statusUrl = hop.url;
      } else if (hop.kind === "notice") {
        if (hop.notice !== "pending")
          return yield* fail(`adapter-${hop.notice}`);
        if (!statusUrl) return yield* fail("adapter-pending");
      } else return yield* fail("redirect");
      yield* sizeGate(transfer.id);
      const wait = lastRequest + timing.pollIntervalMs - performance.now();
      if (performance.now() + Math.max(0, wait) >= deadline)
        return yield* fail("acquisition-timeout");
      if (wait > 0) yield* Effect.sleep(wait);
      lastRequest = performance.now();
      proof.statusHops = Number(proof.statusHops) + 1;
      const response = yield* request(statusUrl);
      // Capacity refusals are transient; the same read is repeated.
      if (response.status === 503) {
        proof.statusRefusals = Number(proof.statusRefusals ?? 0) + 1;
        hop = { kind: "status", id: transfer.id, url: statusUrl };
        continue;
      }
      if (response.status !== 302) return yield* fail("status");
      location = response.location;
      hop = classify(location);
      if (hop.kind === "notice" && hop.notice === "pending")
        proof.pendingNotices = Number(proof.pendingNotices) + 1;
    }

    stage = "location";
    const media = mediaLocation(302, location, mediaOrigin);
    Object.assign(proof, media.checks);
    if (!media.ok) return yield* fail(stage);
    fileExpected = true;
    proof.selectionToMediaMs = since();

    stage = "completion";
    yield* observe(yield* provider.getTransfer(transfer.id));
    if (!sizeSeen) return yield* fail("size-unknown");
    stage = "record";
    yield* record;
    proof.locationNamesFile = transferFiles.some((entry) =>
      media.target?.pathname.includes(`/files/${entry.file}/`),
    );
    const played = /\/files\/([1-9][0-9]{0,15})\//.exec(
      media.target?.pathname ?? "",
    )?.[1];
    yield* checkEpisode(
      transfer.id,
      played === undefined ? undefined : Number(played),
    );
    stage = "cancel";
    yield* cancelOnce(attempt.transfers);

    stage = "decode";
    const decodeStarted = performance.now();
    const frames = yield* options
      .decode(location)
      .pipe(Effect.timeout(timing.decodeMs));
    proof.decode = {
      frames: frames.frames,
      codec: frames.codec,
      width: frames.width,
      height: frames.height,
      ms: Math.round(performance.now() - decodeStarted),
    };
    if (frames.frames < 1) return yield* fail(stage);
    stage = "done";
  }).pipe(
    Effect.timeout(timing.acquisitionMs + 10 * 60_000),
    Effect.catchCause((cause) => {
      const error = Cause.findErrorOption(cause);
      proof.failureStage =
        Option.isSome(error) && error.value instanceof AcquireProbeFailure
          ? error.value.stage
          : stage;
      if (Option.isSome(error) && error.value instanceof EngineError)
        proof.failureCode = error.value.code;
      return Effect.fail(fail(String(proof.failureStage)));
    }),
  );

  const verify = Effect.gen(function* () {
    if (
      attempt.pending.length > 0 ||
      (fileExpected && transferFiles.length === 0) ||
      [...savedTrees.values()].includes(undefined) ||
      transferFiles.some((entry) =>
        ["unresolved", "retained"].includes(entry.resolution),
      )
    )
      return "unverified" satisfies Verification;
    // A 404 while recording may have been transient; it must still hold.
    for (const entry of transferFiles)
      if (
        entry.resolution === "absent" &&
        !(yield* provider.fileAbsent(entry.file))
      )
        return "unverified" satisfies Verification;
    if (attempt.transfers.length === 0 && attempt.files.length === 0)
      return "not-needed" satisfies Verification;
    for (let round = 1; round <= timing.verifyAttempts; round++) {
      if (round > 1) yield* Effect.sleep(timing.verifyIntervalMs);
      const listed = yield* provider.listTransfers();
      const transfersGone = attempt.transfers.every(
        (id) => !listed.some((transfer) => transfer.id === id),
      );
      const filesGone = (yield* Effect.forEach(
        [...attempt.files, ...savedFiles],
        provider.fileAbsent,
      )).every(Boolean);
      if (transfersGone && filesGone) return "verified" satisfies Verification;
    }
    return "present" satisfies Verification;
  });

  yield* withLiveLifecycle(attempt, work, {
    reconcile: record,
    cancelTransfers: removeTransfers,
    deleteFiles: provider.deleteFiles,
    verify: verify.pipe(
      Effect.tap((verification) =>
        Effect.sync(() => {
          recovery.verification = verification;
        }),
      ),
    ),
    checkpoint,
    publish: (outcome) =>
      Effect.tryPromise(async () => {
        proof.totalMs = Math.round(performance.now() - started);
        proof.transferFilesRecorded = transferFiles.length;
        await mkdir(options.artifact, { recursive: true, mode: 0o700 });
        await writeFile(
          `${options.artifact}/results.json`,
          redactCredentials(
            `${JSON.stringify(
              {
                status: outcome.status,
                lane: "hosted acquisition",
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
  const env = (name: string) => process.env[name]?.trim();
  NodeRuntime.runMain(
    runAcquisition({
      credential: env("CHILL_STREMIO_CREDENTIAL") ?? "",
      origin:
        env("CHILL_PUBLIC_STREMIO_ORIGIN") || "https://stremio.chill.institute",
      engineBaseUrl:
        env("CHILL_ENGINE_BASE_URL") || "https://api.chill.institute/v4",
      username: env(liveVersions.usernameEnv),
      pin: {
        imdbId: env("LIVE_ACQUIRE_IMDB_ID"),
        releaseId: env("LIVE_ACQUIRE_RELEASE_ID"),
        episode: env("LIVE_ACQUIRE_EPISODE"),
        maxBytes: env("LIVE_ACQUIRE_MAX_BYTES"),
      },
      ledgerDirectory: () => liveRunnerDirectory(),
      provider: putio,
      decode: (url) =>
        decodeVideo(url).pipe(Effect.provide(NodeServices.layer)),
      artifact: `artifacts/live-acquire-${stamp}`,
      journal: `.cache/live/recovery/acquire-${stamp}.json`,
      web: acquireWebStep(env("LIVE_ACQUIRE_WEB")),
    }).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          if (outcome?.status !== "passed") process.exitCode = 1;
        }),
      ),
      Effect.catchCause(() =>
        Effect.sync(() => {
          process.exitCode = 1;
          console.log('{"status":"failed","code":"acquire_probe_failed"}');
        }),
      ),
    ),
    { disableErrorReporting: true },
  );
}
