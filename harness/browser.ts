import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { expect, type Page } from "@playwright/test";
import sharp from "sharp";
import type { Fixture } from "./fixture.ts";

export interface Scenario {
  name: string;
  status: "passed" | "failed" | "limitation";
  evidence?: unknown;
  error?: string;
  durationMs?: number;
}
export const redact = (text: string) =>
  stripVTControlCharacters(text)
    .replace(/https?:\/\/[^\s"'<>]+/g, "[url]")
    .replace(/\/Users\/[^/]+/g, "/Users/[user]");

async function frame(page: Page, path?: string) {
  const video = page.locator("video");
  await expect(video).toBeVisible();
  const state = await video.evaluate((v: HTMLVideoElement) => ({
    width: v.videoWidth,
    height: v.videoHeight,
    time: v.currentTime,
    decoded: v.getVideoPlaybackQuality().totalVideoFrames,
    source: new URL(v.currentSrc).pathname,
    origin: new URL(v.currentSrc).origin,
    audioBytes: Number(Reflect.get(v, "webkitAudioDecodedByteCount")),
  }));
  assert.equal(state.width, 640);
  assert.equal(state.height, 360);
  const screenshot = await video.screenshot({ timeout: 5000 });
  if (path) await writeFile(path, screenshot);
  const metadata = await sharp(screenshot).metadata();
  assert.ok(metadata.width && metadata.height);
  const height = Math.round((metadata.width * 360) / 640);
  const { data, info } = await sharp(screenshot)
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
    if (pixel(x, 294).every((c) => c > 220)) {
      marker = Math.round((x - 60) / 14);
      break;
    }
  }
  assert.ok(
    marker >= 0 && marker < 36,
    "Rendered moving frame marker is missing",
  );
  const region = await sharp(screenshot)
    .extract({
      left: Math.round(metadata.width * 0.14),
      top: Math.round(metadata.height * 0.45),
      width: Math.round(metadata.width * 0.55),
      height: Math.round(metadata.height * 0.1),
    })
    .toBuffer();
  return {
    ...state,
    rgb: pixel(20, 150),
    marker,
    pixelsHash: createHash("sha256").update(region).digest("hex"),
  };
}

export async function seekRenderedDestination(page: Page, directory: string) {
  await page.mouse.move(600, 400);
  const slider = page.locator(
    '[class*="seek-bar-container"] [class*="slider-wrapper"]',
  );
  const box = await slider.boundingBox();
  assert.ok(box);
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height / 2);
  await expect
    .poll(() =>
      page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThan(18);
  let evidence = await frame(page, `${directory}/seek.png`);
  await expect
    .poll(
      async () => {
        evidence = await frame(page, `${directory}/seek.png`);
        return evidence.marker >= 18 && evidence.marker <= 23;
      },
      {
        timeout: 5000,
        message: "Seek must render a decoded frame near 20 seconds",
      },
    )
    .toBe(true);
  return { targetSeconds: 19.8, ...evidence };
}

export async function verifySubtitleControls(page: Page, directory: string) {
  await expect(
    page.getByText("FIXTURE SUBTITLE ENGLISH", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${directory}/subtitles-on.png` });
  await page.mouse.move(600, 400);
  // The pinned upstream icon button has no accessible name. Select its stable subtitle SVG path.
  const subtitles = page
    .locator('[class*="control-bar-button-"]')
    .filter({ has: page.locator('svg path[d^="M482.6 216.7"]') });
  await subtitles.click();
  await page.getByTitle("OFF", { exact: true }).click();
  await expect(
    page.getByText("FIXTURE SUBTITLE ENGLISH", { exact: true }),
  ).toHaveCount(0);
  await subtitles.click();
  await expect(
    page.getByText("Subtitles Languages", { exact: true }),
  ).toBeHidden();
  await page.screenshot({ path: `${directory}/subtitles-off.png` });
  await subtitles.click();
  await page.locator('[data-lang="spa"]').click();
  await subtitles.click();
  await expect(
    page.getByText("Subtitles Languages", { exact: true }),
  ).toBeHidden();
  await expect(
    page.getByText("SUBTITULO DE PRUEBA", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: `${directory}/subtitles-selected.png` });
  return {
    englishRendered: true,
    offRemoved: true,
    spanishSelectedAndRendered: true,
  };
}

export async function decoded(
  page: Page,
  fixture: Fixture,
  name: "movie" | "episode1" | "episode2",
  path: string,
) {
  await expect
    .poll(
      () =>
        page
          .locator("video")
          .evaluate((v: HTMLVideoElement) => v.readyState)
          .catch(() => 0),
      { timeout: 15000 },
    )
    .toBeGreaterThanOrEqual(2);
  await expect
    .poll(
      () =>
        page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
      {
        timeout: 10000,
      },
    )
    .toBeGreaterThan(0.5);
  const first = await frame(page);
  await expect
    .poll(async () => (await frame(page)).marker, { timeout: 6000 })
    .toBeGreaterThan(first.marker);
  const second = await frame(page, path);
  assert.equal(
    second.origin,
    fixture.origin,
    "Playback must use direct fixture HTTP",
  );
  const channel = name === "movie" ? 0 : name === "episode1" ? 1 : 2;
  assert.ok(
    (second.rgb[channel] ?? 0) > 140 &&
      second.rgb.every((v, i) => i === channel || v < 100),
    "Decoded fixture identity color differs",
  );
  assert.ok(
    second.decoded > first.decoded,
    "Decoded frame count did not increase",
  );
  assert.notEqual(
    second.pixelsHash,
    first.pixelsHash,
    "Rendered time/frame pixels did not change",
  );
  assert.ok((second.audioBytes ?? 0) > 0, "AAC audio was not decoded");
  return { first, second };
}

export async function exerciseBrowser(
  page: Page,
  web: string,
  fixture: Fixture,
  directory: string,
  scenarios: Scenario[],
) {
  page.setDefaultTimeout(12000);
  page.setDefaultNavigationTimeout(15000);
  await page.addLocatorHandler(
    page.getByText("Don't show again", { exact: true }),
    async (prompt) => {
      // This optional upstream prompt can disappear while a route transition completes.
      await prompt.click({ timeout: 1000 }).catch(() => {});
    },
    { noWaitAfter: true },
  );
  const step = async (name: string, run: () => Promise<unknown>) => {
    const started = performance.now();
    try {
      const evidence = await run();
      scenarios.push({
        name,
        status: "passed",
        evidence,
        durationMs: Math.round(performance.now() - started),
      });
    } catch (error) {
      scenarios.push({
        name,
        status: "failed",
        error: redact(String(error)),
        durationMs: Math.round(performance.now() - started),
      });
      throw error;
    } finally {
      console.log(
        JSON.stringify({
          scenario: name,
          status: scenarios.at(-1)?.status,
          durationMs: scenarios.at(-1)?.durationMs,
        }),
      );
    }
  };
  await step("codec-support", async () => {
    await page.goto(web);
    const support = await page.evaluate(() =>
      document
        .createElement("video")
        .canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"'),
    );
    assert.equal(support, "probably");
    return { h264Aac: support };
  });
  await step("ui-installation", async () => {
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
      page.getByText("Chill Fixture", { exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: `${directory}/installed.png` });
    return {
      storageInjected: false,
      flow: "Addons → Add addon → URL → Add → Install",
      account: "guest",
    };
  });
  const movie = async () => {
    await page.goto(`${web}/#/`);
    await page.getByText("Fixture Movie", { exact: true }).first().click();
    await expect(
      page.getByText("Direct fixture", { exact: true }).first(),
    ).toBeVisible();
  };
  await step("interrupted-playback-recovery", async () => {
    await movie();
    const control = fixture.prepareInterruption();
    try {
      await page
        .getByText("Interrupted fixture", { exact: true })
        .first()
        .click();
      const before = await decoded(
        page,
        fixture,
        "movie",
        `${directory}/interrupted-playing.png`,
      );
      assert.equal(
        fixture.metrics.interruptedCuts,
        0,
        "Playback must decode before interruption",
      );
      assert.ok(
        before.second.audioBytes > before.first.audioBytes,
        "AAC decoding did not advance before interruption",
      );
      control.arm();
      await expect
        .poll(() => fixture.metrics.interruptedCuts, { timeout: 10000 })
        .toBeGreaterThan(0);
      await expect
        .poll(
          () =>
            page
              .locator("video")
              .evaluate(
                (v: HTMLVideoElement) => Boolean(v.error) || v.readyState < 3,
              )
              .catch(() => true),
          { timeout: 20000 },
        )
        .toBe(true);
      await page.screenshot({ path: `${directory}/interrupted-stalled.png` });
      await movie();
      await page.getByText("Direct fixture", { exact: true }).first().click();
      return {
        before,
        cuts: fixture.metrics.interruptedCuts,
        recovered: await decoded(
          page,
          fixture,
          "movie",
          `${directory}/interrupted-recovered.png`,
        ),
      };
    } finally {
      control.cancel();
    }
  });
  await step("movie-source-and-decoded-playback", async () => {
    await movie();
    await page.getByText("Direct fixture", { exact: true }).first().click();
    return decoded(page, fixture, "movie", `${directory}/movie.png`);
  });
  await step("seek-rendered-destination", () =>
    seekRenderedDestination(page, directory),
  );
  await step("subtitles-selection-render-and-removal", () =>
    verifySubtitleControls(page, directory),
  );
  await step("episode-one-and-next-episode", async () => {
    await page.goto(`${web}/#/`);
    await page.getByText("Fixture Series", { exact: true }).first().click();
    await page.getByText("1. Fixture Episode 1", { exact: true }).click();
    await page.getByText("Direct fixture", { exact: true }).first().click();
    const first = await decoded(
      page,
      fixture,
      "episode1",
      `${directory}/episode1.png`,
    );
    await page.mouse.move(600, 400);
    await page.getByTitle("Next Video", { exact: true }).click();
    await expect
      .poll(() =>
        page
          .locator("video")
          .evaluate((v: HTMLVideoElement) => new URL(v.currentSrc).pathname),
      )
      .toBe("/media/episode2.mp4");
    const next = await decoded(
      page,
      fixture,
      "episode2",
      `${directory}/episode2.png`,
    );
    return { first, next, trigger: "Next Video" };
  });
  await step("pending-explicit-retry", async () => {
    await movie();
    fixture.setPending(true);
    await page.reload();
    await expect(
      page.getByText(/No streams|No .*streams/i).first(),
    ).toBeVisible();
    await page.screenshot({ path: `${directory}/pending.png` });
    await page.reload();
    await page.getByText("Direct fixture", { exact: true }).first().click();
    return {
      attempts: 2,
      recovery: await decoded(
        page,
        fixture,
        "movie",
        `${directory}/pending-recovered.png`,
      ),
    };
  });
  for (const name of ["Unavailable", "Expired", "Pending"]) {
    await step(`${name.toLowerCase()}-source-recovery`, async () => {
      await movie();
      await page.getByText(`${name} fixture`, { exact: true }).first().click();
      await expect(
        page
          .getByText(
            /Video is not supported|Failed to fetch|error occurred|Could not play/i,
          )
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      await page.screenshot({
        path: `${directory}/${name.toLowerCase()}-error.png`,
      });
      await movie();
      await page.getByText("Direct fixture", { exact: true }).first().click();
      return {
        recovery: "User selects available source",
        decoded: await decoded(
          page,
          fixture,
          "movie",
          `${directory}/${name.toLowerCase()}-recovered.png`,
        ),
      };
    });
  }
}
