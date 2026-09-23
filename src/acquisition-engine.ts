import { Context, Effect, Layer, Schema } from "effect";
import { createEngineRpc, EngineError, type EngineAuth } from "./engine.ts";

const PositiveId = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: 1n, maximum: 9223372036854775807n }),
);
const FolderId = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: 0n, maximum: 9223372036854775807n }),
);
const File = Schema.Struct({
  id: PositiveId,
  name: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  fileType: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
});
const Folder = Schema.Struct({
  parent: Schema.Struct({
    id: FolderId,
    name: Schema.String.check(Schema.isMaxLength(4096)),
    fileType: Schema.Literal("FOLDER"),
  }),
  files: Schema.Array(File).check(
    Schema.isMaxLength(5000),
    Schema.makeFilter(
      (files) => new Set(files.map((file) => file.id)).size === files.length,
    ),
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

export type AcquisitionFile = typeof File.Type;
export type AcquiredVideo = AcquisitionFile & { parentId: bigint };
export type AcquisitionFolder = typeof Folder.Type;
export type AcquisitionTransfer = Omit<typeof Transfer.Type, "errorMessage"> & {
  failed: boolean;
};

export class AcquisitionEngine extends Context.Service<
  AcquisitionEngine,
  {
    getFolder(id: bigint): Effect.Effect<AcquisitionFolder, EngineError>;
    addTransfer(url: string): Effect.Effect<AcquisitionTransfer, EngineError>;
    getTransfer(id: bigint): Effect.Effect<AcquisitionTransfer, EngineError>;
  }
>()("chill-stremio/AcquisitionEngine") {}

const invalidResponse = () => new EngineError({ code: "invalid_response" });
const invalidConfig = () => new EngineError({ code: "invalid_config" });
const decodeTransfer = Effect.fn("Acquisition.decodeTransfer")(function* (
  response: unknown,
) {
  const { transfer } = yield* Schema.decodeUnknownEffect(
    Schema.Struct({ transfer: Transfer }),
  )(response).pipe(Effect.mapError(invalidResponse));
  const { errorMessage, ...fields } = transfer;
  return { ...fields, failed: errorMessage.trim() !== "" };
});

export function acquisitionEngineLayer(configuration: EngineAuth) {
  return Layer.effect(
    AcquisitionEngine,
    Effect.gen(function* () {
      const rpc = yield* createEngineRpc(configuration);
      return AcquisitionEngine.of({
        getFolder: Effect.fn("Acquisition.getFolder")(function* (id: bigint) {
          yield* Schema.decodeUnknownEffect(FolderId)(id).pipe(
            Effect.mapError(invalidConfig),
          );
          const folder = yield* Schema.decodeUnknownEffect(Folder)(
            yield* rpc.call((options) => rpc.client.getFolder({ id }, options)),
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
          // Once submitted, even a transport/decoding failure can mean the provider accepted it.
          return yield* decodeTransfer(
            yield* rpc.call((options) =>
              rpc.client.addTransfer({ url }, options),
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
  function* (transfer: AcquisitionTransfer) {
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
    if (result.fileType === "VIDEO")
      return [{ ...result, parentId: transfer.saveParentId }];
    if (result.fileType !== "FOLDER") return [];
    const pending = [{ id: result.id, depth: 0 }];
    const visited = new Set<bigint>([transfer.saveParentId]);
    const fileIds = new Set<bigint>();
    const videos: AcquiredVideo[] = [];
    let fileCount = destination.files.length;
    while (pending.length) {
      const next = pending.shift();
      if (!next) break;
      if (visited.has(next.id)) return yield* invalidResponse();
      if (visited.size >= 32 || next.depth > 8)
        return yield* new EngineError({ code: "resource_exhausted" });
      visited.add(next.id);
      const folder = yield* engine.getFolder(next.id);
      fileCount += folder.files.length;
      if (fileCount > 5000)
        return yield* new EngineError({ code: "resource_exhausted" });
      for (const file of folder.files) {
        if (fileIds.has(file.id)) return yield* invalidResponse();
        fileIds.add(file.id);
        if (file.fileType === "VIDEO")
          videos.push({ ...file, parentId: next.id });
        else if (file.fileType === "FOLDER")
          pending.push({ id: file.id, depth: next.depth + 1 });
      }
    }
    return videos;
  },
  Effect.timeoutOrElse({
    duration: "10 seconds",
    orElse: () => Effect.fail(new EngineError({ code: "deadline_exceeded" })),
  }),
);
