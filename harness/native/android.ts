import { createHash } from "node:crypto";
import { createServer, createConnection } from "node:net";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { androidVersions as versions } from "./android-versions.ts";
import {
  startAndroidAudio,
  type AndroidAudioCleanup,
} from "./android-audio.ts";
import { classifyTvHierarchy } from "./android-ui.ts";
import {
  AndroidFailure,
  diagnostic,
  emulatorAudioDiagnostic,
  executable,
  invoke,
  invokeBinary,
} from "./android-process.ts";

const cache = resolve(".cache/native/android");
const artifacts = `artifacts/android-${new Date().toISOString().replaceAll(":", "-")}`;
const apk = join(cache, `stremio-tv-${versions.app}-${versions.abi}.apk`);
const command = process.argv[2] ?? "probe";
const Image = Schema.Struct({
  "Pkg.Revision": Schema.Literal(versions.imageRevision),
  "AndroidVersion.ApiLevel": Schema.Literal(versions.api),
  "SystemImage.Abi": Schema.Literal(versions.abi),
  "SystemImage.TagId": Schema.Literal("android-tv"),
});
export interface Trial {
  run: number;
  status: "running" | "blocked" | "client-window-found";
  stage: string;
  durationMs?: number;
  error?: string;
  failureCode?: string;
  commandExitCode?: number;
  packageManagerReady?: boolean;
  packageManagerChecks?: number;
  audioDiagnostics?: string[];
  portsClosed?: boolean;
  resourcesRemoved?: boolean;
  cleanupErrors: string[];
  audio?: AndroidAudioCleanup;
  uiText?: string[];
  loginWall?: boolean;
  pairingChallenge?: boolean;
  guest?: boolean;
}
const trials: Trial[] = [];
let failure: string | undefined;
const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  JAVA_HOME: process.env.JAVA_HOME,
  LANG: "en_US.UTF-8",
  ADB_LOCAL_TRANSPORT_MAX_PORT: "0",
};

const available = (port: number) =>
  new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return server.close(() => reject(new Error("No TCP address")));
      server.close(() => resolvePort(address.port));
    });
  });
const closed = (port: number) =>
  new Promise<boolean>((resolveClosed) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (value: boolean) => {
      socket.destroy();
      resolveClosed(value);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (error) =>
      finish("code" in error && error.code === "ECONNREFUSED"),
    );
    socket.setTimeout(1000, () => finish(false));
  });
const verifyApk = async () => {
  const hash = createHash("sha256")
    .update(await readFile(apk))
    .digest("hex");
  if (hash !== versions.apkSha256)
    throw new Error(
      "APK checksum mismatch; preserve the file and rerun setup after removing it",
    );
};

export interface AndroidSession {
  run: number;
  audio: () => ReturnType<typeof invokeBinary>;
  audioState: Effect.Success<ReturnType<typeof startAndroidAudio>>["state"];
  frame: () => ReturnType<typeof invokeBinary>;
  command: (args: string[], deadline?: number) => ReturnType<typeof invoke>;
  hierarchy: () => ReturnType<typeof invoke>;
}
export interface AndroidAccountHook {
  canContinue?: () => boolean;
  run: (
    session: AndroidSession,
  ) => Effect.Effect<void, unknown, ChildProcessSpawner.ChildProcessSpawner>;
}
let accountHook: AndroidAccountHook | undefined;
const trial = Effect.fn("native.android.trial")(
  function* (
    run: number,
    emulator: string,
    sdk: string,
    adb: string,
    avdmanager: string,
  ) {
    const result: Trial = {
      run,
      status: "running",
      stage: "allocate",
      cleanupErrors: [],
    };
    trials.push(result);
    const started = Date.now();
    const directory = `${artifacts}/run-${run}`;
    yield* Effect.tryPromise(() => mkdir(directory, { recursive: true }));
    const state = yield* Effect.tryPromise(() =>
      mkdtemp(join(cache, "attempt-")),
    );
    let ports: number[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (result.status === "running") {
          result.status = "blocked";
          result.error ??= "Trial interrupted";
        }
        result.portsClosed = (await Promise.all(ports.map(closed))).every(
          Boolean,
        );
        if (!result.portsClosed)
          result.cleanupErrors.push("Owned listeners did not verify closed");
        if (result.portsClosed) {
          await rm(state, { recursive: true, force: true }).catch(() =>
            result.cleanupErrors.push("Attempt directory removal failed"),
          );
          result.resourcesRemoved = await access(state).then(
            () => false,
            () => true,
          );
        }
        if (
          result.audio &&
          (!result.audio.closed || !result.audio.resourcesRemoved)
        )
          result.cleanupErrors.push("Private audio cleanup did not verify");
        result.durationMs = Date.now() - started;
        await writeFile(
          `${directory}/result.json`,
          JSON.stringify(result, null, 2),
        );
      }),
    );
    let consolePort: number | undefined;
    for (let candidate = 5580; candidate <= 5680; candidate += 2) {
      const free = yield* Effect.tryPromise(() =>
        Promise.all([available(candidate), available(candidate + 1)]),
      ).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (free) {
        consolePort = candidate;
        break;
      }
    }
    if (!consolePort)
      return yield* new AndroidFailure({
        stage: "allocate",
        message: "No free emulator port pair",
      });
    const adbPort = yield* Effect.tryPromise(() => available(0));
    ports = [consolePort, consolePort + 1, adbPort];
    const user = join(state, "user");
    const avds = join(state, "avd");
    yield* Effect.tryPromise(() => Promise.all([mkdir(user), mkdir(avds)]));
    let env: Record<string, string | undefined> = {
      ...environment,
      ANDROID_SDK_ROOT: sdk,
      ANDROID_USER_HOME: user,
      ANDROID_EMULATOR_HOME: user,
      ANDROID_AVD_HOME: avds,
      ANDROID_ADB_SERVER_PORT: String(adbPort),
      TMPDIR: state,
    };
    const serial = `emulator-${consolePort}`;
    const adbCommand = (args: string[], deadline = 20_000) =>
      invoke(
        adb,
        ["-H", "127.0.0.1", "-P", String(adbPort), "-s", serial, ...args],
        env,
        deadline,
      );
    const disk = yield* Effect.tryPromise(() => statfs(cache));
    if (disk.bavail * disk.bsize < 13 * 1024 ** 3)
      return yield* new AndroidFailure({
        stage: "allocate",
        message: "Android TV requires 13 GiB free in the checkout filesystem",
        code: "insufficient-host-storage",
      });
    result.stage = "create-avd";
    yield* invoke(
      avdmanager,
      [
        "create",
        "avd",
        "--name",
        "chill-fixture-tv",
        "--package",
        versions.image,
        "--device",
        "tv_720p",
        "--path",
        join(avds, "chill-fixture-tv.avd"),
      ],
      env,
      60_000,
    );
    result.stage = "adb";
    const server = yield* ChildProcess.make(
      adb,
      ["-L", `tcp:${adbPort}`, "nodaemon", "server"],
      {
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        forceKillAfter: "3 seconds",
      },
    );
    yield* Effect.sleep("1 second");
    if (!(yield* server.isRunning))
      return yield* new AndroidFailure({
        stage: "adb",
        message: "Private ADB server exited",
      });
    // Loopback -H/-P targets only this server and will not start a replacement.
    yield* Effect.addFinalizer(() =>
      invoke(
        adb,
        ["-H", "127.0.0.1", "-P", String(adbPort), "kill-server"],
        env,
        5000,
      ).pipe(Effect.catch(() => Effect.void)),
    );
    let audio: Effect.Success<ReturnType<typeof startAndroidAudio>> | undefined;
    if (accountHook) {
      result.stage = "audio";
      result.audioDiagnostics = [];
      result.audio = { closed: false, resourcesRemoved: false };
      audio = yield* startAndroidAudio(env, result.audio);
      env = audio.environment;
    }
    result.stage = "boot";
    const child = yield* ChildProcess.make(
      emulator,
      [
        "-avd",
        "chill-fixture-tv",
        "-port",
        String(consolePort),
        "-no-window",
        ...(accountHook ? ["-audio", "pa"] : ["-no-audio"]),
        "-no-snapshot",
        "-wipe-data",
        "-gpu",
        "software",
        "-accel",
        "on",
        "-feature",
        "-Vulkan,-Uwb,-Nfc,-WiFiPacketStream",
        "-no-metrics",
        "-memory",
        "4096",
        "-cores",
        "2",
        "-no-boot-anim",
      ],
      { env, stdin: "ignore", forceKillAfter: "5 seconds" },
    );
    const logs: string[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.promise(() =>
        writeFile(`${directory}/emulator.log`, logs.join("\n")),
      ),
    );
    yield* child.all.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) =>
        Effect.sync(() => {
          if (!accountHook && logs.length < 2000) logs.push(diagnostic(line));
          if (accountHook) {
            const code = emulatorAudioDiagnostic(line);
            if (code && !result.audioDiagnostics?.includes(code))
              result.audioDiagnostics?.push(code);
          }
        }),
      ),
      Effect.forkScoped,
    );
    const bootDeadline = Date.now() + 300_000;
    let booted = false;
    while (Date.now() < bootDeadline) {
      if (!(yield* child.isRunning))
        return yield* new AndroidFailure({
          stage: "boot",
          message: "Emulator exited before Android boot completed",
        });
      const boot = yield* adbCommand(
        ["shell", "getprop", "sys.boot_completed"],
        5000,
      ).pipe(Effect.catch(() => Effect.succeed("")));
      if (boot === "1") {
        booted = true;
        break;
      }
      yield* Effect.sleep("2 seconds");
    }
    if (!booted)
      return yield* new AndroidFailure({
        stage: "boot",
        message:
          "Android boot did not complete within five minutes; inspect emulator.log",
      });
    result.stage = "package-manager-ready";
    result.packageManagerReady = false;
    result.packageManagerChecks = 0;
    const packageDeadline = Date.now() + 45_000;
    while (Date.now() < packageDeadline) {
      result.packageManagerChecks++;
      const installed = yield* adbCommand(
        ["shell", "pm", "path", "android"],
        5000,
      ).pipe(Effect.catch(() => Effect.succeed("")));
      if (installed.startsWith("package:")) {
        result.packageManagerReady = true;
        break;
      }
      yield* Effect.sleep("2 seconds");
    }
    if (!result.packageManagerReady)
      return yield* new AndroidFailure({
        stage: "package-manager-ready",
        message: "Package Manager did not become ready within 45 seconds",
        code: "package-manager-unavailable",
      });
    result.stage = "install-client";
    yield* adbCommand(["install", apk], 90_000);
    result.stage = "open-client";
    yield* adbCommand([
      "shell",
      "am",
      "start",
      "-n",
      `${versions.package}/com.stremio.tv.MainActivity`,
    ]);
    yield* Effect.sleep("10 seconds");
    yield* adbCommand(
      ["shell", "uiautomator", "dump", "/sdcard/chill-ui.xml"],
      30_000,
    );
    const xml = yield* adbCommand(["shell", "cat", "/sdcard/chill-ui.xml"]);
    yield* adbCommand(["shell", "rm", "-f", "/sdcard/chill-ui.xml"]).pipe(
      Effect.catch(() => Effect.void),
    );
    const ui = classifyTvHierarchy(xml, versions.package);
    result.uiText = ui.uiText;
    result.loginWall = ui.loginWall;
    result.pairingChallenge = ui.pairingChallenge;
    result.guest = ui.guest;
    if (!ui.clientWindow)
      return yield* new AndroidFailure({
        stage: "open-client",
        message: "UI hierarchy does not show Stremio; inspect client startup",
      });
    if (accountHook) {
      result.stage = "account-pairing";
      const hierarchy = () =>
        Effect.gen(function* () {
          yield* adbCommand(
            ["shell", "uiautomator", "dump", "/sdcard/chill-ui.xml"],
            30_000,
          );
          return yield* adbCommand([
            "shell",
            "cat",
            "/sdcard/chill-ui.xml",
          ]).pipe(
            Effect.ensuring(
              adbCommand(["shell", "rm", "-f", "/sdcard/chill-ui.xml"]).pipe(
                Effect.catch(() => Effect.void),
              ),
            ),
          );
        });
      if (!audio)
        return yield* new AndroidFailure({
          stage: "audio",
          message: "Private audio was not initialized",
        });
      yield* accountHook.run({
        run,
        audio: audio.capture,
        audioState: audio.state,
        command: adbCommand,
        hierarchy,
        frame: () =>
          invokeBinary(
            adb,
            [
              "-H",
              "127.0.0.1",
              "-P",
              String(adbPort),
              "-s",
              serial,
              "exec-out",
              "screencap",
              "-p",
            ],
            env,
          ),
      });
    }
    result.status = "client-window-found";
    result.stage = accountHook
      ? "account-flow-completed"
      : ui.loginWall
        ? "account-required"
        : "open-client";
  },
  Effect.scoped,
  Effect.timeout("8 minutes"),
);

const program = Effect.gen(function* () {
  if (command !== "setup" && command !== "probe")
    return yield* new AndroidFailure({
      stage: "arguments",
      message: "Use setup or probe",
    });
  if (process.platform !== versions.platform || process.arch !== versions.arch)
    return yield* new AndroidFailure({
      stage: "preflight",
      message: "Require a Linux x86_64 runner with usable KVM",
    });
  yield* Effect.tryPromise(() => mkdir(cache, { recursive: true }));
  const emulator = yield* Effect.tryPromise(() => executable("emulator"));
  const sdk = dirname(dirname(emulator));
  const emulatorVersion = yield* invoke(emulator, ["-version"], environment);
  if (!emulatorVersion.includes(`version ${versions.emulator}.`))
    return yield* new AndroidFailure({
      stage: "preflight",
      message: `Require emulator ${versions.emulator}`,
    });
  yield* invoke(emulator, ["-accel-check"], environment);
  const imageProperties = join(
    sdk,
    ...versions.image.split(";"),
    "source.properties",
  );
  const imagePresent = yield* Effect.tryPromise(() =>
    access(imageProperties).then(
      () => true,
      () => false,
    ),
  );
  if (!imagePresent) {
    if (command !== "setup")
      return yield* new AndroidFailure({
        stage: "preflight",
        message:
          "Pinned TV system image missing; run mise run native:android:setup",
      });
    const sdkmanager = yield* Effect.tryPromise(() => executable("sdkmanager"));
    yield* invoke(
      sdkmanager,
      [`--sdk_root=${sdk}`, versions.image],
      environment,
      600_000,
    );
  }
  const properties = yield* Effect.tryPromise(() =>
    readFile(imageProperties, "utf8"),
  );
  yield* Schema.decodeUnknownEffect(Image)(
    Object.fromEntries(
      properties
        .split(/\r?\n/)
        .filter((line) => line.includes("="))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    ),
  );
  if (command === "setup") {
    const present = yield* Effect.tryPromise(() =>
      access(apk).then(
        () => true,
        () => false,
      ),
    );
    if (!present)
      yield* Effect.tryPromise(async (signal) => {
        const response = await fetch(versions.apk, { signal });
        if (!response.ok)
          throw new Error(`APK download HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (
          createHash("sha256").update(bytes).digest("hex") !==
          versions.apkSha256
        )
          throw new Error("Downloaded APK checksum mismatch");
        await writeFile(apk, bytes);
      }).pipe(Effect.timeout("3 minutes"));
    yield* Effect.tryPromise(verifyApk);
    console.log(JSON.stringify({ status: "ready", versions }));
    return;
  }
  yield* Effect.tryPromise(verifyApk);
  const adb = yield* Effect.tryPromise(() => executable("adb"));
  const avdmanager = yield* Effect.tryPromise(() => executable("avdmanager"));
  for (const run of [1, 2]) {
    if (run > 1 && accountHook?.canContinue && !accountHook.canContinue()) {
      failure =
        "Account installation or cleanup was not verified; later trial skipped";
      break;
    }
    yield* trial(run, emulator, sdk, adb, avdmanager).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const result = trials.find((item) => item.run === run);
          if (result) {
            result.status = "blocked";
            result.failureCode =
              error instanceof AndroidFailure
                ? error.code
                : Cause.isTimeoutError(error)
                  ? "deadline-exceeded"
                  : undefined;
            result.commandExitCode =
              error instanceof AndroidFailure ? error.exitCode : undefined;
            result.error = accountHook
              ? "Authenticated trial failed at recorded stage"
              : diagnostic(String(error));
          }
        }),
      ),
    );
    const result = trials.find((item) => item.run === run);
    if (result)
      yield* Effect.tryPromise(() =>
        writeFile(
          `${artifacts}/run-${run}/result.json`,
          JSON.stringify(result, null, 2),
        ),
      );
  }
}).pipe(
  Effect.timeout("17 minutes"),
  Effect.catch((error) =>
    Effect.sync(() => {
      failure = accountHook
        ? "Authenticated runner failed"
        : diagnostic(String(error));
    }),
  ),
  Effect.ensuring(
    Effect.promise(async () => {
      if (command === "setup" && !failure) return;
      process.exitCode = 1;
      await mkdir(artifacts, { recursive: true });
      await writeFile(
        `${artifacts}/results.json`,
        JSON.stringify(
          {
            status: "blocked",
            error: failure,
            versions,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            scope: accountHook
              ? "Android TV authenticated fixture probe"
              : "Android TV boot and client entrypoint probe",
            playback: "not-run",
            next: accountHook
              ? "Inspect authenticated result and cleanup evidence; only assertions actually executed establish support."
              : "Account linking is expected. Use native:android:account for designated-account installation evidence; playback support requires separate assertions.",
            trials,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          status: "blocked",
          results: `${artifacts}/results.json`,
        }),
      );
    }),
  ),
  Effect.provide(NodeServices.layer),
);
export const runAndroidAccount = (hook: AndroidAccountHook) => {
  accountHook = hook;
  NodeRuntime.runMain(program);
};
if (import.meta.main) NodeRuntime.runMain(program);
