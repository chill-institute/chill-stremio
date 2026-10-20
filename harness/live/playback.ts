import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  inspectAudio,
  inspectFrame,
  pcmDbfsMin,
  seekMarkerMax,
  seekMarkerMin,
  type FrameEvidence,
} from "../native/desktop-evidence.ts";
import { redactLive } from "./redact.ts";

export class LivePlaybackFailure extends Schema.TaggedError<LivePlaybackFailure>()(
  "LivePlaybackFailure",
  { message: Schema.String },
) {}

export const rangeSupported = (status: number) => status === 206;

export const hlsAdvertisesSubtitles = (playlist: string) =>
  /TYPE=SUBTITLES|#EXT-X-MEDIA:.*SUBTITLES|WEBVTT/i.test(playlist);

export const firstHttpsUri = (playlist: string) => {
  const quoted = playlist.match(/URI="(https:\/\/[^"]+)"/i)?.[1];
  if (quoted) return quoted;
  return playlist.match(/URI=(https:\/\/[^\s",]+)/i)?.[1];
};

const download = Effect.fn("live.playback.download")(function* (
  url: string,
  path: string,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(url, { signal }),
    catch: (cause) =>
      new LivePlaybackFailure({ message: redactLive(String(cause)) }),
  });
  if (!response.ok)
    return yield* new LivePlaybackFailure({
      message: `Download HTTP ${response.status}`,
    });
  const bytes = yield* Effect.tryPromise({
    try: () => response.arrayBuffer(),
    catch: (cause) =>
      new LivePlaybackFailure({ message: redactLive(String(cause)) }),
  });
  yield* Effect.tryPromise(() => writeFile(path, Buffer.from(bytes)));
}, Effect.timeout("60 seconds"));

export const rangeStatus = Effect.fn("live.playback.rangeStatus")(function* (
  url: string,
  range: string,
) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        headers: { range },
        signal,
      }),
    catch: (cause) =>
      new LivePlaybackFailure({ message: redactLive(String(cause)) }),
  });
  yield* Effect.tryPromise(() => response.arrayBuffer().catch(() => undefined));
  return response.status;
}, Effect.timeout("20 seconds"));

export const proveUrlRenewal = Effect.fn("live.playback.proveUrlRenewal")(
  function* (previousUrl: string, resolvedUrl: string) {
    const secondRange = yield* rangeStatus(resolvedUrl, "bytes=0-1023");
    if (!rangeSupported(secondRange))
      return yield* new LivePlaybackFailure({
        message: `Resolved download URL did not honor HTTP Range (${secondRange})`,
      });
    return { distinct: previousUrl !== resolvedUrl, secondRange };
  },
);

const runTool = Effect.fn("live.playback.runTool")(
  function* (
    command: "ffmpeg" | "ffprobe",
    args: string[],
    cwd = process.cwd(),
  ) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        command,
        ["-hide_banner", "-loglevel", "error", ...args],
        {
          cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
        },
      ),
    );
    let output = "";
    let diagnostic = "";
    const [, , code] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((text) =>
            Effect.sync(() => {
              output = (output + text).slice(-65_536);
            }),
          ),
        ),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((text) =>
            Effect.sync(() => {
              diagnostic = (diagnostic + text).slice(-1000);
            }),
          ),
        ),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (code !== ChildProcessSpawner.ExitCode(0))
      return yield* new LivePlaybackFailure({
        message: redactLive(
          `${command} failed (${code})${diagnostic ? `: ${diagnostic}` : ""}`,
        ),
      });
    return output;
  },
  Effect.timeout("30 seconds"),
  Effect.scoped,
);

const extract = (args: string[], cwd?: string) =>
  Effect.asVoid(runTool("ffmpeg", args, cwd));

const VideoProbe = Schema.fromJsonString(
  Schema.Struct({
    streams: Schema.Tuple([
      Schema.Struct({
        codec_name: Schema.String.check(Schema.isPattern(/^[a-z0-9_]{1,32}$/)),
        width: Schema.Int,
        height: Schema.Int,
      }),
    ]),
  }),
);

/** Decodes up to `seconds` of a media URL's first video stream to nowhere. */
export const decodeVideo = Effect.fn("live.playback.decodeVideo")(function* (
  url: string,
  seconds = 10,
) {
  const probe = yield* Schema.decodeUnknownEffect(VideoProbe)(
    yield* runTool("ffprobe", [
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height",
      "-of",
      "json",
      url,
    ]),
  ).pipe(
    Effect.mapError(
      () => new LivePlaybackFailure({ message: "No video stream to decode" }),
    ),
  );
  const progress = yield* runTool("ffmpeg", [
    "-nostdin",
    "-nostats",
    "-progress",
    "pipe:1",
    "-t",
    String(seconds),
    "-i",
    url,
    "-map",
    "0:v:0",
    "-f",
    "null",
    "-",
  ]);
  const [{ codec_name: codec, width, height }] = probe.streams;
  const frames = Number(
    [...progress.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1] ?? 0,
  );
  return { frames, codec, width, height };
});

const MediaProbe = Schema.fromJsonString(
  Schema.Struct({
    format: Schema.Struct({ format_name: Schema.String }),
    streams: Schema.Array(
      Schema.Struct({
        codec_type: Schema.String,
        codec_name: Schema.String,
        width: Schema.optional(Schema.Int),
        height: Schema.optional(Schema.Int),
      }),
    ),
  }),
);

const probeMedia = Effect.fn("live.playback.probeMedia")(function* (
  path: string,
) {
  return yield* Schema.decodeUnknownEffect(MediaProbe)(
    yield* runTool("ffprobe", [
      "-show_entries",
      "format=format_name:stream=codec_type,codec_name,width,height",
      "-of",
      "json",
      path,
    ]),
  ).pipe(
    Effect.mapError(
      () =>
        new LivePlaybackFailure({ message: "ffprobe output failed schema" }),
    ),
  );
});

/**
 * Copies a movie's streams unchanged into Matroska under a new title, then
 * requires ffprobe to read a Matroska file with the same streams.
 */
export const remuxMatroska = Effect.fn("live.remuxMatroska")(function* (
  movie: string,
  output: string,
  title: string,
) {
  yield* extract([
    "-y",
    "-i",
    movie,
    "-map",
    "0",
    "-c",
    "copy",
    "-map_metadata",
    "-1",
    "-metadata",
    `title=${title}`,
    "-f",
    "matroska",
    output,
  ]);
  const [source, copy] = yield* Effect.all([
    probeMedia(movie),
    probeMedia(output),
  ]);
  const streams = (probe: typeof MediaProbe.Type) =>
    JSON.stringify(
      probe.streams.map((stream) => [
        stream.codec_type,
        stream.codec_name,
        stream.width,
        stream.height,
      ]),
    );
  if (
    !copy.format.format_name.split(",").includes("matroska") ||
    !source.streams.some((stream) => stream.codec_type === "video") ||
    streams(copy) !== streams(source)
  )
    return yield* new LivePlaybackFailure({
      message: "Matroska copy does not carry the movie's streams",
    });
});

export const muxFixtureCaptions = Effect.fn("live.muxFixtureCaptions")(
  function* (movie: string, captions: string, output: string) {
    yield* extract([
      "-y",
      "-i",
      movie,
      "-i",
      captions,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-map",
      "1:0",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-c:s",
      "mov_text",
      "-metadata:s:s:0",
      "language=eng",
      output,
    ]);
  },
);

export const overlayFixtureSubtitles = Effect.fn(
  "live.overlayFixtureSubtitles",
)(function* (directory: string, captions: string) {
  yield* Effect.tryPromise(() =>
    writeFile(join(directory, "subs.vtt"), captions),
  );
  yield* extract(
    [
      "-y",
      "-ss",
      "2",
      "-i",
      "download.mp4",
      "-vf",
      "subtitles=subs.vtt",
      "-frames:v",
      "1",
      "subtitles-on.png",
    ],
    directory,
  );
  return yield* Effect.tryPromise(() =>
    inspectFrame(join(directory, "subtitles-on.png")),
  );
});

export interface LivePlaybackEvidence {
  decoded: FrameEvidence;
  seek: FrameEvidence;
  audioDbfs: number;
  rangeStart: number;
  rangeMid: number;
  urlRenewalDistinct: boolean;
}

export const proveLivePlayback = Effect.fn("live.proveLivePlayback")(function* (
  urls: readonly [string, string],
  directory: string,
) {
  const [first, second] = urls;
  yield* Effect.tryPromise(() => mkdir(directory, { recursive: true }));
  const media = join(directory, "download.mp4");
  const start = join(directory, "start.png");
  const seek = join(directory, "seek.png");
  const audio = join(directory, "audio.wav");
  const rangeStart = yield* rangeStatus(first, "bytes=0-1023");
  const rangeMid = yield* rangeStatus(first, "bytes=20480-21503");
  yield* download(first, media);
  yield* extract(["-y", "-ss", "2", "-i", media, "-frames:v", "1", start]);
  yield* extract(["-y", "-ss", "20", "-i", media, "-frames:v", "1", seek]);
  yield* extract([
    "-y",
    "-i",
    media,
    "-t",
    "2",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    audio,
  ]);
  const decoded = yield* Effect.tryPromise(() => inspectFrame(start));
  const sought = yield* Effect.tryPromise(() => inspectFrame(seek));
  const audioDbfs = yield* Effect.tryPromise(() => inspectAudio(audio));
  if (decoded.kind !== "movie")
    return yield* new LivePlaybackFailure({
      message: "Decoded start frame was not the red fixture movie",
    });
  if (sought.kind !== "movie")
    return yield* new LivePlaybackFailure({
      message: "Decoded seek frame was not the red fixture movie",
    });
  if (sought.marker < seekMarkerMin || sought.marker > seekMarkerMax)
    return yield* new LivePlaybackFailure({
      message: "Seek frame marker was not near 20 seconds",
    });
  if (audioDbfs < pcmDbfsMin)
    return yield* new LivePlaybackFailure({
      message: "Decoded audio was below the fixture PCM floor",
    });
  if (!rangeSupported(rangeStart) || !rangeSupported(rangeMid))
    return yield* new LivePlaybackFailure({
      message: `put.io download did not honor HTTP Range (${rangeStart}, ${rangeMid})`,
    });
  return {
    decoded,
    seek: sought,
    audioDbfs,
    rangeStart,
    rangeMid,
    urlRenewalDistinct: first !== second,
  } satisfies LivePlaybackEvidence;
});
