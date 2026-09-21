import {
  mkdir,
  cp,
  rm,
  readFile,
  writeFile,
  access,
  readdir,
} from "node:fs/promises";
import sharp from "sharp";
import {
  desktopInstallStage,
  desktopInstallationPassed,
} from "./desktop-ui.ts";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { stripTypeScriptTypes } from "node:module";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { startFixture, type Fixture } from "../fixture.ts";
import { startWeb } from "../web.ts";
import { validateProvenance } from "../provenance.ts";
import { desktopVersions as pins } from "./desktop-versions.ts";
import {
  acquireDesktopDirectory,
  type DesktopDirectory,
  desktopAttemptPassed,
  desktopRunPassed,
  movieAdvances,
  type DesktopRunProof,
} from "./desktop-contract.ts";
import {
  inspectAudio,
  inspectFrame,
  parseNativeLog,
  pcmDbfsMin,
  seekMarkerMax,
  seekMarkerMin,
  subtitleOnMin,
  subtitleSpanMin,
  type FrameEvidence,
} from "./desktop-evidence.ts";
import {
  hostedRequired,
  hostedRunPassed,
  hostedHlsRequired,
  hostedHlsRunPassed,
} from "./desktop-hosted-contract.ts";
import { startHostedDesktop, type HostedSnapshot } from "./desktop-hosted.ts";

class DesktopFailure extends Schema.TaggedError<DesktopFailure>()(
  "DesktopFailure",
  { message: Schema.String },
) {}
const GuestScenario = Schema.Struct({
  name: Schema.String,
  status: Schema.Literals(["passed", "failed", "blocked"]),
  error: Schema.optional(Schema.String),
});
const GuestResult = Schema.Struct({
  status: Schema.Literals(["passed", "failed", "blocked"]),
  boundary: Schema.String,
  freshState: Schema.Boolean,
  cleanup: Schema.Boolean,
  movieSampleIntervalMs: Schema.optional(Schema.Number),
  error: Schema.String,
  scenarios: Schema.Array(GuestScenario),
});
type Scenario = {
  name: string;
  status: "passed" | "failed" | "blocked";
  error?: string;
};
const fixtureRequired = [
  "ui-installation",
  "pending-empty",
  "movie-decoded-playback",
  "audio-pcm",
  "seek-rendered-destination",
  "subtitles-on",
  "subtitles-off",
  "interrupted-playback-recovery",
  "next-episode",
] as const;
// `hosted` proves the actual hosted adapter; the default proves the generic
// fixture addon. Their receipts stay separate and neither implies the other.
const hls = process.argv[2] === "hosted-hls";
const mode = hls
  ? "hosted-hls"
  : process.argv[2] === "hosted"
    ? "hosted"
    : "fixture";
const required: readonly string[] = hls
  ? hostedHlsRequired
  : mode !== "fixture"
    ? hostedRequired
    : fixtureRequired;
const guestSource =
  mode !== "fixture"
    ? "harness/native/desktop-hosted-guest.ts"
    : "harness/native/desktop-guest.ts";
const trialSeconds = mode !== "fixture" ? 540 : 300;
const directory = `artifacts/desktop${mode !== "fixture" ? `-${mode}` : ""}-${Date.now()}`;
const localLinux =
  process.platform === "linux" && ["x64", "arm64"].includes(process.arch);
const flatpakDirectory = `${homedir()}/.local/share/chill-stremio/flatpak`;
let guestDirectory = `/tmp/chill-desktop-${Date.now()}`;
let guestScript = "/tmp/chill-desktop-guest.mjs";
let ownedDirectory: DesktopDirectory | undefined;
let retainedGuestDirectory: string | undefined;
const runs: DesktopRunProof[] = [];
const cleanupErrors: string[] = [];
let error: string | undefined;
const redact = (value: string) =>
  value.replace(/https?:\/\/[^\s"<>]+/g, "[fixture-url]");
const describe = (cause: unknown) =>
  redact(
    cause instanceof Error && cause.cause instanceof Error
      ? `${cause.message}: ${cause.cause.message}`
      : String(cause),
  );
const closed = (origin: string) =>
  new Promise<boolean>((resolveClosed) => {
    const url = new URL(origin);
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port),
    });
    const finish = (value: boolean) => {
      socket.destroy();
      resolveClosed(value);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (cause) =>
      finish("code" in cause && cause.code === "ECONNREFUSED"),
    );
    socket.setTimeout(1000, () => finish(false));
  });
const present = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const frameOf = async (path: string) =>
  (await present(path)) ? inspectFrame(path) : undefined;
const installationStageOf = async (path: string) => {
  if (!(await present(path))) return undefined;
  const { data, info } = await sharp(path)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return desktopInstallStage(data, info.width, info.height);
};
const command = Effect.fn("native.desktop.command")(function* (
  executable: string,
  args: string[],
  timeoutMs = 150_000,
) {
  const child = yield* ChildProcess.make(executable, args, {
    stdin: "ignore",
    forceKillAfter: "5 seconds",
  });
  const [chunks, code] = yield* Effect.all([
    Stream.runCollect(child.all.pipe(Stream.decodeText())),
    child.exitCode,
  ]).pipe(Effect.timeout(timeoutMs));
  const output = [...chunks].join("");
  if (code !== ChildProcessSpawner.ExitCode(0))
    return yield* new DesktopFailure({
      message: redact(`${executable} exited ${code}: ${output.slice(-2000)}`),
    });
  return output.trim();
}, Effect.scoped);
const guest = (args: string[], timeoutMs = 150_000) =>
  command("env", [`FLATPAK_USER_DIR=${flatpakDirectory}`, ...args], timeoutMs);
const setScenario = (
  scenarios: Scenario[],
  name: string,
  status: Scenario["status"],
  message?: string,
) => {
  const existing = scenarios.find((item) => item.name === name);
  if (existing) {
    existing.status = status;
    existing.error = message;
    return;
  }
  scenarios.push({ name, status, error: message });
};
const decoded = (
  frame: FrameEvidence | undefined,
  kind: NonNullable<FrameEvidence["kind"]>,
) => Boolean(frame?.kind === kind && frame.intact && frame.marker >= 0);
const subtitlesVisible = (frame: FrameEvidence | undefined) =>
  Boolean(
    frame?.kind &&
    frame.intact &&
    frame.subtitlePixels >= subtitleOnMin &&
    frame.subtitleSpan >= subtitleSpanMin,
  );
const guestPassed = (scenarios: Scenario[], name: string) =>
  scenarios.some((item) => item.name === name && item.status === "passed");
const finishEvaluation = (
  runDirectory: string,
  guestResult: typeof GuestResult.Type,
  scenarios: Scenario[],
  extra: Record<string, unknown>,
) => {
  const remaining = required.filter((name) => {
    const scenario = scenarios.find((item) => item.name === name);
    return scenario?.status !== "passed";
  });
  return {
    runDirectory,
    status:
      remaining.length === 0 &&
      guestResult.status === "passed" &&
      guestResult.freshState &&
      guestResult.cleanup &&
      !guestResult.error
        ? "passed"
        : "blocked",
    guest: guestResult.status,
    freshState: guestResult.freshState,
    cleanup: guestResult.cleanup,
    error: guestResult.error,
    remaining,
    scenarios,
    servicesClosed: false,
    ...extra,
  };
};
const evaluate = async (
  runDirectory: string,
  metrics: Fixture["metrics"],
  guestResult: typeof GuestResult.Type,
) => {
  const scenarios: Scenario[] = guestResult.scenarios.map((item) => ({
    name: item.name,
    status: item.status,
    error: item.error,
  }));
  const log = (await present(`${runDirectory}/native.log`))
    ? parseNativeLog(await readFile(`${runDirectory}/native.log`, "utf8"))
    : { vo: false, ao: false, noticeVo: false };
  const movie = await frameOf(`${runDirectory}/movie.png`);
  const movieAdvancing = await frameOf(`${runDirectory}/movie-advancing.png`);
  const seek = await frameOf(`${runDirectory}/seek.png`);
  const pending = await frameOf(`${runDirectory}/pending.png`);
  const subtitlesOn = await frameOf(`${runDirectory}/subtitles-on.png`);
  const subtitlesOff = await frameOf(`${runDirectory}/subtitles-off.png`);
  const recovered = await frameOf(`${runDirectory}/interrupted-recovered.png`);
  const episode1 = await frameOf(`${runDirectory}/episode1.png`);
  const episode2 = await frameOf(`${runDirectory}/episode2.png`);
  const dbfs = (await present(`${runDirectory}/audio.wav`))
    ? await inspectAudio(`${runDirectory}/audio.wav`)
    : Number.NEGATIVE_INFINITY;
  if (!pending || pending.kind || !guestPassed(scenarios, "pending-empty"))
    setScenario(
      scenarios,
      "pending-empty",
      "failed",
      pending?.kind
        ? "First movie visit already decoded fixture pixels"
        : "Pending visit screenshot was missing; delayed-ready is not injected in the same window as decoded playback",
    );
  else setScenario(scenarios, "pending-empty", "passed");
  if (
    !desktopInstallationPassed({
      guestPassed: guestPassed(scenarios, "ui-installation"),
      manifestStage: await installationStageOf(`${runDirectory}/manifest.png`),
      installedStage: await installationStageOf(
        `${runDirectory}/installed.png`,
      ),
      streamRequests: metrics.streamRequests,
    })
  )
    setScenario(
      scenarios,
      "ui-installation",
      "failed",
      "Native manifest confirmation, completed installation UI or fixture routing was not observed",
    );
  if (
    !movieAdvances(movie, movieAdvancing, guestResult.movieSampleIntervalMs) ||
    !log.vo
  )
    setScenario(
      scenarios,
      "movie-decoded-playback",
      "failed",
      "libmpv screenshots did not show intact advancing movie fixture frames",
    );
  else setScenario(scenarios, "movie-decoded-playback", "passed");
  if (!(dbfs > pcmDbfsMin && log.ao))
    setScenario(
      scenarios,
      "audio-pcm",
      "failed",
      `Pulse capture ${dbfs.toFixed(1)} dBFS or missing AO: [pulse]`,
    );
  else setScenario(scenarios, "audio-pcm", "passed");
  if (
    !decoded(seek, "movie") ||
    (seek?.marker ?? -1) < seekMarkerMin ||
    (seek?.marker ?? -1) > seekMarkerMax
  )
    setScenario(
      scenarios,
      "seek-rendered-destination",
      "failed",
      `Seek marker ${seek?.marker ?? -1} not near 20 seconds`,
    );
  else setScenario(scenarios, "seek-rendered-destination", "passed");
  const onFrame = subtitlesOn ?? movie;
  if (!subtitlesVisible(onFrame))
    setScenario(
      scenarios,
      "subtitles-on",
      "failed",
      "English fixture subtitle pixels were not visible on decoded video",
    );
  else setScenario(scenarios, "subtitles-on", "passed");
  if (
    !subtitlesOff?.intact ||
    !subtitlesOff.kind ||
    subtitlesVisible(subtitlesOff)
  )
    setScenario(
      scenarios,
      "subtitles-off",
      "failed",
      "Subtitle pixels remained after the off control",
    );
  else setScenario(scenarios, "subtitles-off", "passed");
  if (metrics.interruptedCuts < 1 || !decoded(recovered, "movie"))
    setScenario(
      scenarios,
      "interrupted-playback-recovery",
      "failed",
      "Interrupted cut or recovered movie pixels were not observed",
    );
  else setScenario(scenarios, "interrupted-playback-recovery", "passed");
  if (!decoded(episode1, "episode1") || !decoded(episode2, "episode2"))
    setScenario(
      scenarios,
      "next-episode",
      "failed",
      "Episode identity colors were not captured after Next Video",
    );
  else setScenario(scenarios, "next-episode", "passed");
  return finishEvaluation(runDirectory, guestResult, scenarios, {
    vo: log.vo,
    ao: log.ao,
    pcmDbfs: Number.isFinite(dbfs) ? Number(dbfs.toFixed(2)) : null,
    movie,
    movieAdvancing,
    movieSampleIntervalMs: guestResult.movieSampleIntervalMs,
    seek,
    interruptedCuts: metrics.interruptedCuts,
  });
};
const evaluateHosted = async (
  runDirectory: string,
  guestResult: typeof GuestResult.Type,
  hosted: HostedSnapshot,
  secrets: string[],
) => {
  const scenarios: Scenario[] = guestResult.scenarios.map((item) => ({
    name: item.name,
    status: item.status,
    error: item.error,
  }));
  const log = (await present(`${runDirectory}/native.log`))
    ? parseNativeLog(await readFile(`${runDirectory}/native.log`, "utf8"))
    : { vo: false, ao: false, noticeVo: false };
  const movie = await frameOf(`${runDirectory}/movie.png`);
  const movieAdvancing = await frameOf(`${runDirectory}/movie-advancing.png`);
  const pendingLoading = await frameOf(`${runDirectory}/pending-loading.png`);
  const automaticPlayback = await frameOf(
    `${runDirectory}/automatic-playback.png`,
  );
  const downloadSubtitles = await frameOf(
    `${runDirectory}/download-subtitles.png`,
  );
  const interrupted = await frameOf(`${runDirectory}/interrupted.png`);
  const recovered = await frameOf(`${runDirectory}/interrupted-recovered.png`);
  const secondFile = await frameOf(`${runDirectory}/multiple-file-decoded.png`);
  const dbfs = (await present(`${runDirectory}/audio.wav`))
    ? await inspectAudio(`${runDirectory}/audio.wav`)
    : Number.NEGATIVE_INFINITY;
  const stage = (name: string, kind?: string) =>
    hosted.stages.find(
      (record) => record.stage === name && record.kind === kind && record.ok,
    );
  if (
    !desktopInstallationPassed({
      guestPassed: guestPassed(scenarios, "ui-installation"),
      manifestStage: await installationStageOf(`${runDirectory}/manifest.png`),
      installedStage: await installationStageOf(
        `${runDirectory}/installed.png`,
      ),
      streamRequests: hosted.proxy.stream,
    }) ||
    hosted.proxy.manifest < 1
  )
    setScenario(
      scenarios,
      "ui-installation",
      "failed",
      "Native manifest confirmation, completed installation UI or hosted routing was not observed",
    );
  if (
    !guestPassed(scenarios, "release-detail") ||
    !stage("movie-detail") ||
    !stage("episode-detail")
  ) {
    setScenario(
      scenarios,
      "release-detail",
      "failed",
      "Release listing was not verified read-only before selection",
    );
    setScenario(
      scenarios,
      "episode-context",
      "failed",
      "Episode release listing was not verified read-only before selection",
    );
  }
  if (
    !guestPassed(scenarios, "selected-download") ||
    !pendingLoading ||
    (pendingLoading.kind && pendingLoading.intact) ||
    !decoded(automaticPlayback, "movie") ||
    !stage("automatic-playing") ||
    (hosted.proxy.notice.pending ?? 0) !== 0
  )
    setScenario(
      scenarios,
      "selected-download",
      "failed",
      "Selection did not wait and automatically decode the downloaded video",
    );
  if (!subtitlesVisible(downloadSubtitles) || !stage("download-subtitles"))
    setScenario(
      scenarios,
      "download-subtitles",
      "failed",
      "Downloaded video subtitles were not requested and rendered",
    );
  if (
    !movieAdvances(movie, movieAdvancing, guestResult.movieSampleIntervalMs) ||
    !log.vo ||
    !stage("acquired-playing")
  )
    setScenario(
      scenarios,
      "acquired-playback",
      "failed",
      "libmpv screenshots did not show intact advancing acquired-file frames",
    );
  if (!(dbfs > pcmDbfsMin && log.ao))
    setScenario(
      scenarios,
      "audio-pcm",
      "failed",
      `Pulse capture ${dbfs.toFixed(1)} dBFS or missing AO: [pulse]`,
    );
  if (!hls && (hosted.media.cuts < 1 || !decoded(recovered, "movie")))
    setScenario(
      scenarios,
      "interrupted-playback-recovery",
      "failed",
      "Interrupted cut or recovered acquired-file pixels were not observed",
    );
  if (
    !hls &&
    (!decoded(secondFile, "episode1") || !stage("select-file-playing"))
  )
    setScenario(
      scenarios,
      "exact-file-playback",
      "failed",
      "Chosen second file pixels were not decoded",
    );
  if (hosted.proxy.deniedAfterRevocation < 1 || !stage("revoke"))
    setScenario(
      scenarios,
      "revocation-denied",
      "failed",
      "Revoked installation still answered the client",
    );
  if (
    hosted.engineCalls.transfer !== (hls ? 1 : 4) ||
    hosted.engineCalls.rejected !== 0 ||
    hosted.adapterRestarts !== (hls ? 1 : 2)
  )
    setScenario(
      scenarios,
      "durable-claims",
      "failed",
      `Engine saw ${hosted.engineCalls.transfer} transfers, ${hosted.engineCalls.rejected} rejected requests and ${hosted.adapterRestarts} restarts`,
    );
  else setScenario(scenarios, "durable-claims", "passed");
  const leaked: string[] = [];
  for (const file of await readdir(runDirectory)) {
    if (!/\.(json|log|txt)$/.test(file)) continue;
    const text = await readFile(`${runDirectory}/${file}`, "utf8");
    if (secrets.some((secret) => text.includes(secret))) leaked.push(file);
  }
  if (leaked.length)
    setScenario(
      scenarios,
      "ui-installation",
      "failed",
      `Retained evidence contains the installation capability: ${leaked.join(", ")}`,
    );
  return finishEvaluation(runDirectory, guestResult, scenarios, {
    vo: log.vo,
    ao: log.ao,
    noticeVo: log.noticeVo,
    pcmDbfs: Number.isFinite(dbfs) ? Number(dbfs.toFixed(2)) : null,
    movie,
    movieAdvancing,
    movieSampleIntervalMs: guestResult.movieSampleIntervalMs,
    pendingLoadingKind: pendingLoading?.kind ?? null,
    automaticPlayback,
    downloadSubtitles,
    playbackContinuedAfterCut: interrupted?.kind === "movie",
    secondFile,
    hosted,
    delivery: hls ? "hls" : "original",
    unverified: hls
      ? [
          "interrupted-playback-recovery",
          "terminal-recovery",
          "audio-track-switching",
        ]
      : [],
  });
};
const program = Effect.gen(function* () {
  yield* Effect.promise(() => mkdir(directory, { recursive: true }));
  yield* validateProvenance();
  if (!localLinux)
    return yield* new DesktopFailure({
      message: "Desktop probe requires Linux x86_64 or ARM64",
    });
  ownedDirectory = yield* acquireDesktopDirectory;
  guestDirectory = ownedDirectory.path;
  guestScript = `${guestDirectory}/desktop-guest.mjs`;
  const actualClient = yield* guest([
    "flatpak",
    "info",
    "--user",
    "--show-commit",
    pins.client,
  ]);
  const actualRuntime = yield* guest([
    "flatpak",
    "info",
    "--user",
    "--show-commit",
    pins.runtime,
  ]);
  if (
    actualClient !== pins.clientCommit ||
    actualRuntime !== pins.runtimeCommit
  )
    return yield* new DesktopFailure({
      message:
        "Native Flatpak pins differ; restore the documented commits before probing",
    });
  const source = yield* Effect.promise(() => readFile(guestSource, "utf8"));
  yield* Effect.promise(() =>
    writeFile(`${directory}/desktop-guest.mjs`, stripTypeScriptTypes(source)),
  );
  yield* Effect.tryPromise(() =>
    cp(`${directory}/desktop-guest.mjs`, guestScript),
  );
  for (const helper of ["desktop-ui.ts", "desktop-guest-runtime.ts"])
    yield* Effect.tryPromise(async () => {
      await cp(`harness/native/${helper}`, `${directory}/${helper}`);
      await cp(`${directory}/${helper}`, `${guestDirectory}/${helper}`);
    });
  for (const run of [1, 2]) {
    const runDirectory = `${directory}/run-${run}`;
    const outcome = yield* Effect.scoped(
      Effect.gen(function* () {
        const row: DesktopRunProof & {
          run: number;
          servicesClosed: boolean;
          [key: string]: unknown;
        } = { run, servicesClosed: false };
        const origins: string[] = [];
        const expectedOrigins = mode !== "fixture" ? 6 : 2;
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            row.servicesClosed =
              origins.length === expectedOrigins &&
              (await Promise.all(origins.map(closed))).every(Boolean);
            if (!row.servicesClosed)
              cleanupErrors.push(`Run ${run} listeners did not verify closed`);
            if (
              row.status === "passed" &&
              !(mode !== "fixture"
                ? hls
                  ? hostedHlsRunPassed(row)
                  : hostedRunPassed(row)
                : desktopRunPassed(row))
            )
              row.status = "blocked";
          }),
        );
        const fixture = yield* startFixture();
        if (mode === "fixture") fixture.setPending(true);
        origins.push(fixture.origin);
        const web = yield* startWeb;
        origins.push(web.origin);
        const hosted =
          mode !== "fixture"
            ? yield* startHostedDesktop(fixture.origin, web.origin, hls)
            : undefined;
        if (hosted) origins.push(...hosted.endpoints);
        if (hosted) {
          yield* Effect.tryPromise(async () => {
            await mkdir(`${guestDirectory}/run-${run}`, { recursive: true });
            await writeFile(
              `${guestDirectory}/run-${run}/fixture.pem`,
              hosted.certificate,
            );
          });
        }
        const guestArgs = hosted
          ? [web.origin, hosted.manifestUrl, hosted.controlUrl]
          : [web.origin, fixture.origin];
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.gen(function* () {
                yield* Effect.tryPromise(() =>
                  cp(`${guestDirectory}/run-${run}`, runDirectory, {
                    recursive: true,
                  }),
                );
                yield* Effect.tryPromise(() =>
                  rm(`${guestDirectory}/run-${run}`, {
                    recursive: true,
                    force: true,
                  }),
                );
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.sync(() => {
                    retainedGuestDirectory = guestDirectory;
                    if (ownedDirectory) ownedDirectory.retain = true;
                    cleanupErrors.push(redact(String(cause)));
                  }),
                ),
              ),
            );
            yield* guest(
              [
                "timeout",
                "--kill-after=15",
                String(trialSeconds),
                "dbus-run-session",
                "--",
                "xvfb-run",
                "-a",
                "-s",
                "-screen 0 1280x720x24 -nolisten tcp",
                process.execPath,
                guestScript,
                ...guestArgs,
                `${guestDirectory}/run-${run}`,
                ...(hls ? ["hls"] : []),
              ],
              (trialSeconds + 30) * 1000,
            ).pipe(Effect.ignore);
          }),
        );
        const raw = yield* Effect.promise(() =>
          readFile(`${runDirectory}/result.json`, "utf8").catch(() => ""),
        );
        if (!raw) {
          Object.assign(row, {
            status: "failed",
            remaining: [...required],
            error: "Guest result.json was not copied",
          });
          return row;
        }
        const guestResult = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(GuestResult),
        )(raw);
        const evaluated = yield* Effect.tryPromise(() =>
          hosted
            ? evaluateHosted(
                runDirectory,
                guestResult,
                hosted.snapshot(),
                hosted.secrets,
              )
            : evaluate(runDirectory, fixture.metrics, guestResult),
        );
        Object.assign(row, evaluated);
        return row;
      }),
    ).pipe(
      Effect.catch((cause) =>
        Effect.succeed({
          run,
          status: "failed",
          remaining: [...required],
          error: describe(cause),
          servicesClosed: false,
        }),
      ),
    );
    runs.push(outcome);
    yield* Effect.sleep("5 seconds");
  }
}).pipe(
  Effect.scoped,
  Effect.timeout(mode !== "fixture" ? "30 minutes" : "20 minutes"),
  Effect.catchCause((cause) =>
    Effect.sync(() => {
      error = redact(String(cause));
    }),
  ),
  Effect.ensuring(
    Effect.promise(async () => {
      if (ownedDirectory?.cleanupError) {
        cleanupErrors.push(redact(ownedDirectory.cleanupError));
        retainedGuestDirectory = ownedDirectory.path;
      }
      await mkdir(directory, { recursive: true });
      const remaining = [
        ...new Set(runs.flatMap((item) => item.remaining ?? [...required])),
      ];
      const runtime = {
        kind: "linux-local" as const,
        cleaned:
          ownedDirectory?.removed === true &&
          runs.length === 2 &&
          runs.every((run) => run.cleanup === true),
      };
      const passed = desktopAttemptPassed({
        runs,
        runtime,
        cleanupErrors,
        error,
      });
      const blocked = !passed;
      await writeFile(
        `${directory}/results.json`,
        JSON.stringify(
          {
            client: "Linux GTK4/WebKitGTK/libmpv",
            mode,
            addon:
              mode !== "fixture"
                ? "actual-hosted-adapter-with-generated-Engine"
                : "generic-fixture-addon",
            status: passed ? "passed" : "blocked",
            versions: pins,
            interruptedRecovery: hls
              ? "not-tested"
              : "same-profile-client-restart",
            credentials: "generated-fake-only",
            runtime,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            retainedGuestDirectory,
            cleanupErrors,
            runs,
            remaining,
            error,
          },
          null,
          2,
        ),
      );
      if (blocked) process.exitCode = 1;
      console.log(
        JSON.stringify({
          status: passed ? "passed" : "blocked",
          mode,
          results: `${directory}/results.json`,
        }),
      );
    }),
  ),
  Effect.provide(NodeServices.layer),
);
NodeRuntime.runMain(program);
