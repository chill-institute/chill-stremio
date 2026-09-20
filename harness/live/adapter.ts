import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { chromium, expect, type Page } from "@playwright/test";
import { Effect, Layer, Schema } from "effect";
import sharp from "sharp";
import { Engine, engineLayer } from "../../src/engine.ts";
import { startAdapter } from "../../src/server.ts";
import { validateProvenance } from "../provenance.ts";
import { startWeb } from "../web.ts";
import { reserve } from "./allowance.ts";
import {
  createLiveAttempt,
  trackAcquisition,
  withLiveLifecycle,
  writeRecoveryJournal,
} from "./lifecycle.ts";
import {
  accountInfo,
  cancelTransfers,
  createFolder,
  deleteFiles,
  listSubtitles,
  uploadFile,
} from "./putio.ts";
import { removeOwnedAddon } from "./stremio-account.ts";
import { registeredLiveRunner } from "./runner.ts";
import {
  ensureLiveSource,
  fixtureSrt,
  liveFolderName,
  liveSubtitleName,
  liveUploadName,
} from "./source.ts";
import { liveVersions } from "./versions.ts";

class AdapterProbeFailure extends Schema.TaggedError<AdapterProbeFailure>()(
  "AdapterProbeFailure",
  {
    stage: Schema.String,
    code: Schema.Literal("probe_failed"),
  },
) {}

// Only video pixels enter memory; authenticated pages and media addresses are never captured.
async function videoFrame(page: Page, expectedSources: readonly string[]) {
  const video = page.locator("video");
  await expect(video).toBeVisible();
  const state = await video.evaluate(
    (element: HTMLVideoElement, expected: readonly string[]) => ({
      engineSource: expected.includes(element.currentSrc),
      width: element.videoWidth,
      height: element.videoHeight,
      time: element.currentTime,
      frames: element.getVideoPlaybackQuality().totalVideoFrames,
      audioBytes: Number(Reflect.get(element, "webkitAudioDecodedByteCount")),
      externalHttps:
        element.currentSrc.startsWith("https://") &&
        new URL(element.currentSrc).hostname !== "127.0.0.1",
    }),
    expectedSources,
  );
  assert.equal(state.engineSource, true);
  assert.equal(state.width, 640);
  assert.equal(state.height, 360);
  assert.equal(state.externalHttps, true);
  const pixels = await video.screenshot({ timeout: 5000 });
  const metadata = await sharp(pixels).metadata();
  assert.ok(metadata.width && metadata.height);
  const height = Math.round((metadata.width * 360) / 640);
  const { data, info } = await sharp(pixels)
    .extract({
      left: 0,
      top: Math.round((metadata.height - height) / 2),
      width: metadata.width,
      height,
    })
    .resize(640, 360)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => [
    ...data.subarray(
      (y * 640 + x) * info.channels,
      (y * 640 + x) * info.channels + 3,
    ),
  ];
  let marker = -1;
  for (let x = 60; x < 575; x++) {
    if (pixel(x, 294).every((channel) => channel > 220)) {
      marker = Math.round((x - 60) / 14);
      break;
    }
  }
  assert.ok(marker >= 0 && marker < 36);
  const rgb = pixel(20, 150);
  assert.ok((rgb[0] ?? 0) > 140 && rgb.slice(1).every((value) => value < 100));
  const region = await sharp(pixels)
    .extract({
      left: Math.round(metadata.width * 0.14),
      top: Math.round(metadata.height * 0.45),
      width: Math.round(metadata.width * 0.55),
      height: Math.round(metadata.height * 0.1),
    })
    .toBuffer();
  return {
    ...state,
    marker,
    identityPixels: true,
    pixelsHash: createHash("sha256").update(region).digest("hex"),
  };
}

export async function proveDecoded(
  page: Page,
  expectedSources: readonly string[],
) {
  await expect
    .poll(
      () =>
        page
          .locator("video")
          .evaluate((video: HTMLVideoElement) => video.readyState)
          .catch(() => 0),
      { timeout: 30000 },
    )
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(
      () =>
        page
          .locator("video")
          .evaluate((video: HTMLVideoElement) => video.currentTime),
      { timeout: 15000 },
    )
    .toBeGreaterThan(0.5);
  const first = await videoFrame(page, expectedSources);
  await expect
    .poll(async () => (await videoFrame(page, expectedSources)).marker, {
      timeout: 8000,
    })
    .toBeGreaterThan(first.marker);
  const second = await videoFrame(page, expectedSources);
  assert.ok(second.frames > first.frames);
  assert.notEqual(first.pixelsHash, second.pixelsHash);
  assert.ok(second.audioBytes > 0);
  return { first, second };
}

async function openExactAddon(page: Page, web: string, manifest: string) {
  await page.goto(`${web}/#/addons`);
  await page.getByTitle("Add addon", { exact: true }).click();
  await page.getByPlaceholder("Paste addon URL").fill(manifest);
  await page.getByText("Add", { exact: true }).click();
}

export const runAuthenticatedAdapter = Effect.fn(
  "live.runAuthenticatedAdapter",
)(function* (credentials: {
  chillToken: string;
  stremioEmail: string;
  stremioPassword: string;
}) {
  const stamp = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const directory = `artifacts/live-adapter-${stamp}`;
  const attempt = createLiveAttempt();
  const checkpoint = writeRecoveryJournal(
    attempt,
    `.cache/live/recovery/adapter-${stamp}.json`,
  );
  let stage = "preflight";
  const proof: Record<string, unknown> = {
    loggedIn: false,
    installed: false,
    addonRemoved: true,
    browserClosed: false,
    adapterClosed: false,
    webClosed: false,
  };
  const subtitleProof = {
    engineTracks: 0,
    engineFixtureTracks: 0,
    selectedLanguage: "",
    engineLanguages: [] as string[],
    responseStatuses: [] as number[],
    providerCueFetched: false,
    englishRendered: false,
    offRemoved: false,
    englishReselected: false,
  };
  proof.subtitles = subtitleProof;
  const calls = { folder: 0, playback: 0 };
  const expectedSources: string[] = [];
  const expectedSubtitles = new Map<string, string>();
  let webOrigin: string | undefined;
  const cleanupFailures: string[] = [];
  const sanitizeFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.catchCause(() =>
        Effect.fail(new AdapterProbeFailure({ stage, code: "probe_failed" })),
      ),
    );
  const program = Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        chillToken: Schema.NonEmptyString,
        stremioEmail: Schema.NonEmptyString,
        stremioPassword: Schema.NonEmptyString,
      }),
    )(credentials);
    yield* validateProvenance();
    const ledgerDirectory = yield* Effect.tryPromise(() =>
      registeredLiveRunner(),
    );
    const account = yield* accountInfo();
    if (
      !process.env[liveVersions.usernameEnv] ||
      account.username !== process.env[liveVersions.usernameEnv]?.trim()
    )
      return yield* new AdapterProbeFailure({
        stage: "designated-account",
        code: "probe_failed",
      });
    const source = yield* ensureLiveSource();
    const captions = fixtureSrt();
    const captionsPath = `.cache/live/${liveSubtitleName(stamp)}`;
    yield* Effect.tryPromise(async () => {
      await mkdir(".cache/live", { recursive: true, mode: 0o700 });
      await writeFile(captionsPath, captions, { mode: 0o600 });
    });
    yield* Effect.tryPromise((signal) =>
      reserve(
        ledgerDirectory,
        3,
        source.bytes + Buffer.byteLength(captions),
        undefined,
        {
          signal,
        },
      ),
    );
    stage = "create-owned-fixture";
    const folder = yield* trackAcquisition(
      attempt,
      "file",
      createFolder(liveFolderName(stamp)),
      checkpoint,
    );
    const name = liveUploadName(stamp);
    const uploaded = yield* trackAcquisition(
      attempt,
      "file",
      uploadFile(source.path, name, folder.id),
      checkpoint,
    );
    yield* trackAcquisition(
      attempt,
      "file",
      uploadFile(
        captionsPath,
        liveSubtitleName(stamp),
        folder.id,
        "text/plain",
      ),
      checkpoint,
    );
    proof.source = {
      kind: "self-generated-fixture",
      bytes: source.bytes,
      sha256: source.sha256,
      subtitleBytes: Buffer.byteLength(captions),
    };
    stage = "provider-subtitle-indexing";
    const providerChecks: unknown[] = [];
    proof.providerSubtitles = providerChecks;
    const token = process.env[liveVersions.putioTokenEnv];
    for (let check = 0; check < 6; check++) {
      const preferred = yield* listSubtitles(uploaded.id, []);
      const english = yield* listSubtitles(uploaded.id);
      const describe = (tracks: typeof preferred) => ({
        count: tracks.length,
        tracks: tracks.map((track) => ({
          languageCode: /^[a-z]{2,3}$/.test(track.language_code ?? "")
            ? track.language_code
            : "unknown",
          format: ["srt", "vtt", "webvtt"].includes(track.format ?? "")
            ? track.format
            : "unknown",
          hasURL: Boolean(track.url),
          accountTokenPresent: Boolean(token && track.url?.includes(token)),
        })),
      });
      providerChecks.push({
        preferred: describe(preferred),
        english: describe(english),
      });
      if (preferred.length > 0 || english.length > 0) break;
      if (check < 5) yield* Effect.sleep("2 seconds");
    }
    stage = "start-services";
    const web = yield* startWeb;
    webOrigin = web.origin;
    const layer = Layer.effect(
      Engine,
      Effect.gen(function* () {
        const engine = yield* Engine;
        return Engine.of({
          getFolder: (id) =>
            engine.getFolder(id).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  calls.folder++;
                }),
              ),
            ),
          resolvePlayback: (id) =>
            engine.resolvePlayback(id).pipe(
              Effect.tap((response) =>
                Effect.sync(() => {
                  calls.playback++;
                  if (
                    response.result.case === "ready" &&
                    response.result.value.media
                  ) {
                    expectedSources.push(response.result.value.media.url);
                    subtitleProof.engineTracks =
                      response.result.value.subtitles.length;
                    subtitleProof.engineLanguages = [
                      ...new Set(
                        response.result.value.subtitles.map((track) =>
                          /^[a-z]{3}$/.test(track.language)
                            ? track.language
                            : "und",
                        ),
                      ),
                    ];
                    for (const track of response.result.value.subtitles) {
                      if (
                        (track.language === "eng" ||
                          track.language === "und") &&
                        track.source
                      )
                        expectedSubtitles.set(track.source.url, track.language);
                    }
                    subtitleProof.engineFixtureTracks = expectedSubtitles.size;
                  }
                }),
              ),
            ),
        });
      }),
    ).pipe(
      Layer.provide(
        engineLayer({
          baseUrl: "https://api.chill.institute/v4",
          token: credentials.chillToken,
        }),
      ),
    );
    const adapter = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        startAdapter({ layer, folderId: BigInt(folder.id) }),
      ),
      (server) =>
        Effect.tryPromise(async () => {
          await server.close();
          proof.adapterClosed = true;
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.catchCause(() =>
            Effect.sync(() => {
              cleanupFailures.push("adapter-close");
            }),
          ),
        ),
    );
    const browser = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        chromium.launch({
          channel: "chromium",
          headless: true,
          timeout: 20000,
        }),
      ),
      (instance) =>
        Effect.tryPromise(async () => {
          await instance.close();
          proof.browserClosed = !instance.isConnected();
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.catchCause(() =>
            Effect.sync(() => {
              cleanupFailures.push("browser-close");
            }),
          ),
        ),
    );
    let installAttempted = false;
    let authKey: string | undefined;
    const session = yield* Effect.acquireRelease(
      Effect.tryPromise(async () => {
        const context = await browser.newContext({
          viewport: { width: 1280, height: 800 },
          locale: "en-US",
          serviceWorkers: "block",
        });
        try {
          return { context, page: await context.newPage() };
        } catch {
          await context.close();
          throw new Error("Browser session failed");
        }
      }),
      ({ context, page }) =>
        Effect.tryPromise(async () => {
          await page.close();
          if (installAttempted) {
            if (!authKey) throw new Error("Account session unavailable");
            await removeOwnedAddon(authKey, adapter.manifestUrl);
            proof.remoteAddonRemovalVerified = true;
            proof.addonRemoved = true;
          }
        }).pipe(
          Effect.interruptible,
          Effect.timeout("60 seconds"),
          Effect.catchCause(() =>
            Effect.sync(() => {
              cleanupFailures.push("addon-uninstall");
            }),
          ),
          Effect.ensuring(
            Effect.tryPromise(() => context.close()).pipe(
              Effect.interruptible,
              Effect.timeout("10 seconds"),
              Effect.catchCause(() =>
                Effect.sync(() => {
                  cleanupFailures.push("context-close");
                }),
              ),
            ),
          ),
        ),
    );
    yield* Effect.tryPromise(async (signal) => {
      const { context, page } = session;
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(20000);
      let leaked = false;
      const subtitleResponses: Promise<boolean>[] = [];
      page.on("response", (response) => {
        if (expectedSubtitles.has(response.url())) {
          subtitleProof.responseStatuses.push(response.status());
          subtitleResponses.push(
            response.text().then(
              (body) => {
                const matched =
                  response.ok() && body.includes(liveVersions.fixtureSubtitle);
                subtitleProof.providerCueFetched ||= matched;
                return matched;
              },
              () => false,
            ),
          );
        }
      });
      await context.route("**/*", async (route) => {
        const request = route.request();
        const headers = JSON.stringify(await request.allHeaders());
        const providerToken = process.env[liveVersions.putioTokenEnv];
        if (
          request.url().includes(credentials.chillToken) ||
          headers.includes(credentials.chillToken) ||
          (providerToken &&
            (request.url().includes(providerToken) ||
              headers.includes(providerToken)))
        ) {
          leaked = true;
          await route.abort();
        } else await route.continue();
      });
      const abort = () => {
        void page.close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        stage = "stremio-login";
        await page.addLocatorHandler(
          page.getByText("Don't show again", { exact: true }),
          async (prompt) => {
            await prompt.click({ timeout: 1000 }).catch(() => {});
          },
          { noWaitAfter: true },
        );
        await page.goto(`${web.origin}/#/intro?form=login`);
        await page
          .locator('input[type="email"]')
          .fill(credentials.stremioEmail);
        await page
          .locator('input[type="password"]')
          .fill(credentials.stremioPassword);
        const authenticated = page.waitForResponse(
          (response) =>
            new URL(response.url()).origin === "https://api.strem.io" &&
            new URL(response.url()).pathname === "/api/login" &&
            response.request().method() === "POST",
          { timeout: 30000 },
        );
        await page.locator('input[type="password"]').press("Enter");
        const loginResponse = await authenticated;
        assert.equal(loginResponse.status(), 200);
        const login = Schema.decodeUnknownSync(
          Schema.Struct({
            result: Schema.Struct({
              authKey: Schema.NonEmptyString,
              user: Schema.Struct({ email: Schema.String }),
            }),
          }),
        )(await loginResponse.json());
        assert.equal(login.result.user.email, credentials.stremioEmail);
        authKey = login.result.authKey;
        await page.waitForURL((url) => !url.hash.startsWith("#/intro"), {
          timeout: 30000,
        });
        await expect(async () => {
          await page.evaluate(() => {
            window.location.hash = "#/settings";
          });
          await expect(
            page.getByText(credentials.stremioEmail, { exact: true }).first(),
          ).toBeVisible({ timeout: 1000 });
        }).toPass({ timeout: 20000, intervals: [500] });
        proof.loggedIn = true;
        stage = "install-addon";
        await page.goto(`${web.origin}/#/addons`);
        if (await page.getByText("chill.institute", { exact: true }).count()) {
          stage = "existing-addon-preserved";
          throw new Error("Existing integration requires reconciliation");
        }
        await openExactAddon(page, web.origin, adapter.manifestUrl);
        const install = page
          .getByText("Install", { exact: true })
          .filter({ visible: true });
        await expect(install).toBeVisible();
        installAttempted = true;
        proof.addonRemoved = false;
        await install.click();
        proof.installed = true;
        stage = "browse-engine-folder";
        await page.getByRole("link", { name: "Discover", exact: true }).click();
        const filters = page.locator('[aria-haspopup="listbox"]');
        await filters.nth(1).click();
        await page
          .getByRole("listbox")
          .getByText("put.io library", { exact: true })
          .click();
        await expect(page).toHaveURL(/\/movie\/library(?:$|\?)/);
        await page.getByText(name, { exact: true }).first().click();
        proof.catalogBrowsed = true;
        stage = "select-engine-stream";
        const preview = page
          .getByText("Show", { exact: true })
          .filter({ visible: true });
        const stream = page
          .getByText("chill.institute", { exact: true })
          .filter({ visible: true })
          .last();
        await expect(preview.or(stream).first()).toBeVisible();
        if (await preview.isVisible())
          await preview.click({ timeout: 1000 }).catch(async () => {
            await expect(stream).toBeVisible();
          });
        await stream.click();
        stage = "decoded-playback";
        proof.playback = await proveDecoded(page, expectedSources);
        stage = "engine-subtitle-tracks";
        assert.equal(
          expectedSubtitles.size,
          1,
          "Expected one generated fixture subtitle track",
        );
        const selectedLanguage = expectedSubtitles.values().next().value;
        assert.ok(selectedLanguage);
        subtitleProof.selectedLanguage = selectedLanguage;
        await page
          .locator("video")
          .evaluate((video: HTMLVideoElement) => video.pause());
        await page.mouse.move(600, 400);
        const subtitles = page
          .locator('[class*="control-bar-button-"]')
          .filter({ has: page.locator('svg path[d^="M482.6 216.7"]') });
        const cue = page.getByText(liveVersions.fixtureSubtitle, {
          exact: true,
        });
        stage = "subtitle-menu";
        await subtitles.click();
        stage = "subtitle-select-fixture";
        await page.locator(`[data-lang="${selectedLanguage}"]`).click();
        const variant = page.locator('[class*="variant-option-"]');
        await expect(variant).toHaveCount(1);
        await variant.click();
        await subtitles.click();
        stage = "subtitle-fetch";
        await expect
          .poll(async () =>
            (await Promise.all(subtitleResponses)).some(Boolean),
          )
          .toBe(true);
        stage = "subtitle-render";
        await expect(cue).toBeVisible();
        subtitleProof.englishRendered = true;
        stage = "subtitle-off";
        await subtitles.click();
        await page.getByTitle("OFF", { exact: true }).click();
        await subtitles.click();
        await expect(cue).toHaveCount(0);
        subtitleProof.offRemoved = true;
        stage = "subtitle-reselect";
        await subtitles.click();
        await page.locator(`[data-lang="${selectedLanguage}"]`).click();
        await expect(variant).toHaveCount(1);
        await variant.click();
        await subtitles.click();
        await expect(cue).toBeVisible();
        subtitleProof.englishReselected = true;
        assert.ok(calls.folder > 0 && calls.playback > 0);
        assert.equal(leaked, false);
        proof.engineBearerAbsentFromBrowser = true;
        proof.providerBearerAbsentFromBrowser = true;
      } finally {
        signal.removeEventListener("abort", abort);
      }
    });
  }).pipe(
    Effect.timeout("8 minutes"),
    Effect.scoped,
    Effect.ensuring(
      Effect.promise(async () => {
        if (!webOrigin) return;
        const endpoint = new URL(webOrigin);
        proof.webClosed = await new Promise<boolean>((resolve) => {
          const socket = createConnection({
            host: endpoint.hostname,
            port: Number(endpoint.port),
          });
          const finish = (closed: boolean) => {
            socket.destroy();
            resolve(closed);
          };
          socket.once("connect", () => finish(false));
          socket.once("error", (error) =>
            finish("code" in error && error.code === "ECONNREFUSED"),
          );
          socket.setTimeout(1000, () => finish(false));
        });
        if (!proof.webClosed) cleanupFailures.push("web-close");
      }),
    ),
  );
  yield* withLiveLifecycle(attempt, sanitizeFailure(program), {
    cancelTransfers,
    deleteFiles,
    checkpoint,
    publish: (outcome) =>
      Effect.tryPromise(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const status =
          outcome.status === "passed" && cleanupFailures.length === 0
            ? "passed"
            : "failed";
        await writeFile(
          `${directory}/results.json`,
          JSON.stringify(
            {
              status,
              stage,
              code: status === "failed" ? "probe_failed" : undefined,
              client: "authenticated-pinned-stremio-web",
              engine: "production",
              provider: "designated-putio-account",
              proof,
              calls,
              cleanupFailures,
              cleanup: {
                status: outcome.cleanup.status,
                files: {
                  status: outcome.cleanup.files.status,
                  count: outcome.cleanup.files.count,
                },
                transfers: {
                  status: outcome.cleanup.transfers.status,
                  count: outcome.cleanup.transfers.count,
                },
                pendingAcquisitions: outcome.cleanup.pendingAcquisitions,
                recoveryFailed: Boolean(outcome.cleanup.recoveryError),
              },
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        console.log(
          JSON.stringify({
            status,
            stage,
            results: `${directory}/results.json`,
          }),
        );
      }),
  });
  return {
    directory,
    status:
      attempt.outcome?.status === "passed" && cleanupFailures.length === 0
        ? "passed"
        : "failed",
  };
});
