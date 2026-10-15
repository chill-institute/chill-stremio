import { Context, Effect, Layer, Schema } from "effect";
import { engineTimeout } from "./discovery-engine.ts";
import { createEngineRpc, EngineError, type EngineAuth } from "./engine.ts";

// Engine finishes a shared add within 20 seconds even after its caller leaves,
// so waiting slightly longer receives the outcome instead of losing it.
export const addTransferTimeoutMs = 21_000;

const PositiveId = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: 1n, maximum: 9223372036854775807n }),
);
const FolderId = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: 0n, maximum: 9223372036854775807n }),
);
const fileFields = {
  id: PositiveId,
  name: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  fileType: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
};
const ReleaseFile = Schema.Struct({
  ...fileFields,
  releaseInfo: Schema.optional(
    Schema.Struct({
      season: Schema.optional(Schema.Int),
      episode: Schema.optional(Schema.Int),
      episodeEnd: Schema.optional(Schema.Int),
    }),
  ),
});
const folderFields = {
  parent: Schema.Struct({
    id: FolderId,
    name: Schema.String.check(Schema.isMaxLength(4096)),
    fileType: Schema.Literal("FOLDER"),
  }),
};
const uniqueFiles = (files: readonly { id: bigint }[]) =>
  new Set(files.map((file) => file.id)).size === files.length;
const Folder = Schema.Struct({
  ...folderFields,
  files: Schema.Array(Schema.Struct(fileFields)).check(
    Schema.isMaxLength(5000),
    Schema.makeFilter(uniqueFiles),
  ),
});
const ReleaseFolder = Schema.Struct({
  ...folderFields,
  files: Schema.Array(ReleaseFile).check(
    Schema.isMaxLength(5000),
    Schema.makeFilter(uniqueFiles),
  ),
});
const Transfer = Schema.Struct({
  id: PositiveId,
  status: Schema.String.check(
    Schema.isPattern(/^[A-Za-z][A-Za-z0-9_ -]{0,63}$/),
  ),
  percentDone: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  isFinished: Schema.Boolean,
  fileId: Schema.optional(PositiveId),
  saveParentId: Schema.optional(FolderId),
  errorMessage: Schema.String.check(Schema.isMaxLength(4096)),
});
const TransferUrl = Schema.String.check(
  Schema.isMaxLength(16384),
  Schema.makeFilter((value) => {
    if (
      !URL.canParse(value) ||
      Array.from(value).some(
        (character) =>
          character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      return false;
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "magnet:" &&
      !url.hostname &&
      url.searchParams
        .getAll("xt")
        .some(
          (topic) =>
            /^urn:btih:([a-fA-F0-9]{40}|[A-Z2-7]{32})$/.test(topic) ||
            /^urn:btmh:1220[a-fA-F0-9]{64}$/.test(topic),
        )
    );
  }),
);

/** Release info is present only in listings that asked for it. */
export type AcquisitionFile = typeof ReleaseFile.Type;
export type AcquiredVideo = AcquisitionFile & {
  parentId: bigint;
  sample: boolean;
};
export type AcquisitionFolder = typeof ReleaseFolder.Type;
export type AcquisitionTransfer = Omit<typeof Transfer.Type, "errorMessage"> & {
  failed: boolean;
};

export class AcquisitionEngine extends Context.Service<
  AcquisitionEngine,
  {
    getFolder(
      id: bigint,
      options?: { releaseInfo?: boolean },
    ): Effect.Effect<AcquisitionFolder, EngineError>;
    addTransfer(url: string): Effect.Effect<AcquisitionTransfer, EngineError>;
    getTransfer(id: bigint): Effect.Effect<AcquisitionTransfer, EngineError>;
  }
>()("chill-stremio/AcquisitionEngine") {}

/** A transfer result too large, deep or slow to list completely. */
export class TransferTreeLimit extends Schema.TaggedError<TransferTreeLimit>()(
  "TransferTreeLimit",
  {},
) {}

/** A finished download still holds a video put.io has not typed yet. */
export class TransferFilesUntyped extends Schema.TaggedError<TransferFilesUntyped>()(
  "TransferFilesUntyped",
  {},
) {}

// put.io types a new file as a plain file for its first seconds.
const untypedVideo = (file: { fileType: string; name: string }) =>
  file.fileType === "FILE" &&
  /\.(avi|m4v|mkv|mov|mp4|ts|webm|wmv)$/i.test(file.name);

const nameTokens = (name: string) =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== "");
const sampleFolder = (name: string) => {
  const tokens = nameTokens(name);
  return (
    tokens.length === 1 && (tokens[0] === "sample" || tokens[0] === "samples")
  );
};
const sampleVideo = (name: string) =>
  nameTokens(name.replace(/\.[^.]*$/, "")).at(-1) === "sample";

const invalidResponse = () => new EngineError({ code: "invalid_response" });
const invalidConfig = () => new EngineError({ code: "invalid_config" });
const decodeTransfer = Effect.fn("Acquisition.decodeTransfer")(function* (
  response: unknown,
) {
  const { transfer } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ transfer: Transfer }),
  )(response).pipe(Effect.mapError(invalidResponse));
  const { errorMessage, ...fields } = transfer;
  return {
    ...fields,
    // Engine counts a transfer with a file as finished, but put.io is still
    // moving its files in while it reports COMPLETING.
    isFinished: fields.isFinished && fields.status !== "COMPLETING",
    failed: errorMessage.trim() !== "",
  };
});

export function acquisitionEngineLayer(configuration: EngineAuth) {
  return Layer.effect(
    AcquisitionEngine,
    Effect.gen(function* () {
      const rpc = yield* createEngineRpc(configuration);
      return AcquisitionEngine.of({
        getFolder: Effect.fn("Acquisition.getFolder")(function* (
          id: bigint,
          { releaseInfo = false }: { releaseInfo?: boolean } = {},
        ) {
          yield* Schema.decodeUnknownEffect(FolderId)(id).pipe(
            Effect.mapError(invalidConfig),
          );
          const response = yield* rpc.call((options) =>
            rpc.client.getFolder(
              { id, includeReleaseInfo: releaseInfo },
              options,
            ),
          );
          const folder: AcquisitionFolder = yield* (
            releaseInfo
              ? Schema.decodeUnknownEffect(ReleaseFolder)(response)
              : Schema.decodeUnknownEffect(Folder)(response)
          ).pipe(Effect.mapError(invalidResponse));
          if (folder.parent.id !== id) return yield* invalidResponse();
          return folder;
        }),
        addTransfer: Effect.fn("Acquisition.addTransfer")(function* (
          input: string,
        ) {
          const url = yield* Schema.decodeUnknownEffect(TransferUrl)(
            input,
          ).pipe(Effect.mapError(invalidConfig));
          const timeoutMs = yield* engineTimeout(addTransferTimeoutMs);
          // Once submitted, even a transport/decoding failure can mean the provider accepted it.
          return yield* decodeTransfer(
            yield* rpc.call((options) =>
              rpc.client.addTransfer({ url }, { ...options, timeoutMs }),
            ),
          );
        }),
        getTransfer: Effect.fn("Acquisition.getTransfer")(function* (
          id: bigint,
        ) {
          yield* Schema.decodeUnknownEffect(PositiveId)(id).pipe(
            Effect.mapError(invalidConfig),
          );
          const transfer = yield* decodeTransfer(
            yield* rpc.call((options) =>
              rpc.client.getTransfer({ id }, options),
            ),
          );
          if (transfer.id !== id) return yield* invalidResponse();
          return transfer;
        }),
      });
    }),
  );
}

export const inspectTransferFiles = Effect.fn(
  "Acquisition.inspectTransferFiles",
)(
  function* (
    transfer: AcquisitionTransfer,
    options: { releaseInfo?: boolean } = {},
  ) {
    if (
      !transfer.isFinished ||
      transfer.failed ||
      transfer.fileId === undefined
    )
      return [];
    if (transfer.saveParentId === undefined) return yield* invalidResponse();
    const engine = yield* AcquisitionEngine;
    const destination = yield* engine.getFolder(transfer.saveParentId);
    const result = destination.files.find(
      (file) => file.id === transfer.fileId,
    );
    if (!result) return [];
    if (untypedVideo(result)) return yield* new TransferFilesUntyped();
    if (result.fileType === "VIDEO")
      return [
        {
          ...result,
          parentId: transfer.saveParentId,
          sample: sampleVideo(result.name),
        },
      ];
    if (result.fileType !== "FOLDER") return [];
    const pending = [{ id: result.id, depth: 0, sample: false }];
    const visited = new Set<bigint>([transfer.saveParentId]);
    const fileIds = new Set<bigint>();
    const videos: AcquiredVideo[] = [];
    let untyped = false;
    let fileCount = destination.files.length;
    while (pending.length) {
      const next = pending.shift();
      if (!next) break;
      if (visited.has(next.id)) return yield* invalidResponse();
      if (visited.size >= 32 || next.depth > 8)
        return yield* new TransferTreeLimit();
      visited.add(next.id);
      const folder = yield* engine.getFolder(next.id, options);
      fileCount += folder.files.length;
      if (fileCount > 5000) return yield* new TransferTreeLimit();
      for (const file of folder.files) {
        if (fileIds.has(file.id)) return yield* invalidResponse();
        fileIds.add(file.id);
        if (file.fileType === "VIDEO")
          videos.push({
            ...file,
            parentId: next.id,
            sample: next.sample || sampleVideo(file.name),
          });
        else if (file.fileType === "FOLDER")
          pending.push({
            id: file.id,
            depth: next.depth + 1,
            sample: next.sample || sampleFolder(file.name),
          });
        else if (untypedVideo(file)) untyped = true;
      }
    }
    if (untyped) return yield* new TransferFilesUntyped();
    return videos;
  },
  Effect.timeoutOrElse({
    duration: "10 seconds",
    orElse: () => Effect.fail(new TransferTreeLimit()),
  }),
);
