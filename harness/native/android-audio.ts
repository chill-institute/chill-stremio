import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { Effect, Schema } from "effect";
import { ChildProcess } from "effect/unstable/process";
import {
  AndroidFailure,
  executable,
  invoke,
  invokeBinary,
} from "./android-process.ts";

export interface AndroidAudioCleanup {
  closed: boolean;
  resourcesRemoved: boolean;
}

export const startAndroidAudio = Effect.fn("native.android.audio")(function* (
  environment: Record<string, string | undefined>,
  cleanup: AndroidAudioCleanup,
) {
  const directory = yield* Effect.tryPromise(() =>
    mkdtemp("/tmp/chill-tv-audio-"),
  );
  const socket = `${directory}/pulse.sock`;
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      cleanup.closed = await new Promise<boolean>((resolve) => {
        const connection = createConnection({ path: socket });
        const finish = (closed: boolean) => {
          connection.destroy();
          resolve(closed);
        };
        connection.once("connect", () => finish(false));
        connection.once("error", (error) =>
          finish(
            "code" in error &&
              (error.code === "ENOENT" || error.code === "ECONNREFUSED"),
          ),
        );
        connection.setTimeout(1000, () => finish(false));
      });
      if (cleanup.closed) {
        await rm(directory, { recursive: true, force: true });
        cleanup.resourcesRemoved = true;
      }
    }),
  );
  const config = `${directory}/pulse.pa`;
  yield* Effect.tryPromise(() =>
    writeFile(
      config,
      [
        `load-module module-native-protocol-unix socket=${socket} auth-anonymous=1`,
        "load-module module-null-sink sink_name=fixture channels=2 rate=48000",
        "set-default-sink fixture",
        "set-default-source fixture.monitor",
      ].join("\n"),
      { mode: 0o600 },
    ),
  );
  const env = {
    ...environment,
    PULSE_SERVER: `unix:${socket}`,
    PULSE_SINK: "fixture",
    PULSE_SOURCE: "fixture.monitor",
  };
  const pulse = yield* Effect.tryPromise(() => executable("pulseaudio"));
  const pactl = yield* Effect.tryPromise(() => executable("pactl"));
  const ffmpeg = yield* Effect.tryPromise(() => executable("ffmpeg"));
  const process = yield* ChildProcess.make(
    pulse,
    [
      "--daemonize=no",
      "--exit-idle-time=-1",
      "--use-pid-file=no",
      "-n",
      `--file=${config}`,
    ],
    {
      env: {
        ...env,
        HOME: directory,
        XDG_CONFIG_HOME: directory,
        XDG_RUNTIME_DIR: directory,
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      forceKillAfter: "3 seconds",
    },
  );
  yield* Effect.sleep("1 second");
  if (!(yield* process.isRunning))
    return yield* new AndroidFailure({
      stage: "audio",
      message: "Private audio server exited",
    });
  yield* invoke(pactl, ["info"], env);
  const state = Effect.fn("native.android.audio.state")(function* () {
    const raw = yield* invoke(
      pactl,
      ["-f", "json", "list", "sink-inputs"],
      env,
    );
    const inputs = yield* Effect.try(() =>
      Schema.decodeUnknownSync(
        Schema.fromJsonString(
          Schema.Array(
            Schema.Struct({
              mute: Schema.Boolean,
              corked: Schema.Boolean,
            }),
          ),
        ),
      )(raw),
    );
    return {
      inputCount: inputs.length,
      activeInputs: inputs.filter((input) => !input.mute && !input.corked)
        .length,
    };
  });
  return {
    environment: env,
    state,
    capture: () =>
      invokeBinary(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-f",
          "pulse",
          "-i",
          "fixture.monitor",
          "-t",
          "2",
          "-ac",
          "2",
          "-ar",
          "48000",
          "-c:a",
          "pcm_s16le",
          "-f",
          "s16le",
          "pipe:1",
        ],
        env,
      ),
  };
});
