import { Clock, Effect, Schema } from "effect";
import {
  AudioCodec,
  Container,
  VideoCodec,
} from "@chill-institute/contracts/chill/v4/api_pb";
import type { MetaDetail, Stream } from "stremio-addon-sdk";
import { Engine } from "./engine.ts";

export class LibraryError extends Schema.TaggedError<LibraryError>()(
  "LibraryError",
  {
    code: Schema.Literals([
      "invalid_request",
      "invalid_response",
      "library_too_large",
    ]),
  },
) {}

const maxId = 9223372036854775807n;
const FileId = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: 1n, maximum: maxId }),
);
const FolderId = Schema.BigInt.check(
  Schema.isBetweenBigInt({ minimum: 0n, maximum: maxId }),
);
const ResourceRequest = Schema.Struct({
  type: Schema.Literal("movie"),
  id: Schema.String.check(Schema.isPattern(/^chill:file:[1-9][0-9]{0,18}$/)),
});
const CatalogRequest = Schema.Struct({
  type: Schema.Literal("movie"),
  id: Schema.Literal("library"),
  extra: Schema.optional(
    Schema.Struct({
      search: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
      skip: Schema.optional(
        Schema.String.check(Schema.isPattern(/^(0|[1-9][0-9]{0,4})$/)),
      ),
    }),
  ),
});
const File = Schema.Struct({
  id: FileId,
  name: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
  fileType: Schema.String,
});
const Folder = Schema.Struct({
  parent: Schema.Struct({ id: FolderId, fileType: Schema.Literal("FOLDER") }),
  files: Schema.Array(File).check(
    Schema.makeFilter(
      (files) => new Set(files.map((file) => file.id)).size === files.length,
    ),
  ),
});
const SecureUrl = Schema.String.check(
  Schema.isMaxLength(16384),
  Schema.makeFilter((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      Array.from(value).every(
        (character) =>
          character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
      )
    );
  }),
);
const PlaybackUrl = Schema.Struct({
  url: SecureUrl,
  expiry: Schema.Union([
    Schema.Struct({
      case: Schema.Literal("expiryUnknown"),
      value: Schema.Literal(true),
    }),
    Schema.Struct({
      case: Schema.Literal("expiresAt"),
      value: Schema.Struct({
        seconds: Schema.BigInt.check(
          Schema.isBetweenBigInt({
            minimum: -62135596800n,
            maximum: 253402300799n,
          }),
        ),
        nanos: Schema.Int.check(
          Schema.isBetween({ minimum: 0, maximum: 999999999 }),
        ),
      }),
    }),
  ]),
});
const Ready = Schema.Struct({
  media: PlaybackUrl,
  format: Schema.optional(
    Schema.Struct({
      container: Schema.Int,
      videoCodec: Schema.Int,
      audioCodec: Schema.Int,
    }),
  ),
  subtitles: Schema.Array(
    Schema.Struct({
      id: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
      language: Schema.String.check(Schema.isPattern(/^[a-z]{3}$/)),
      format: Schema.Literals([1, 2]),
      source: PlaybackUrl,
    }),
  ).check(
    Schema.isMaxLength(32),
    Schema.makeFilter(
      (tracks) =>
        new Set(tracks.map((track) => track.id)).size === tracks.length,
    ),
  ),
});
const Playback = Schema.Struct({
  result: Schema.Union([
    Schema.Struct({ case: Schema.Literal("ready"), value: Ready }),
    Schema.Struct({
      case: Schema.Literal("pending"),
      value: Schema.Struct({ reason: Schema.Literal(1) }),
    }),
    Schema.Struct({
      case: Schema.Literal("unavailable"),
      value: Schema.Struct({ reason: Schema.Literals([1, 2, 3]) }),
    }),
  ]),
});

const invalidRequest = () => new LibraryError({ code: "invalid_request" });
const invalidResponse = () => new LibraryError({ code: "invalid_response" });
const readId = Effect.fn("Library.readId")(function* (input: {
  type: string;
  id: string;
}) {
  const request = yield* Schema.decodeUnknownEffect(ResourceRequest)(
    input,
  ).pipe(Effect.mapError(invalidRequest));
  return yield* Schema.decodeUnknownEffect(FileId)(
    BigInt(request.id.slice("chill:file:".length)),
  ).pipe(Effect.mapError(invalidRequest));
});
// SDK metadata uses behaviorHints; DefinitelyTyped currently spells it behaviourHints.
type LibraryMeta = MetaDetail & { behaviorHints: { defaultVideoId: string } };
function metadata(file: typeof File.Type): LibraryMeta {
  const id = `chill:file:${file.id}`;
  return {
    id,
    type: "movie",
    name: file.name,
    behaviorHints: { defaultVideoId: id },
  };
}
const checkExpiry = Effect.fn("Library.checkExpiry")(function* (
  source: typeof PlaybackUrl.Type,
  now: number,
) {
  if (source.expiry.case === "expiresAt") {
    const expires =
      source.expiry.value.seconds * 1000000000n +
      BigInt(source.expiry.value.nanos);
    if (expires <= BigInt(now) * 1000000n) return yield* invalidResponse();
  }
  return source.url;
});

export function createLibrary(folderId: bigint, recursive = false) {
  const files = Effect.fn("Library.files")(function* (
    matches: (file: typeof File.Type) => boolean,
    limit: number,
  ) {
    yield* Schema.decodeUnknownEffect(FolderId)(folderId).pipe(
      Effect.mapError(invalidRequest),
    );
    const engine = yield* Engine;
    const pending = [{ id: folderId, depth: 0 }];
    const seen = new Set<bigint>(recursive ? [folderId] : []);
    const videos: Array<typeof File.Type> = [];
    let entries = 0;
    for (const current of pending) {
      const response = yield* engine.getFolder(current.id);
      const envelope = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ files: Schema.Array(Schema.Unknown) }),
      )(response).pipe(Effect.mapError(invalidResponse));
      entries += envelope.files.length;
      if (envelope.files.length > 5000 || entries > 50_000)
        return yield* new LibraryError({ code: "library_too_large" });
      const folder = yield* Schema.decodeUnknownEffect(Folder)(response).pipe(
        Effect.mapError(invalidResponse),
      );
      if (folder.parent.id !== current.id) return yield* invalidResponse();
      for (const file of folder.files) {
        if (seen.has(file.id)) return yield* invalidResponse();
        seen.add(file.id);
        if (file.fileType === "FOLDER" && recursive) {
          if (pending.length >= 1000 || current.depth >= 64)
            return yield* new LibraryError({ code: "library_too_large" });
          pending.push({ id: file.id, depth: current.depth + 1 });
        }
        if (file.fileType === "VIDEO" && matches(file)) videos.push(file);
      }
      if (videos.length >= limit) break;
    }
    return videos;
  });
  const resolvePlayback = Effect.fn("Library.playback")(function* (input: {
    type: string;
    id: string;
  }) {
    const id = yield* readId(input);
    const [file] = yield* files((entry) => entry.id === id, 1);
    const streams: Stream[] = [];
    if (!file) return { streams, pending: false };
    const engine = yield* Engine;
    const response = yield* engine.resolvePlayback(id);
    const playback = yield* Schema.decodeUnknownEffect(Playback)(response).pipe(
      Effect.mapError(invalidResponse),
    );
    if (playback.result.case !== "ready")
      return { streams, pending: playback.result.case === "pending" };
    const ready = playback.result.value;
    const now = yield* Clock.currentTimeMillis;
    const url = yield* checkExpiry(ready.media, now);
    const subtitles = yield* Effect.forEach(
      ready.subtitles,
      Effect.fn("Library.subtitle")(function* (track) {
        return {
          id: track.id,
          lang: track.language,
          url: yield* checkExpiry(track.source, now),
        };
      }),
    );
    streams.push({
      name: "chill.institute",
      title: file.name,
      url,
      subtitles,
      behaviorHints: {
        notWebReady: !(
          new URL(url).pathname.endsWith(".m3u8") ||
          (ready.format?.container === Container.MP4 &&
            ready.format.videoCodec === VideoCodec.H264 &&
            ready.format.audioCodec === AudioCodec.AAC)
        ),
      },
    });
    return { streams, pending: false };
  });
  return {
    catalog: Effect.fn("Library.catalog")(function* (input: {
      type: string;
      id: string;
      extra?: { search?: string; skip?: string };
    }) {
      const request = yield* Schema.decodeUnknownEffect(CatalogRequest)(
        input,
      ).pipe(Effect.mapError(invalidRequest));
      const query = request.extra?.search?.toLowerCase();
      const skip = Number(request.extra?.skip ?? "0");
      const selected = yield* files(
        (file) => !query || file.name.toLowerCase().includes(query),
        skip + 100,
      );
      return { metas: selected.slice(skip, skip + 100).map(metadata) };
    }),
    meta: Effect.fn("Library.meta")(function* (input: {
      type: string;
      id: string;
    }) {
      const id = yield* readId(input);
      const [file] = yield* files((entry) => entry.id === id, 1);
      return { meta: file ? metadata(file) : null };
    }),
    playback: resolvePlayback,
    streams: Effect.fn("Library.streams")(function* (input: {
      type: string;
      id: string;
    }) {
      const { streams } = yield* resolvePlayback(input);
      return { streams };
    }),
  };
}
