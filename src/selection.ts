import { Clock, Effect, Fiber, Option } from "effect";
import type { Stream } from "stremio-addon-sdk";
import {
  AcquisitionEngine,
  addTransferTimeoutMs,
  inspectTransferFiles,
} from "./acquisition-engine.ts";
import {
  createDiscovery,
  discoveryBudgetMs,
  discoveryTargetId,
  releaseDescription,
  seasonPackPrefix,
  type SeasonEpisode,
} from "./discovery.ts";
import { responseReserveMs } from "./discovery-engine.ts";
import { EngineError } from "./engine.ts";
import { createLibrary, filePlayback } from "./library.ts";
import type { PlaybackResult } from "./playback-wait.ts";

export type Submission =
  | { transferId: bigint; episode?: SeasonEpisode }
  | { status: "unknown" | "reconnect" | "release-unavailable" };

/** Clips for the Engine refusals that leave no transfer behind. */
const refusalClips = {
  // The link's download folder is gone; a new link binds an existing one.
  stremio_folder_missing: "reconnect",
  putio_rate_limited: "release-unavailable",
  invalid_transfer_url: "release-unavailable",
} as const;

/** Long enough to resolve the target, find the release and receive Engine's shared add. */
export const submissionBudgetMs =
  2 * discoveryBudgetMs + addTransferTimeoutMs + responseReserveMs;

/** How long a listing waits for its optional lookups once its release rows are ready. */
const lookupGraceMs = 500;
/** The least time a listing gives its optional lookups, so a fast release search cannot cut them short. */
const lookupFloorMs = 2_000;

/** Release IDs with this prefix play a video already in the account, by file ID. */
export const ownedPrefix = "owned:";
/** The file ID an owned release ID names, if it is well formed. */
export function ownedFileId(releaseId: string) {
  if (!/^owned:[1-9][0-9]{0,18}$/.test(releaseId)) return undefined;
  const id = BigInt(releaseId.slice(ownedPrefix.length));
  return id <= 9223372036854775807n ? id : undefined;
}

// A late or failed optional lookup leaves its rows out.
const withinGrace = Effect.fn("Selection.withinGrace")(function* <A>(
  lookup: Fiber.Fiber<A> | undefined,
  startedAt: number,
) {
  if (!lookup) return undefined;
  const now = yield* Clock.currentTimeMillis;
  const result = yield* Fiber.join(lookup).pipe(
    Effect.timeoutOption(
      Math.max(lookupGraceMs, startedAt + lookupFloorMs - now),
    ),
  );
  yield* Fiber.interrupt(lookup);
  return Option.getOrUndefined(result);
});

/** Stremio release rows and selected-media playback for one add-on base URL. */
export function createSelection(options: { base: string }) {
  const discovery = createDiscovery();
  const streams = Effect.fn("Selection.streams")(function* (input: {
    type: string;
    id: string;
  }) {
    const startedAt = yield* Clock.currentTimeMillis;
    const target = yield* discovery.resolveTarget(input);
    const canonical = discoveryTargetId(target);
    const play = (releaseId: string) =>
      `${options.base}/play/${input.type}/${encodeURIComponent(canonical)}/${encodeURIComponent(releaseId)}.m3u8`;
    const lookup =
      target.kind === "episode"
        ? yield* discovery.seasonPack(target).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.forkChild,
          )
        : undefined;
    const subject = yield* discovery.subject(target);
    // Started before Search, so the account lookup runs alongside it.
    const owned = Option.isSome(subject)
      ? yield* discovery.ownedVideos(subject.value).pipe(
          Effect.orElseSucceed(() => []),
          Effect.forkChild,
        )
      : undefined;
    const releases = yield* discovery.releases(target, subject);
    const [videos, pack] = yield* Effect.all(
      [withinGrace(owned, startedAt), withinGrace(lookup, startedAt)],
      { concurrency: "unbounded" },
    );
    const rows: Stream[] = (videos ?? []).map((video) => ({
      name: "Play from put.io",
      title: video.name,
      url: play(`${ownedPrefix}${video.id}`),
      behaviorHints: { notWebReady: false },
    }));
    for (const release of releases.slice(0, 100))
      rows.push({
        name: "Download to put.io",
        title: `${release.title}\n${releaseDescription(release)}`,
        url: play(release.id),
        behaviorHints: { notWebReady: false },
      });
    if (pack && !releases.some((release) => release.id === pack.id)) {
      const details = [pack.resolution, pack.codec, pack.quality]
        .filter(Boolean)
        .join(" ");
      rows.push({
        name: "Download season to put.io",
        title: `Season ${pack.seasonNumber} pack${details ? ` · ${details}` : ""}\n${releaseDescription(pack)}`,
        url: play(`${seasonPackPrefix}${pack.id}`),
        behaviorHints: { notWebReady: false },
      });
    }
    return { streams: rows };
  });
  const submit = Effect.fn("Selection.submit")(function* (input: {
    type: string;
    id: string;
    releaseId: string;
  }) {
    const target = yield* discovery.resolveTarget(input);
    const release = yield* discovery.release(target, input.releaseId);
    const engine = yield* AcquisitionEngine;
    return yield* engine.addTransfer(release.url).pipe(
      Effect.map((transfer): Submission => ({
        transferId: transfer.id,
        episode: release.episode,
      })),
      // A lost response may still have created the transfer, so it is never retried.
      Effect.catch((error) =>
        ["unauthenticated", "permission_denied", "invalid_config"].includes(
          error.code,
        )
          ? Effect.fail(error)
          : Effect.succeed<Submission>({
              status: error.reason ? refusalClips[error.reason] : "unknown",
            }),
      ),
    );
  });
  /** A season pack selection plays only the video Engine names as its episode. */
  const status = Effect.fn("Selection.status")(function* (
    transferId: bigint,
    episode?: SeasonEpisode,
  ) {
    const engine = yield* AcquisitionEngine;
    const transfer = yield* engine.getTransfer(transferId);
    if (transfer.failed) return { status: "failed" } satisfies PlaybackResult;
    if (!transfer.isFinished)
      return { status: "pending" } satisfies PlaybackResult;
    const files = yield* inspectTransferFiles(transfer, {
      releaseInfo: episode !== undefined,
    }).pipe(
      Effect.catchTag("TransferTreeLimit", () => Effect.succeed(undefined)),
      Effect.catchTag("TransferFilesUntyped", () =>
        Effect.succeed("untyped" as const),
      ),
    );
    if (files === "untyped")
      return { status: "pending" } satisfies PlaybackResult;
    if (!files) return { status: "select-file" } satisfies PlaybackResult;
    const features = files.filter((video) => !video.sample);
    const candidates = episode
      ? features.filter(
          ({ releaseInfo: info }) =>
            info?.season === episode.season &&
            info.episode === episode.episode &&
            (!info.episodeEnd || info.episodeEnd === episode.episode),
        )
      : files.length === 1
        ? files
        : features;
    const file = candidates.length === 1 ? candidates[0] : undefined;
    if (!file)
      return {
        status: files.length ? "select-file" : "unavailable",
      } satisfies PlaybackResult;
    const playback = yield* createLibrary(file.parentId).playback({
      type: "movie",
      id: `chill:file:${file.id}`,
    });
    const url = playback.streams[0]?.url;
    return (
      url ? { url } : { status: playback.pending ? "pending" : "unavailable" }
    ) satisfies PlaybackResult;
  });
  /** A video already in the account plays without a transfer. */
  const owned = Effect.fn("Selection.owned")(function* (fileId: bigint) {
    const playback = yield* filePlayback(fileId).pipe(
      Effect.catchIf(
        (error) => error instanceof EngineError && error.code === "not_found",
        () => Effect.succeed({ case: "unavailable" } as const),
      ),
    );
    return (
      playback.case === "ready"
        ? { url: playback.url }
        : {
            status: playback.case === "pending" ? "preparing" : playback.case,
          }
    ) satisfies PlaybackResult;
  });
  return { streams, submit, status, owned };
}
