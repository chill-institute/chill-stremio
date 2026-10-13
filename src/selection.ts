import { Effect, Fiber, Option } from "effect";
import type { Stream } from "stremio-addon-sdk";
import {
  AcquisitionEngine,
  inspectTransferFiles,
} from "./acquisition-engine.ts";
import {
  createDiscovery,
  discoveryTargetId,
  releaseDescription,
  seasonPackPrefix,
  type SeasonEpisode,
} from "./discovery.ts";
import { createLibrary } from "./library.ts";
import type { PlaybackResult } from "./playback-wait.ts";

export type Submission =
  | { transferId: bigint; episode?: SeasonEpisode }
  | { status: "unknown" };

/** How long a listing waits for the season lookup once its episode rows are ready. */
const seasonPackGraceMs = 500;

/** Stremio release rows and selected-media playback for one add-on base URL. */
export function createSelection(options: { base: string }) {
  const discovery = createDiscovery();
  const streams = Effect.fn("Selection.streams")(function* (input: {
    type: string;
    id: string;
  }) {
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
    const releases = yield* discovery.releases(target);
    const rows: Stream[] = releases.slice(0, 100).map((release) => ({
      name: "Download to put.io",
      title: `${release.title}\n${releaseDescription(release)}`,
      url: play(release.id),
      behaviorHints: { notWebReady: false },
    }));
    if (!lookup) return { streams: rows };
    const pack = Option.getOrUndefined(
      yield* Fiber.join(lookup).pipe(Effect.timeoutOption(seasonPackGraceMs)),
    );
    yield* Fiber.interrupt(lookup);
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
          : Effect.succeed<Submission>({ status: "unknown" }),
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
    );
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
  return { streams, submit, status };
}
