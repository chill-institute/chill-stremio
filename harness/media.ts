import { NodeServices } from "@effect/platform-node";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import sharp from "sharp";

export const mediaFixtures = [
  { file: "movie", label: "FIXTURE MOVIE", color: "#d02020", frequency: 440 },
  {
    file: "episode1",
    label: "FIXTURE EPISODE 1",
    color: "#20b040",
    frequency: 554,
  },
  {
    file: "episode2",
    label: "FIXTURE EPISODE 2",
    color: "#2040d0",
    frequency: 659,
  },
] as const;

export async function generateMedia(
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  const target = resolve(directory);
  await mkdir(dirname(target), { recursive: true });
  const staging = await mkdtemp(join(dirname(target), `.${basename(target)}-`));
  const backup = `${staging}-previous`;
  let previous = false;
  try {
    await encodeMedia(staging, signal);
    signal?.throwIfAborted();
    try {
      await rename(target, backup);
      previous = true;
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      )
        throw error;
    }
    try {
      await rename(staging, target);
    } catch (error) {
      if (previous) await rename(backup, target);
      throw error;
    }
    if (previous) await rm(backup, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

const encodeFixture = Effect.fn("encodeFixture")(
  function* (directory: string, fixture: (typeof mediaFixtures)[number]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "image2pipe",
          "-framerate",
          "1",
          "-i",
          "pipe:0",
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${fixture.frequency}:sample_rate=48000:duration=36`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-pix_fmt",
          "yuv420p",
          "-r",
          "24",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          "-t",
          "36",
          "-movflags",
          "+faststart",
          join(directory, `${fixture.file}.mp4`),
        ],
        {
          stdin: "pipe",
          stdout: "ignore",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
        },
      ),
    );
    let diagnostic = "";
    const frames = Stream.fromIterable(
      Array.from({ length: 36 }, (_, second) => second),
    ).pipe(
      Stream.mapEffect((second) =>
        Effect.tryPromise(async () => {
          const svg = `<svg width="640" height="360" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="360" fill="${fixture.color}"/><rect x="60" y="80" width="520" height="190" fill="#111"/><text x="90" y="135" fill="white" font-family="sans-serif" font-size="30">${fixture.label}</text><text x="90" y="195" fill="white" font-family="sans-serif" font-size="32">TIME 00:${String(second).padStart(2, "0")} FRAME ${second * 24}</text><rect x="${60 + second * 14}" y="290" width="12" height="30" fill="white"/></svg>`;
          return sharp(Buffer.from(svg)).png().toBuffer();
        }),
      ),
    );
    const [, , code] = yield* Effect.all(
      [
        Stream.run(frames, child.stdin),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((text) =>
            Effect.sync(() => {
              diagnostic = (diagnostic + text).slice(-2000);
            }),
          ),
        ),
        child.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (code !== ChildProcessSpawner.ExitCode(0))
      return yield* Effect.fail(
        new Error(`Fixture encoding failed (${code}): ${diagnostic}`),
      );
  },
  Effect.timeout("60 seconds"),
  Effect.scoped,
);

async function encodeMedia(
  directory: string,
  signal?: AbortSignal,
): Promise<void> {
  await Effect.runPromise(
    Effect.forEach(mediaFixtures, (fixture) =>
      encodeFixture(directory, fixture),
    ).pipe(Effect.provide(NodeServices.layer)),
    { signal },
  );
  await writeFile(
    join(directory, "english.vtt"),
    "WEBVTT\n\n00:00:00.000 --> 00:00:35.900\nFIXTURE SUBTITLE ENGLISH\n",
  );
  await writeFile(
    join(directory, "spanish.vtt"),
    "WEBVTT\n\n00:00:00.000 --> 00:00:35.900\nSUBTITULO DE PRUEBA\n",
  );
}
