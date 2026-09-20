import {
  createAndroidRecoveryJournal,
  reconcileAndroidRecoveryJournal,
  type AndroidRecoveryJournal,
} from "./android-recovery.ts";
import { createHash } from "node:crypto";
import {
  inspectAndroidPcm,
  movieAudioPassed,
  focusedFixtureSource,
  fixtureSourceLayout,
  fixtureSourceAxis,
  androidSeekPassed,
  androidPausePassed,
} from "./android-evidence.ts";
import { inspectFrame, type FrameEvidence } from "./desktop-evidence.ts";
import { movieAdvances } from "./desktop-contract.ts";
import { chromium } from "@playwright/test";
import { startFixtureServer, manifest } from "../fixture.ts";
import {
  installOwnedAddon,
  removeOwnedAddon,
  loginDesignatedAccount,
  isDesignatedStremioAccount,
  type AddonInstallationVerification,
} from "../live/stremio-account.ts";
import { Effect, Fiber } from "effect";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { runAndroidAccount } from "./android.ts";
import { classifyTvHierarchy } from "./android-ui.ts";
import { pairingChallenge } from "./android-pairing.ts";
import { androidVersions } from "./android-versions.ts";

const directory = `artifacts/android-account-${Date.now()}`;
const newProof = () => ({
  run: 0,
  recoveryJournalId: undefined as string | undefined,
  installationVerification: undefined as
    | AddonInstallationVerification
    | undefined,
  remaining: [
    "dpad-navigation",
    "intact-video",
    "audio-pcm",
    "seek",
    "pause-resume",
    "subtitles-english-spanish-off",
    "next-episode",
    "delayed-readiness",
    "interrupted-recovery",
  ],
  sources: {} as Record<string, string>,
  frames: [] as FrameEvidence[],
  movieSampleIntervalMs: 0,
  seekElapsedMs: 0,
  seekOrigin: undefined as FrameEvidence | undefined,
  seekFrame: undefined as FrameEvidence | undefined,
  pausedFrames: [] as FrameEvidence[],
  resumedFrame: undefined as FrameEvidence | undefined,
  silence: undefined as ReturnType<typeof inspectAndroidPcm> | undefined,
  audio: undefined as ReturnType<typeof inspectAndroidPcm> | undefined,
  audioState: undefined as
    | { inputCount: number; activeInputs: number }
    | undefined,
  mediaVolume: undefined as number | undefined,
  navigation: [] as string[],
  sourceLayout: [] as ReturnType<typeof fixtureSourceLayout>,
  focusTransitions: [] as {
    forward: string;
    moved?: string;
    returned?: string;
  }[],
  sourceSelectedWithDpad: false,
  backToSources: false,
  status: "blocked",
  installation: "not-run",
  stage: "credentials",
  paired: false,
  linkConfirmed: false,
  tvLabels: [] as string[],
  playback: "not-run",
  browserClosed: false,
  addonInstalled: false,
  addonRemoved: false,
  fixtureClosed: false,
  mediaRequested: false,
  fixtureStreamRequested: false,
  cleanupErrors: [] as string[],
});
const runs: ReturnType<typeof newProof>[] = [];
const email = process.env.STREMIO_EMAIL;
const password = process.env.STREMIO_PASSWORD;
delete process.env.STREMIO_EMAIL;
delete process.env.STREMIO_PASSWORD;
if (!email || !isDesignatedStremioAccount(email) || !password) {
  throw new Error("Designated Stremio test credentials required");
}
runAndroidAccount({
  canContinue: () =>
    runs.every((run) => run.installation === "passed-partial-proof"),
  run: (session) =>
    Effect.gen(function* () {
      const proof = newProof();
      const capture = Effect.fn("native.android.account.frame")(function* () {
        const bytes = yield* session.frame();
        return yield* Effect.tryPromise(() => inspectFrame(bytes));
      });
      proof.run = session.run;
      runs.push(proof);
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          proof.installation =
            proof.paired &&
            proof.addonInstalled &&
            proof.fixtureStreamRequested &&
            proof.addonRemoved &&
            proof.fixtureClosed &&
            proof.browserClosed &&
            proof.cleanupErrors.length === 0
              ? "passed-partial-proof"
              : "failed";
          await mkdir(directory, { recursive: true });
          await writeFile(
            `${directory}/results.json`,
            JSON.stringify({ status: "blocked", runs }, null, 2),
          );
          console.log(
            JSON.stringify({
              status: proof.status,
              results: `${directory}/results.json`,
            }),
          );
        }),
      );
      proof.stage = "source-provenance";
      proof.sources = yield* Effect.tryPromise(async () => {
        const paths = ["package.json", "pnpm-lock.yaml"];
        for (const directory of ["harness", "src", ".cache/media"]) {
          const files = await readdir(directory, { recursive: true });
          paths.push(
            ...files
              .filter((file) => /\.(ts|mp4|vtt)$/.test(file))
              .map((file) => `${directory}/${file}`),
          );
        }
        return Object.fromEntries(
          await Promise.all(
            paths.sort().map(async (path) => [
              path,
              createHash("sha256")
                .update(await readFile(path))
                .digest("hex"),
            ]),
          ),
        );
      });
      proof.stage = "pairing-code";
      const xml = yield* session.hierarchy();
      const code = pairingChallenge(xml);
      if (!code)
        return yield* Effect.fail(new Error("Pairing challenge unavailable"));
      proof.stage = "official-link";
      yield* Effect.tryPromise(async () => {
        const browser = await chromium.launch({ headless: true });
        try {
          const context = await browser.newContext({ serviceWorkers: "block" });
          const page = await context.newPage();
          page.setDefaultTimeout(20_000);
          await page.goto(`https://link.stremio.com/${code}`, {
            waitUntil: "domcontentloaded",
          });
          // Only structural field metadata is retained; account text and URLs are never emitted.
          const fields = await page.locator("input").evaluateAll((nodes) =>
            nodes.map((node) => ({
              type: node.getAttribute("type"),
              name: node.getAttribute("name"),
            })),
          );
          proof.stage = fields.some((field) => field.type === "password")
            ? "official-login"
            : "link-login-unavailable";
          await page
            .locator('input[type="email"], input[name="email"]')
            .first()
            .fill(email);
          await page.locator('input[type="password"]').fill(password);
          await page
            .locator('button[type="submit"], input[type="submit"]')
            .first()
            .click();
          await page
            .getByText(/Remote login to new device succeeded/i)
            .waitFor({ timeout: 30_000 });
          proof.linkConfirmed = true;
        } finally {
          await browser.close();
          proof.browserClosed = true;
        }
      });
      proof.stage = "paired-client";
      for (let attempt = 0; attempt < 10; attempt++) {
        yield* Effect.sleep("3 seconds");
        const ui = classifyTvHierarchy(
          yield* session.hierarchy(),
          androidVersions.package,
        );
        proof.tvLabels = ui.uiText;
        if (ui.clientWindow && !ui.loginWall && proof.linkConfirmed) {
          proof.paired = true;
          break;
        }
      }
      if (!proof.paired)
        return yield* Effect.fail(
          new Error("TV did not confirm signed-in home"),
        );
      proof.stage = "audio-silence";
      const volume = yield* session.command([
        "shell",
        "cmd",
        "media_session",
        "volume",
        "--stream",
        "3",
        "--set",
        "10",
        "--get",
      ]);
      const volumeMatch = volume.match(/volume is (\d+) in range/);
      if (volumeMatch) proof.mediaVolume = Number(volumeMatch[1]);
      const silence = yield* session.audio();
      proof.silence = yield* Effect.try(() => inspectAndroidPcm(silence));
      proof.stage = "fixture-client-stop";
      yield* session.command([
        "shell",
        "am",
        "force-stop",
        androidVersions.package,
      ]);
      proof.stage = "fixture-server";
      const fixture = yield* Effect.tryPromise(() => startFixtureServer());
      yield* Effect.addFinalizer(() =>
        Effect.promise(async () => {
          await fixture.close();
          proof.fixtureClosed = true;
        }),
      );
      const port = new URL(fixture.origin).port;
      yield* session.command(["reverse", `tcp:${port}`, `tcp:${port}`]);
      const authKey = yield* Effect.tryPromise(() =>
        loginDesignatedAccount(email, password),
      );
      const manifestUrl = `${fixture.origin}/manifest.json`;
      let installAttempted = false;
      let journal: AndroidRecoveryJournal | undefined;
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          if (!installAttempted) return;
          yield* session.command([
            "shell",
            "am",
            "force-stop",
            androidVersions.package,
          ]);
          yield* Effect.tryPromise(() =>
            removeOwnedAddon(authKey, manifestUrl, fetch, async (after) => {
              if (journal)
                await reconcileAndroidRecoveryJournal(journal, after);
            }),
          );
          proof.addonRemoved = true;
        }).pipe(
          Effect.catch(() =>
            Effect.promise(async () => {
              proof.cleanupErrors.push("owned-addon-removal");
              if (journal)
                await reconcileAndroidRecoveryJournal(journal).catch(() =>
                  proof.cleanupErrors.push("recovery-journal-write"),
                );
            }),
          ),
        ),
      );
      proof.stage = "fixture-install";
      yield* Effect.tryPromise(() =>
        installOwnedAddon(
          authKey,
          {
            transportUrl: manifestUrl,
            manifest,
            flags: { protected: false },
          },
          fetch,
          () => {
            installAttempted = true;
          },
          (stage) => {
            proof.stage = `fixture-install-${stage}`;
          },
          {
            beforeWrite: async (baseline) => {
              proof.stage = "fixture-recovery-journal";
              journal = await createAndroidRecoveryJournal(
                manifestUrl,
                baseline,
              );
              proof.recoveryJournalId = journal.id;
            },
            verification: (result) => {
              proof.installationVerification = result;
            },
          },
        ),
      );
      proof.addonInstalled = true;
      // Start refreshes the account collection through the client's normal sync.
      yield* session.command([
        "shell",
        "am",
        "start",
        "-n",
        `${androidVersions.package}/com.stremio.tv.MainActivity`,
      ]);
      yield* Effect.sleep("10 seconds");
      proof.stage = "fixture-detail";
      yield* session.command([
        "shell",
        "am",
        "start",
        "-a",
        "android.intent.action.VIEW",
        "-d",
        "stremio:///detail/movie/fixture:movie/fixture:movie",
        androidVersions.package,
      ]);
      for (let attempt = 0; attempt < 12; attempt++) {
        yield* Effect.sleep("1 second");
        const hierarchy = yield* session.hierarchy();
        const source = focusedFixtureSource(hierarchy);
        proof.sourceLayout = fixtureSourceLayout(hierarchy);
        if (source) proof.navigation.push(source);
        if (source === "Direct fixture") {
          const axis = fixtureSourceAxis(proof.sourceLayout);
          if (!axis) continue;
          yield* session.command(["shell", "input", "keyevent", axis.forward]);
          const moved = focusedFixtureSource(yield* session.hierarchy());
          if (moved && moved !== source) proof.navigation.push(moved);
          yield* session.command(["shell", "input", "keyevent", axis.reverse]);
          const returned = focusedFixtureSource(yield* session.hierarchy());
          proof.focusTransitions.push({
            forward: axis.forward,
            moved,
            returned,
          });
          if (returned === source && moved && moved !== source) {
            yield* session.command([
              "shell",
              "input",
              "keyevent",
              "KEYCODE_DPAD_CENTER",
            ]);
            proof.sourceSelectedWithDpad = true;
            proof.stage = "fixture-playback";
            break;
          }
        }
        yield* session.command([
          "shell",
          "input",
          "keyevent",
          "KEYCODE_DPAD_DOWN",
        ]);
      }
      yield* Effect.sleep("8 seconds");
      proof.fixtureStreamRequested = fixture.metrics.streamRequests > 0;
      proof.mediaRequested = fixture.metrics.mediaRequests > 0;
      if (proof.mediaRequested) {
        const recording = yield* session.audio().pipe(Effect.forkScoped);
        const firstBytes = yield* session.frame();
        const first = yield* Effect.tryPromise(() => inspectFrame(firstBytes));
        const sampled = Date.now();
        yield* Effect.sleep("3 seconds");
        const bytes = yield* session.frame();
        const interval = Date.now() - sampled;
        const second = yield* Effect.tryPromise(() => inspectFrame(bytes));
        proof.frames.push(first, second);
        proof.movieSampleIntervalMs = interval;
        if (movieAdvances(first, second, interval)) {
          proof.playback = "intact-decoded-picture";
          proof.remaining = proof.remaining.filter(
            (item) => item !== "intact-video",
          );
        }
        proof.stage = "audio-pcm";
        const pcm = yield* Fiber.join(recording);
        proof.audio = yield* Effect.try(() => inspectAndroidPcm(pcm));
        proof.audioState = yield* session.audioState();
        if (proof.silence && movieAudioPassed(proof.audio, proof.silence))
          proof.remaining = proof.remaining.filter(
            (item) => item !== "audio-pcm",
          );
        proof.stage = "seek";
        // Pause exposes the HUD; rewind to zero before the TV client's 20-second seek.
        yield* session.command([
          "shell",
          "input",
          "keyevent",
          "KEYCODE_MEDIA_PAUSE",
        ]);
        yield* Effect.sleep("1 second");
        yield* session.command([
          "shell",
          "input",
          "keyevent",
          "KEYCODE_DPAD_LEFT",
        ]);
        yield* Effect.sleep("1 second");
        yield* session.command(["shell", "input", "keyevent", "KEYCODE_BACK"]);
        proof.seekOrigin = yield* capture();
        const seekStarted = Date.now();
        // A hidden HUD consumes the first directional key; the next key seeks.
        yield* session.command([
          "shell",
          "input",
          "keyevent",
          "KEYCODE_DPAD_RIGHT",
        ]);
        yield* Effect.sleep("1 second");
        yield* session.command([
          "shell",
          "input",
          "keyevent",
          "KEYCODE_DPAD_RIGHT",
        ]);
        yield* Effect.sleep("1 second");
        yield* session.command(["shell", "input", "keyevent", "KEYCODE_BACK"]);
        proof.seekFrame = yield* capture();
        proof.seekElapsedMs = Date.now() - seekStarted;
        if (
          androidSeekPassed(
            proof.seekOrigin,
            proof.seekFrame,
            proof.seekElapsedMs,
          )
        )
          proof.remaining = proof.remaining.filter((item) => item !== "seek");
        proof.stage = "pause-resume";
        // Seeking stays paused; controls have been dismissed through the real UI.
        const paused = yield* capture();
        yield* Effect.sleep("2 seconds");
        const stillPaused = yield* capture();
        proof.pausedFrames.push(paused, stillPaused);
        yield* session.command([
          "shell",
          "input",
          "keyevent",
          "KEYCODE_MEDIA_PLAY",
        ]);
        yield* Effect.sleep("1 second");
        yield* session.command(["shell", "input", "keyevent", "KEYCODE_BACK"]);
        yield* Effect.sleep("2 seconds");
        proof.resumedFrame = yield* capture();
        if (androidPausePassed(paused, stillPaused, proof.resumedFrame))
          proof.remaining = proof.remaining.filter(
            (item) => item !== "pause-resume",
          );
        yield* session.command(["shell", "input", "keyevent", "KEYCODE_BACK"]);
        proof.backToSources = Boolean(
          focusedFixtureSource(yield* session.hierarchy()),
        );
        if (proof.sourceSelectedWithDpad && proof.backToSources)
          proof.remaining = proof.remaining.filter(
            (item) => item !== "dpad-navigation",
          );
      }
      proof.stage =
        proof.playback === "intact-decoded-picture"
          ? "interactions-unverified"
          : "decoded-proof-unavailable";
    }).pipe(Effect.scoped),
});
