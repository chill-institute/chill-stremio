import assert from "node:assert/strict";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { chromium, expect } from "@playwright/test";
import { Effect, Schema } from "effect";
import { generateHls } from "../hls-fixture.ts";
import { attachAudioProbe, verifyAudioFrequency } from "../hls-browser.ts";
import { listen, close } from "../hosted-fixture.ts";
import { startWeb } from "../web.ts";
import { validateProvenance } from "../provenance.ts";
import { createLibrary } from "../../src/library.ts";
import { engineLayer } from "../../src/engine.ts";
import { authorizeChill } from "./auth.ts";
import { reserve } from "./allowance.ts";
import { registeredLiveRunner } from "./runner.ts";
import {
  accountInfo,
  createFolder,
  uploadFile,
  cancelTransfers,
  deleteFiles,
} from "./putio.ts";
import {
  createLiveAttempt,
  trackAcquisition,
  withLiveLifecycle,
  writeRecoveryJournal,
} from "./lifecycle.ts";

const stamp = Date.now();
const directory = `artifacts/live-hls-${stamp}`;
const attempt = createLiveAttempt();
const checkpoint = writeRecoveryJournal(
  attempt,
  `.cache/live/recovery/hls-${stamp}.json`,
);
const proof: Record<string, unknown> = {};
let stage = "setup";

const work = Effect.gen(function* () {
  yield* validateProvenance();
  const ledger = yield* Effect.tryPromise(() => registeredLiveRunner());
  const account = yield* accountInfo();
  assert.equal(account.username, process.env.PUTIO_USERNAME?.trim());
  yield* Effect.tryPromise(() => generateHls(`.cache/live/hls-${stamp}`));
  const source = `.cache/live/hls-${stamp}/multi-audio.mp4`;
  const bytes = yield* Effect.tryPromise(async () => (await stat(source)).size);
  yield* Effect.tryPromise((signal) =>
    reserve(ledger, 2, bytes, undefined, { signal }),
  );
  stage = "upload";
  const folder = yield* trackAcquisition(
    attempt,
    "file",
    createFolder(`chill-stremio-live-hls-${stamp}`),
    checkpoint,
  );
  const file = yield* trackAcquisition(
    attempt,
    "file",
    uploadFile(source, "fixture-multi-audio.mp4", folder.id),
    checkpoint,
  );
  stage = "provider-indexing";
  yield* Effect.tryPromise(async () => {
    for (let read = 0; read < 16; read++) {
      const response = await fetch(
        `https://api.put.io/v2/files/${file.id}?media_info=1`,
        {
          headers: {
            authorization: `Bearer ${process.env.PUTIO_TEST_TOKEN}`,
          },
          redirect: "manual",
          signal: AbortSignal.timeout(20000),
        },
      );
      assert.equal(response.status, 200);
      const metadata = Schema.decodeUnknownSync(
        Schema.Struct({
          file: Schema.Struct({
            file_type: Schema.String,
            media_info: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  streams: Schema.optional(
                    Schema.Array(Schema.Struct({ codec_type: Schema.String })),
                  ),
                }),
              ),
            ),
          }),
        }),
      )(await response.json());
      const streams = metadata.file.media_info?.streams ?? [];
      proof.indexed = {
        video: metadata.file.file_type === "VIDEO",
        audioTracks: streams.filter((stream) => stream.codec_type === "audio")
          .length,
        reads: read + 1,
      };
      if (metadata.file.file_type === "VIDEO" && streams.length) return;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("Provider media indexing did not finish");
  });
  stage = "engine-resolution";
  const chillToken = yield* Effect.tryPromise((signal) =>
    authorizeChill({ signal }),
  );
  const playback = yield* createLibrary(BigInt(folder.id))
    .streams({
      type: "movie",
      id: `chill:file:${file.id}`,
    })
    .pipe(
      Effect.provide(
        engineLayer({
          baseUrl: "https://api.chill.institute/v4",
          token: chillToken,
        }),
      ),
    );
  const selected = playback.streams[0];
  assert.ok(selected?.url);
  const hls = new URL(selected.url);
  assert.ok(hls.pathname.endsWith(".m3u8"));
  assert.equal(selected.behaviorHints?.notWebReady, false);
  assert.ok(!hls.href.includes(chillToken));
  proof.engine = "production";
  proof.adapter = "actual-library-translator";
  stage = "playlist";
  yield* Effect.tryPromise(async () => {
    const response = await fetch(hls, {
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
    });
    proof.playlistStatus = response.status;
    assert.equal(response.status, 200);
    const playlist = await response.text();
    assert.ok(playlist.startsWith("#EXTM3U"));
    assert.ok(!playlist.includes(process.env.PUTIO_TEST_TOKEN ?? "missing"));
    const tracks = playlist
      .split(/\r?\n/)
      .filter(
        (line) =>
          line.startsWith("#EXT-X-MEDIA:") && line.includes("TYPE=AUDIO"),
      );
    proof.playlist = { audioTracks: tracks.length, accountTokenPresent: false };
    assert.equal(tracks.length, 2);
  });
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const manifest = {
        id: "institute.chill.live-hls",
        version: "1.0.0",
        name: "HLS account probe",
        description: "Generated playback test",
        resources: ["catalog", "meta", "stream"],
        types: ["movie"],
        catalogs: [{ type: "movie", id: "fixture" }],
        idPrefixes: ["chill-hls:"],
      };
      const meta = {
        id: "chill-hls:fixture",
        type: "movie",
        name: "HLS account fixture",
      };
      const instance = createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "no-store");
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const body =
          path === "/manifest.json"
            ? manifest
            : path.startsWith("/catalog/")
              ? { metas: [meta] }
              : path.startsWith("/meta/")
                ? { meta }
                : path.startsWith("/stream/")
                  ? {
                      streams: [
                        {
                          ...selected,
                          name: "HLS account stream",
                        },
                      ],
                    }
                  : undefined;
        res
          .writeHead(body ? 200 : 404, { "Content-Type": "application/json" })
          .end(JSON.stringify(body ?? {}));
      });
      const origin = await listen(instance);
      return { instance, origin };
    }),
    (value) =>
      Effect.promise(async () => {
        await close(value.instance);
        proof.serverClosed = true;
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
        proof.browserClosed = true;
      }),
  );
  stage = "stremio-playback";
  yield* Effect.tryPromise(async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    let leaked = false;
    page.on("request", (request) => {
      if (
        request.url().includes(chillToken) ||
        request.url().includes(process.env.PUTIO_TEST_TOKEN ?? "missing")
      )
        leaked = true;
    });
    await page.addLocatorHandler(
      page.getByText("Don't show again", { exact: true }),
      async (locator) => {
        await locator.click({ timeout: 1000 }).catch(() => {});
      },
      { noWaitAfter: true },
    );
    await page.goto(web.origin);
    await page.getByText("Addons", { exact: true }).click();
    await page.getByTitle("Add addon", { exact: true }).click();
    await page
      .getByPlaceholder("Paste addon URL")
      .fill(`${server.origin}/manifest.json`);
    await page.getByText("Add", { exact: true }).click();
    await page
      .getByText("Install", { exact: true })
      .filter({ visible: true })
      .click();
    await expect(
      page.getByText("HLS account probe", { exact: true }),
    ).toBeVisible();
    await page.goto(`${web.origin}/#/`);
    await page
      .getByText("HLS account fixture", { exact: true })
      .first()
      .click();
    await page.getByText("HLS account stream", { exact: true }).click();
    await expect
      .poll(
        () =>
          page
            .locator("video")
            .evaluate(
              (video: HTMLVideoElement) =>
                video.getVideoPlaybackQuality().totalVideoFrames,
            ),
        { timeout: 30000 },
      )
      .toBeGreaterThan(24);
    await attachAudioProbe(page);
    proof.english = await verifyAudioFrequency(page, 440);
    await page.mouse.move(600, 400);
    const audio = page
      .locator('[class*="control-bar-button-"]')
      .filter({ has: page.locator('svg path[d^="M57.48 223.57"]') });
    await audio.click();
    const spanish = page
      .locator('[class*="audio-menu-"] [data-id]')
      .filter({ hasText: /Spanish|spa/i });
    await spanish.click();
    proof.spanish = await verifyAudioFrequency(page, 880);
    assert.equal(leaked, false);
    proof.accountTokenPresent = false;
    proof.decodedFrames = await page
      .locator("video")
      .evaluate(
        (video: HTMLVideoElement) =>
          video.getVideoPlaybackQuality().totalVideoFrames,
      );
    await context.close();
  });
}).pipe(
  Effect.scoped,
  Effect.timeout("5 minutes"),
  Effect.catchCause(() =>
    Effect.fail(new Error(`HLS probe failed at ${stage}`)),
  ),
);

NodeRuntime.runMain(
  withLiveLifecycle(attempt, work, {
    cancelTransfers,
    deleteFiles,
    checkpoint,
    publish: (outcome) =>
      Effect.promise(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(
          `${directory}/results.json`,
          JSON.stringify(
            { status: outcome.status, stage, proof, cleanup: outcome.cleanup },
            null,
            2,
          ),
        );
        console.log(
          JSON.stringify({
            status: outcome.status,
            results: `${directory}/results.json`,
          }),
        );
      }),
  }).pipe(Effect.provide(NodeServices.layer)),
);
