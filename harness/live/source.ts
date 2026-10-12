import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import { generateMedia } from "../media.ts";
import { liveVersions } from "./versions.ts";

export class LiveSourceFailure extends Schema.TaggedError<LiveSourceFailure>()(
  "LiveSourceFailure",
  { message: Schema.String },
) {}

export interface LiveSource {
  path: string;
  captions: string;
  file: string;
  bytes: number;
  captionBytes: number;
  sha256: string;
}

const moviePath = () =>
  join(liveVersions.mediaDirectory, liveVersions.sourceFile);

export const subtitlePath = () =>
  join(liveVersions.mediaDirectory, liveVersions.subtitleFile);

const present = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

export const ensureLiveSource = Effect.fn("live.ensureLiveSource")(
  function* () {
    if (!(yield* Effect.tryPromise(() => present(moviePath()))))
      yield* Effect.tryPromise((signal) =>
        generateMedia(liveVersions.mediaDirectory, signal),
      ).pipe(Effect.timeout("3 minutes"));
    const path = moviePath();
    const captions = subtitlePath();
    if (
      !(yield* Effect.tryPromise(() => present(path))) ||
      !(yield* Effect.tryPromise(() => present(captions)))
    )
      return yield* new LiveSourceFailure({
        message: "Self-generated fixture movie or English captions are missing",
      });
    const [bytes, captionBytes, sha256] = yield* Effect.tryPromise(async () => {
      const [info, captionInfo, content] = await Promise.all([
        stat(path),
        stat(captions),
        readFile(path),
      ]);
      return [
        info.size,
        captionInfo.size,
        createHash("sha256").update(content).digest("hex"),
      ] as const;
    });
    if (
      !Number.isInteger(bytes) ||
      bytes < 1 ||
      !Number.isInteger(captionBytes) ||
      captionBytes < 1
    )
      return yield* new LiveSourceFailure({
        message: "Self-generated fixture movie or captions are empty",
      });
    return {
      path,
      captions,
      file: liveVersions.sourceFile,
      bytes,
      captionBytes,
      sha256,
    } satisfies LiveSource;
  },
);

export const liveFolderName = (stamp: string) =>
  `${liveVersions.folderPrefix}-${stamp}`;

export const liveMediaBase = (stamp: string) =>
  `${liveVersions.folderPrefix}-${stamp}-movie`;

export const liveUploadName = (stamp: string) => `${liveMediaBase(stamp)}.mp4`;

export const liveSubtitleName = (stamp: string) =>
  `${liveMediaBase(stamp)}.en.srt`;

export const fixtureSrt = () =>
  `1\n00:00:00,000 --> 00:00:35,900\n${liveVersions.fixtureSubtitle}\n`;

/** BitTorrent v1 info hash of a single-file torrent. */
export function singleFileInfoHash(
  name: string,
  payload: Uint8Array,
  pieceLength = 16_384,
) {
  const pieces: Buffer[] = [];
  for (let offset = 0; offset < payload.length; offset += pieceLength)
    pieces.push(
      createHash("sha1")
        .update(payload.subarray(offset, offset + pieceLength))
        .digest(),
    );
  const string = (bytes: Uint8Array) =>
    Buffer.concat([Buffer.from(`${bytes.length}:`), bytes]);
  // Bencoded dictionary keys must appear in raw byte order.
  const info = Buffer.concat([
    Buffer.from(`d6:lengthi${payload.length}e4:name`),
    string(Buffer.from(name)),
    Buffer.from(`12:piece lengthi${pieceLength}e6:pieces`),
    string(Buffer.concat(pieces)),
    Buffer.from("e"),
  ]);
  return createHash("sha1").update(info).digest("hex");
}

/**
 * A magnet for the generated English captions under a per-run name. Nobody
 * holds that torrent, so a transfer for it never downloads.
 */
export const reuseSource = (nonce: string) => {
  const name = `${liveVersions.folderPrefix}-reuse-${nonce}.srt`;
  const payload = Buffer.from(fixtureSrt());
  const infoHash = singleFileInfoHash(name, payload);
  return {
    name,
    bytes: payload.length,
    infoHash,
    magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}`,
  };
};
