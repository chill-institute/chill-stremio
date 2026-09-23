import { Effect } from "effect";
import type { Stream } from "stremio-addon-sdk";
import {
  AcquisitionEngine,
  inspectTransferFiles,
} from "./acquisition-engine.ts";
import {
  createDiscovery,
  discoveryTargetId,
  releaseDescription,
} from "./discovery.ts";
import { EngineError } from "./engine.ts";
import { createLibrary } from "./library.ts";
import type { PlaybackResult } from "./playback-wait.ts";

export type Submission = { transferId: bigint } | { status: "unknown" };

/** Stremio release rows and selected-media playback for one add-on base URL. */
export function createSelection(options: { base: string }) {
  const discovery = createDiscovery();
  const streams = Effect.fn("Selection.streams")(function* (input: {
    type: string;
    id: string;
  }) {
    const target = yield* discovery.resolveTarget(input);
    const canonical = discoveryTargetId(target);
    const releases = yield* discovery.releases(target);
    const rows: Stream[] = releases.slice(0, 100).map((release) => ({
      name: "Download to put.io",
      title: `${release.title}\n${releaseDescription(release)}`,
      url: `${options.base}/play/${input.type}/${encodeURIComponent(canonical)}/${encodeURIComponent(release.id)}.m3u8`,
      behaviorHints: { notWebReady: false },
    }));
    return { streams: rows };
  });
  const submit = Effect.fn("Selection.submit")(function* (input: {
    type: string;
    id: string;
    releaseId: string;
  }) {
    const target = yield* discovery.resolveTarget(input);
    const release = (yield* discovery.releases(target)).find(
      (entry) => entry.id === input.releaseId,
    );
    if (!release) return yield* new EngineError({ code: "not_found" });
    const engine = yield* AcquisitionEngine;
    return yield* engine.addTransfer(release.url).pipe(
      Effect.map((transfer): Submission => ({ transferId: transfer.id })),
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
  const status = Effect.fn("Selection.status")(function* (transferId: bigint) {
    const engine = yield* AcquisitionEngine;
    const transfer = yield* engine.getTransfer(transferId);
    if (transfer.failed) return { status: "failed" } satisfies PlaybackResult;
    if (!transfer.isFinished)
      return { status: "pending" } satisfies PlaybackResult;
    const files = yield* inspectTransferFiles(transfer);
    const file = files.length === 1 ? files[0] : undefined;
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
