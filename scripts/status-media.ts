import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { promisify } from "node:util";
import {
  statusClipSeconds,
  statusMediaKinds,
  statusMessages,
  statusPlaylist,
} from "../src/status-media.ts";

const execute = promisify(execFile);
const directory = resolve(process.argv[2] ?? ".cache/status-media");
const temporary = await mkdtemp(join(tmpdir(), "chill-status-media-"));
await mkdir(directory, { recursive: true });
const replace = async (
  name: string,
  write: (target: string) => Promise<unknown>,
) => {
  const target = resolve(directory, `${name}.tmp`);
  try {
    await write(target);
    await rename(target, resolve(directory, name));
  } finally {
    await rm(target, { force: true });
  }
};
try {
  for (const status of statusMediaKinds) {
    const lines = statusMessages[status];
    for (const [index, line] of lines.entries()) {
      await writeFile(join(temporary, `line-${index}.txt`), line);
    }
    const filters = lines.map(
      (_, index) =>
        `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=line-${index}.txt:fontcolor=white:fontsize=${index === 0 ? 56 : 36}:x=(w-text_w)/2:y=${index === 0 ? 260 : 365 + (index - 1) * 52}`,
    );
    const encode = (target: string, output: string[]) =>
      execute(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "color=c=0x121827:s=1280x720:r=15",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=48000:cl=stereo",
          "-vf",
          filters.join(","),
          ...output,
          target,
        ],
        {
          cwd: temporary,
          timeout: 45_000,
          killSignal: "SIGKILL",
          maxBuffer: 256 * 1024,
        },
      );
    await replace(`${status}.mp4`, (target) =>
      encode(target, [
        "-t",
        "8",
        "-threads",
        "2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-movflags",
        "+faststart",
        "-map_metadata",
        "-1",
        "-f",
        "mp4",
      ]),
    );
    // One muxed MPEG-TS segment without B-frames, the layout the pinned Web
    // client's HLS worker plays; bitexact output repeats byte for byte.
    await replace(`${status}.ts`, (target) =>
      encode(target, [
        "-t",
        String(statusClipSeconds),
        "-threads",
        "2",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-map_metadata",
        "-1",
        "-fflags",
        "+bitexact",
        "-flags:v",
        "+bitexact",
        "-flags:a",
        "+bitexact",
        "-f",
        "mpegts",
      ]),
    );
    await replace(`${status}.m3u8`, (target) =>
      writeFile(target, statusPlaylist(status)),
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
