import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { chromium, expect } from "@playwright/test";
import {
  audioFrequency,
  attachAudioProbe,
  verifyAudioFrequency,
} from "./hls-browser.ts";
import { generateHls, startHlsFixture } from "./hls-fixture.ts";
import { startWeb } from "./web.ts";
import { seekRenderedDestination, verifySubtitleControls } from "./browser.ts";
import { validateProvenance } from "./provenance.ts";

const packaging = process.argv[2] ?? "muxed-ts";
if (packaging !== "muxed-ts" && packaging !== "separate-fmp4")
  throw new Error("Expected muxed-ts or separate-fmp4");
const directory = `artifacts/hls-${Date.now()}`;
const evidence: Record<string, unknown> = {
  credentials: false,
  packaging,
  native: "not-run",
};
let passed = false;

const program = Effect.gen(function* () {
  yield* Effect.promise(() => mkdir(directory, { recursive: true }));
  evidence.provenance = yield* validateProvenance();
  evidence.generatedMedia = yield* Effect.tryPromise(() =>
    generateHls(`${directory}/media`, undefined, packaging),
  );
  const fixture = yield* Effect.acquireRelease(
    Effect.tryPromise(() => startHlsFixture(`${directory}/media`)),
    (value) =>
      Effect.promise(async () => {
        await value.close();
        evidence.fixtureClosed = true;
      }),
  );
  const web = yield* startWeb;
  const browser = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      chromium.launch({ channel: "chromium", headless: true, timeout: 20000 }),
    ),
    (value) =>
      Effect.promise(async () => {
        await value.close();
        evidence.browserClosed = !value.isConnected();
      }),
  );
  evidence.browser = browser.version();
  yield* Effect.tryPromise(async (signal) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: "en-US",
      serviceWorkers: "block",
    });
    const abort = () => {
      void context.close().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    const page = await context.newPage();
    const consoleMessages: string[] = [];
    page.on("console", (message) => consoleMessages.push(message.text()));
    page.on("console", (message) => {
      if (message.text().startsWith("Player "))
        void Promise.all(
          message.args().map((argument) => argument.jsonValue()),
        ).then((values) => {
          evidence.playerError = values;
        });
    });
    page.setDefaultTimeout(12000);
    await context.route("**/*", (route) =>
      [fixture.origin, web.origin].includes(
        new URL(route.request().url()).origin,
      )
        ? route.continue()
        : route.abort(),
    );
    await page.addLocatorHandler(
      page.getByText("Don't show again", { exact: true }),
      async (prompt) => {
        await prompt.click({ timeout: 1000 }).catch(() => {});
      },
      { noWaitAfter: true },
    );
    try {
      await page.goto(web.origin);
      await page.getByText("Addons", { exact: true }).click();
      await page.getByTitle("Add addon", { exact: true }).click();
      await page
        .getByPlaceholder("Paste addon URL")
        .fill(`${fixture.origin}/manifest.json`);
      await page.getByText("Add", { exact: true }).click();
      await page
        .getByText("Install", { exact: true })
        .filter({ visible: true })
        .click();
      await expect(
        page.getByText("Chill HLS Fixture", { exact: true }),
      ).toBeVisible();
      await page.goto(`${web.origin}/#/`);
      await page.getByText("HLS Fixture", { exact: true }).first().click();
      await page.getByText("HLS multi-audio", { exact: true }).click();
      await expect
        .poll(
          () =>
            page
              .locator("video")
              .evaluate(
                (video: HTMLVideoElement) =>
                  video.getVideoPlaybackQuality().totalVideoFrames,
              ),
          { timeout: 20000 },
        )
        .toBeGreaterThan(24);
      await attachAudioProbe(page);
      await expect
        .poll(async () => {
          const sample = await audioFrequency(page);
          return sample.rms > 0.01 && Math.abs(sample.frequency - 440) < 15;
        })
        .toBe(true);
      evidence.english = await audioFrequency(page);
      await page.mouse.move(600, 400);
      const audio = page
        .locator('[class*="control-bar-button-"]')
        .filter({ has: page.locator('svg path[d^="M57.48 223.57"]') });
      await audio.click();
      await expect(
        page.getByTitle("English 440 Hz", { exact: true }),
      ).toBeVisible();
      await page.getByTitle("Spanish 880 Hz", { exact: true }).click();
      evidence.spanish = await verifyAudioFrequency(page, 880);
      await audio.click();
      evidence.seek = await seekRenderedDestination(page, directory);
      evidence.subtitles = await verifySubtitleControls(page, directory);
      await page.mouse.move(600, 400);
      await audio.click();
      await page.getByTitle("English 440 Hz", { exact: true }).click();
      await expect
        .poll(
          async () => Math.abs((await audioFrequency(page)).frequency - 440),
          { timeout: 10000 },
        )
        .toBeLessThan(15);
      evidence.englishReselected = await audioFrequency(page);
      assert.ok(
        fixture.requests.some(
          (path) =>
            path.includes("spanish") &&
            path.endsWith(packaging === "muxed-ts" ? ".ts" : ".m4s"),
        ),
      );
      evidence.requests = fixture.requests;
      await page.screenshot({ path: `${directory}/audio-switched.png` });
      passed = true;
    } catch (error) {
      evidence.mediaError = await page
        .locator("video")
        .evaluate((video: HTMLVideoElement) => video.error?.message)
        .catch(() => "unavailable");
      evidence.failure = String(error);
      evidence.console = consoleMessages.slice(-30);
      evidence.requests = fixture.requests;
      await page
        .screenshot({ path: `${directory}/failure.png` })
        .catch(() => {});
      await writeFile(
        `${directory}/page.txt`,
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable"),
      );
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      await context.close();
    }
  });
}).pipe(
  Effect.scoped,
  Effect.tap(() =>
    Effect.sync(() => {
      evidence.webClosed = true;
    }),
  ),
  Effect.timeout("4 minutes"),
  Effect.catch((error) =>
    Effect.sync(() => {
      passed = false;
      evidence.error = String(error);
      process.exitCode = 1;
    }),
  ),
  Effect.ensuring(
    Effect.promise(async () => {
      await mkdir(directory, { recursive: true });
      await writeFile(
        `${directory}/results.json`,
        JSON.stringify(
          { status: passed ? "passed" : "failed", ...evidence },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          status: passed ? "passed" : "failed",
          results: `${directory}/results.json`,
        }),
      );
    }),
  ),
  Effect.provide(NodeServices.layer),
);
NodeRuntime.runMain(program);
