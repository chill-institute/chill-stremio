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
import {
  InstallationFailure,
  type Acquisition,
  type Installation,
  type InstallationStore,
} from "./installations.ts";
import { createLibrary } from "./library.ts";
import type { StatusMediaKind } from "./status-media.ts";
import type { PlaybackResult } from "./playback-wait.ts";

const storeFailure = (error: unknown) =>
  error instanceof InstallationFailure
    ? error
    : new InstallationFailure("storage_unavailable");

export function createSelection(options: {
  store: InstallationStore;
  installation: Installation;
  origin: string;
}) {
  const { store, installation } = options;
  const discovery = createDiscovery();
  const base = `${options.origin}/i/${installation.capability}`;
  const operations = () =>
    Effect.try({
      try: () => store.operations(installation.id),
      catch: storeFailure,
    });
  const find = Effect.fn("Selection.find")(function* (id: string) {
    const operation = (yield* operations()).find((entry) => entry.id === id);
    if (!operation) return yield* new EngineError({ code: "not_found" });
    return operation;
  });
  const inspect = Effect.fn("Selection.inspect")(function* (
    operation: Acquisition,
  ) {
    if (!operation.transferId)
      return { status: "unknown" as const, percent: 0, files: [] };
    const engine = yield* AcquisitionEngine;
    const transfer = yield* engine.getTransfer(BigInt(operation.transferId));
    const files = yield* inspectTransferFiles(transfer);
    const status: StatusMediaKind = transfer.failed
      ? "failed"
      : !transfer.isFinished
        ? "pending"
        : files.length
          ? "select-file"
          : "unavailable";
    return { status, percent: transfer.percentDone, files };
  });
  const fileStreams = Effect.fn("Selection.fileStreams")(function* (
    operation: Acquisition,
  ) {
    const result = yield* inspect(operation);
    const groups = yield* Effect.forEach(
      result.files.slice(0, 100),
      (file) =>
        createLibrary(file.parentId)
          .streams({ type: "movie", id: `chill:file:${file.id}` })
          .pipe(
            Effect.map(({ streams }) =>
              streams.map((stream) => ({ ...stream, title: file.name })),
            ),
          ),
      { concurrency: 2 },
    );
    return { ...result, streams: groups.flat() };
  });
  const operationStreams = Effect.fn("Selection.operationStreams")(function* (
    id: string,
  ) {
    const operation = yield* find(id);
    const result = yield* fileStreams(operation);
    if (result.streams.length) return { streams: result.streams };
    const streams: Stream[] = [
      {
        name: "chill.institute",
        title: `${operation.title}\n${result.status === "pending" ? `Downloading to put.io · ${result.percent}%` : result.status === "unknown" ? "Download status unknown · do not submit again" : "Download unavailable"}`,
        url: `${base}/status/${operation.id}.m3u8`,
        behaviorHints: { notWebReady: false },
      },
    ];
    return { streams };
  });
  const streams = Effect.fn("Selection.streams")(function* (input: {
    type: string;
    id: string;
  }) {
    const target = yield* discovery.resolveTarget(input);
    const canonical = discoveryTargetId(target);
    const history = (yield* operations()).filter(
      (entry) => entry.target === canonical,
    );
    // Retain ready/unknown downloads even when their original search result has disappeared.
    const existing = yield* Effect.forEach(
      history,
      (operation) =>
        operationStreams(operation.id).pipe(
          Effect.catch((error) =>
            error.code === "not_found"
              ? Effect.succeed({ streams: [] })
              : Effect.fail(error),
          ),
        ),
      { concurrency: 2 },
    );
    const releases = yield* discovery.releases(target);
    const available: Stream[] = releases
      .filter(
        (release) => !history.some((entry) => entry.releaseId === release.id),
      )
      .slice(0, 100)
      .map((release) => ({
        name: "Download to put.io",
        title: `${release.title}\n${releaseDescription(release)}`,
        url: `${base}/play/${input.type}/${encodeURIComponent(canonical)}/${encodeURIComponent(release.id)}.m3u8`,
        behaviorHints: { notWebReady: false },
      }));
    return {
      streams: [
        ...existing.flatMap((group) => group.streams),
        ...available,
      ].slice(0, 100),
    };
  });
  const result = Effect.fn("Selection.result")(function* (
    operation: Acquisition,
  ) {
    const found = yield* inspect(operation);
    if (found.files.length !== 1)
      return {
        operationId: operation.id,
        status: found.status,
      } satisfies PlaybackResult;
    const file = found.files[0];
    if (!file)
      return { operationId: operation.id, status: "unavailable" as const };
    const playback = yield* createLibrary(file.parentId).playback({
      type: "movie",
      id: `chill:file:${file.id}`,
    });
    const url = playback.streams[0]?.url;
    return url
      ? { operationId: operation.id, url }
      : {
          operationId: operation.id,
          status: playback.pending
            ? ("pending" as const)
            : ("unavailable" as const),
        };
  });
  const play = Effect.fn("Selection.play")(function* (input: {
    type: string;
    id: string;
    releaseId: string;
  }) {
    const target = yield* discovery.resolveTarget(input);
    const canonical = discoveryTargetId(target);
    const prior = (yield* operations()).find(
      (entry) =>
        entry.target === canonical && entry.releaseId === input.releaseId,
    );
    if (prior) return yield* result(prior);
    const engine = yield* AcquisitionEngine;
    const profile = yield* engine.getProfile();
    const owned = yield* Effect.try({
      try: () =>
        store
          .list(profile.userId)
          .some((entry) => entry.id === installation.id),
      catch: storeFailure,
    });
    if (!owned) return yield* new EngineError({ code: "permission_denied" });
    const release = (yield* discovery.releases(target)).find(
      (entry) => entry.id === input.releaseId,
    );
    if (!release) return yield* new EngineError({ code: "not_found" });
    const claim = yield* Effect.try({
      try: () => {
        if (!store.resolve(installation.capability))
          throw new InstallationFailure("invalid_request");
        return store.claim(
          installation.id,
          canonical,
          release.id,
          release.title,
        );
      },
      catch: storeFailure,
    });
    if (claim.fresh) {
      yield* engine.addTransfer(release.url).pipe(
        Effect.flatMap((transfer) =>
          Effect.try({
            try: () =>
              store.submitted(
                installation.id,
                claim.operation.id,
                String(transfer.id),
              ),
            catch: storeFailure,
          }),
        ),
        Effect.catch(() => Effect.void),
      );
    }
    return yield* result(yield* find(claim.operation.id));
  });
  const downloads = Effect.fn("Selection.downloads")(function* () {
    const groups = yield* Effect.forEach(
      (yield* operations()).slice(0, 10),
      (operation) =>
        inspect(operation).pipe(
          Effect.map((state) => [
            {
              id: `chill:download:${operation.id}`,
              type: "movie" as const,
              name: `${operation.title} · ${state.status === "pending" ? `${state.percent}%` : state.status === "select-file" ? "Ready" : state.status}`,
              description:
                state.status === "unknown"
                  ? "Submission outcome unknown. Do not submit again."
                  : "Select to check this download and choose a completed video.",
            },
          ]),
          Effect.catch((error) =>
            error.code === "not_found"
              ? Effect.succeed([])
              : Effect.fail(error),
          ),
        ),
      { concurrency: 2 },
    );
    return { metas: groups.flat() };
  });
  return {
    streams,
    play,
    downloads,
    operationStreams,
    subtitles: Effect.fn("Selection.subtitles")(function* (input: {
      type: string;
      id: string;
      filename?: string;
    }) {
      let operation: Acquisition | undefined;
      if (
        input.type === "movie" &&
        /^chill:download:[0-9a-f-]{36}$/.test(input.id)
      ) {
        operation = (yield* operations()).find(
          (entry) => entry.id === input.id.slice("chill:download:".length),
        );
      } else {
        const filename = input.filename?.match(/^(.+)\.(?:mp4|m3u8)$/);
        if (!filename?.[1]) return { subtitles: [] };
        const releaseId = filename[1];
        const target = yield* discovery.resolveTarget(input);
        const canonical = discoveryTargetId(target);
        const matching = (yield* operations()).filter(
          (entry) =>
            entry.target === canonical &&
            (entry.releaseId === releaseId || entry.id === releaseId),
        );
        operation = matching.length === 1 ? matching[0] : undefined;
      }
      if (!operation) return { subtitles: [] };
      const result = yield* inspect(operation);
      if (result.files.length !== 1) return { subtitles: [] };
      const file = result.files[0];
      if (!file) return { subtitles: [] };
      const playback = yield* createLibrary(file.parentId).streams({
        type: "movie",
        id: `chill:file:${file.id}`,
      });
      return {
        subtitles: playback.streams.flatMap((stream) => stream.subtitles ?? []),
      };
    }),
    status: Effect.fn("Selection.status")(function* (id: string) {
      return yield* result(yield* find(id));
    }),
    meta: Effect.fn("Selection.meta")(function* (id: string) {
      const operation = yield* find(id);
      return {
        meta: {
          id: `chill:download:${id}`,
          type: "movie" as const,
          name: operation.title,
          behaviorHints: { defaultVideoId: `chill:download:${id}` },
        },
      };
    }),
  };
}
