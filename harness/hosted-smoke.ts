import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { chromium, expect, type Page } from "@playwright/test";
import { Effect } from "effect";
import { redactCredentials } from "../src/credential.ts";
import { startHostedAdapter } from "../src/hosted.ts";
import {
  decoded,
  redact,
  seekRenderedDestination,
  verifySubtitleControls,
} from "./browser.ts";
import { startFixture } from "./fixture.ts";
import {
  close,
  fakeCredential,
  generateCertificates,
  hostedFixture,
  type HostedEngineCalls,
  listen,
  startHostedEngine,
  startHostedMedia,
} from "./hosted-fixture.ts";
import { validateProvenance } from "./provenance.ts";
import { versions } from "./versions.ts";
import { startWeb } from "./web.ts";

const directory = `artifacts/hosted-${new Date().toISOString().replaceAll(":", "-")}`;
const credential = fakeCredential();
const {
  movieName,
  discoveryName,
  seriesName,
  seriesImdbId,
  recoveryCases,
  multipleMovieName,
  multipleEpisodeName,
} = hostedFixture;
const publicAdapterOrigin = "https://stremio.chill.institute";
const manifestUrl = `${publicAdapterOrigin}/s/${credential}/manifest.json`;
let videos: string[] = [];
const endpoints: string[] = [];
const cleanupErrors: string[] = [];
const runs: {
  run: number;
  status: string;
  evidence?: unknown;
  error?: string;
}[] = [];
let failure: string | undefined;
let browserClosed = false;
let calls: HostedEngineCalls | undefined;
const safeError = (error: unknown) => redactCredentials(redact(String(error)));

const listenerClosed = (origin: string) =>
  new Promise<boolean>((resolve) => {
    const url = new URL(origin);
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port),
    });
    const finish = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", (error) =>
      finish("code" in error && error.code === "ECONNREFUSED"),
    );
    socket.setTimeout(1000, () => finish(false));
  });

/** Keeps the generated add-on link out of screenshots and the recording. */
const maskAddonUrl = (page: Page) =>
  page.addStyleTag({
    content:
      'input[placeholder="Paste addon URL"] { -webkit-text-security: disc; }',
  });

/** Opens a put.io library video from the current discover view and plays it. */
async function openLibraryFile(page: Page, name: string, fileId: bigint) {
  await page.getByText(name, { exact: true }).first().click();
  const show = page
    .getByRole("link")
    .and(page.locator(`a[href^="#/detail/"][href*="${fileId}"]`))
    .filter({ visible: true })
    .last();
  const stream = page
    .getByText("chill.institute", { exact: true })
    .filter({ visible: true })
    .last();
  // The card can navigate while its outgoing preview is still visible.
  if (await show.isVisible())
    await show.click({ timeout: 1000 }).catch(async () => {
      await expect(stream).toBeVisible();
    });
  await stream.click();
}

const program = Effect.gen(function* () {
  yield* Effect.promise(() => mkdir(directory, { recursive: true }));
  yield* validateProvenance();
  const fixture = yield* startFixture();
  endpoints.push(fixture.origin);
  const web = yield* startWeb;
  endpoints.push(web.origin);
  const certificates = yield* generateCertificates();
  const { media } = yield* startHostedMedia(fixture.origin, certificates, {
    hls: true,
  });
  endpoints.push(media.origin);
  const engine = yield* startHostedEngine({
    mediaOrigin: media.origin,
    credential,
    hls: true,
  });
  endpoints.push(engine.origin);
  calls = engine.calls;
  const setupServer = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const server = createServer((req, res) => {
        res
          .writeHead(req.url === "/stremio" ? 200 : 404, {
            "content-type": "text/plain",
          })
          .end("Generated account setup fixture");
      });
      const origin = await listen(server);
      endpoints.push(origin);
      return { server, origin };
    }),
    ({ server }) => Effect.promise(() => close(server)),
  );
  const adapter = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => ({
      current: await startHostedAdapter({
        engineBaseUrl: engine.origin,
        webOrigin: setupServer.origin,
      }),
    })),
    (server) => Effect.promise(() => server.current.close()),
  );
  endpoints.push(adapter.current.origin);
  const browser = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      chromium.launch({ channel: "chromium", headless: true, timeout: 20000 }),
    ),
    (instance) =>
      Effect.tryPromise(async () => {
        await instance.close();
        browserClosed = !instance.isConnected();
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.catch(() =>
          Effect.sync(() => {
            cleanupErrors.push("Browser cleanup failed");
          }),
        ),
      ),
  );
  for (const run of [1]) {
    yield* Effect.tryPromise(async (signal) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        serviceWorkers: "block",
        ignoreHTTPSErrors: true,
        recordVideo: {
          dir: `${directory}/video`,
          size: { width: 1280, height: 800 },
        },
      });
      const abort = () => {
        void context.close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      const navigationFailures: string[] = [];
      context.on("requestfailed", (request) => {
        if (request.isNavigationRequest() && navigationFailures.length < 10)
          navigationFailures.push(
            `${new URL(request.url()).protocol} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? "unknown"}`,
          );
      });
      let credentialLeak = false;
      let pendingMediaRequested = false;
      let episodeMediaRequested = false;
      const noticeRequests = new Set<string>();
      const playlistRequests = new Set<string>();
      context.on("request", (request) => {
        const pathname = new URL(request.url()).pathname;
        if (request.method() === "GET" && pathname.endsWith(".m3u8"))
          playlistRequests.add(pathname);
        if (request.method() === "GET" && pathname.includes("/notice/"))
          noticeRequests.add(pathname.split("/").at(-1) ?? "");
        if (
          request.url() === `${media.origin}/hls/episode1/master.m3u8` &&
          request.method() === "GET"
        )
          episodeMediaRequested = true;
        if (
          new URL(request.url()).pathname.endsWith("/notice/pending.mp4") &&
          request.method() === "GET"
        )
          pendingMediaRequested = true;
      });
      // Stremio prints the add-on URL in its install dialog; hide any element
      // showing a credential so screenshots and the recording never contain it.
      await context.addInitScript(() => {
        const hide = (node: Node) => {
          const element =
            node instanceof Element ? node : (node.parentElement ?? undefined);
          if (element && element.textContent?.includes("v4.local."))
            for (const child of [element, ...element.querySelectorAll("*")])
              if (
                child instanceof HTMLElement &&
                child.childNodes.length > 0 &&
                [...child.childNodes].some(
                  (text) =>
                    text.nodeType === Node.TEXT_NODE &&
                    text.textContent?.includes("v4.local."),
                )
              )
                child.style.visibility = "hidden";
        };
        new MutationObserver((records) => {
          for (const record of records) {
            hide(record.target);
            record.addedNodes.forEach(hide);
          }
        }).observe(document, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      });
      await context.route("**/*", async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const headers = await req.allHeaders();
        if (
          url.origin !== publicAdapterOrigin &&
          (url.href.includes(credential) ||
            JSON.stringify(headers).includes(credential))
        )
          credentialLeak = true;
        if (
          url.pathname.endsWith("/notice/pending.mp4") &&
          req.method() === "GET"
        )
          pendingMediaRequested = true;
        if (
          url.origin === "https://v3-cinemeta.strem.io" &&
          url.pathname === `/meta/movie/${hostedFixture.fixtureImdbId}.json`
        ) {
          return route.fulfill({
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            body: JSON.stringify({
              meta: {
                id: hostedFixture.fixtureImdbId,
                type: "movie",
                name: discoveryName,
                poster: `${media.origin}/poster.svg`,
                description:
                  "Synthetic metadata for the standard Stremio movie route.",
                behaviorHints: { defaultVideoId: hostedFixture.fixtureImdbId },
              },
            }),
          });
        }
        if (
          url.origin === "https://www.stremio.com" &&
          url.pathname === "/warning"
        ) {
          return route.fulfill({
            contentType: "text/html",
            body: `<a href="${publicAdapterOrigin}/configure">Continue to add-on setup</a>`,
          });
        }
        if (url.origin === publicAdapterOrigin) {
          if (headers.authorization) credentialLeak = true;
          const forwarded: Record<string, string> = {};
          for (const name of ["range"])
            if (headers[name]) forwarded[name] = headers[name];
          const response = await fetch(
            `${adapter.current.origin}${url.pathname}${url.search}`,
            {
              method: req.method(),
              headers: forwarded,
              body: req.postData() ?? undefined,
              redirect: "manual",
              signal: AbortSignal.timeout(10000),
            },
          );
          const contentType =
            response.headers.get("content-type") ?? "application/octet-stream";
          const body = Buffer.from(await response.arrayBuffer());
          const responseHeaders: Record<string, string> = {
            "content-type": contentType,
            "access-control-allow-origin": "*",
          };
          for (const name of [
            "location",
            "cache-control",
            "content-range",
            "accept-ranges",
            "referrer-policy",
          ])
            if (response.headers.has(name))
              responseHeaders[name] = response.headers.get(name) ?? "";
          return route.fulfill({
            status: response.status,
            headers: responseHeaders,
            body: contentType.includes("application/json")
              ? body
                  .toString("utf8")
                  .replaceAll(adapter.current.origin, publicAdapterOrigin)
              : body,
          });
        }
        return [
          web.origin,
          adapter.current.origin,
          media.origin,
          setupServer.origin,
        ].includes(url.origin)
          ? route.continue()
          : route.abort();
      });
      const page = await context.newPage();
      const playerErrors: unknown[] = [];
      page.on("console", (message) => {
        if (message.text().startsWith("Player "))
          void Promise.all(
            message
              .args()
              .map((argument) =>
                argument.evaluate((value) =>
                  JSON.parse(
                    JSON.stringify(value, (_key, entry: unknown) =>
                      entry instanceof Error
                        ? { name: entry.name, message: entry.message }
                        : entry,
                    ),
                  ),
                ),
              ),
          )
            .then((values) => playerErrors.push(values))
            .catch(() => {});
      });
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(15000);
      try {
        await page.addLocatorHandler(
          page.getByText("Don't show again", { exact: true }),
          async (prompt) => {
            await prompt.click({ timeout: 1000 }).catch(() => {});
          },
          { noWaitAfter: true },
        );
        await page.goto(web.origin);
        await page.getByText("Addons", { exact: true }).click();
        await page.getByTitle("Add addon", { exact: true }).click();
        await page
          .getByPlaceholder("Paste addon URL")
          .fill(`${publicAdapterOrigin}/manifest.json`);
        await page.getByText("Add", { exact: true }).click();
        const configure = page
          .getByText("Configure", { exact: true })
          .filter({ visible: true });
        await expect(configure).toBeVisible();
        await expect(
          page.getByText("Install", { exact: true }).filter({ visible: true }),
        ).toHaveCount(0);
        await page.screenshot({ path: `${directory}/public-addon.png` });
        const configuredPage = context.waitForEvent("page");
        await configure.click();
        const setupPage = await configuredPage;
        await expect(setupPage).toHaveURL(
          `https://www.stremio.com/warning#${encodeURIComponent(`${publicAdapterOrigin}/configure`)}`,
        );
        await setupPage
          .getByRole("link")
          .and(setupPage.locator(`a[href="${publicAdapterOrigin}/configure"]`))
          .click();
        await expect(setupPage).toHaveURL(`${publicAdapterOrigin}/configure`);
        const connectAccount = setupPage
          .getByRole("link")
          .and(setupPage.locator(`a[href="${setupServer.origin}/stremio"]`))
          .first();
        await expect(connectAccount).toBeVisible();
        await expect(connectAccount).not.toHaveAccessibleName("");
        await setupPage.setViewportSize({ width: 320, height: 640 });
        assert.equal(
          await setupPage.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
        );
        await setupPage.screenshot({
          path: `${directory}/configure-mobile.png`,
        });
        await setupPage.setViewportSize({ width: 1280, height: 720 });
        await setupPage.screenshot({
          path: `${directory}/configure-desktop.png`,
        });
        await setupPage.keyboard.press("Tab");
        await expect(connectAccount).toBeFocused();
        await setupPage.keyboard.press("Enter");
        await expect(setupPage).toHaveURL(`${setupServer.origin}/stremio`);
        assert.equal(engine.calls.transfer, 0);
        await page.goto(web.origin);
        await page.getByText("Addons", { exact: true }).click();
        await page.getByTitle("Add addon", { exact: true }).click();
        await maskAddonUrl(page);
        await page.getByPlaceholder("Paste addon URL").fill(manifestUrl);
        await page.getByText("Add", { exact: true }).click();
        const install = page
          .getByText("Install", { exact: true })
          .filter({ visible: true });
        await expect(install).toBeVisible();
        assert.equal(
          await page
            .getByText("v4.local.", { exact: false })
            .filter({ visible: true })
            .count(),
          0,
          "The installation dialog must not show the credential",
        );
        await install.click();
        await page.getByRole("link", { name: "Discover", exact: true }).click();
        const filters = page.locator('[aria-haspopup="listbox"]');
        await filters.nth(1).click();
        await page
          .getByRole("listbox")
          .getByText("put.io library", { exact: true })
          .click();
        await expect(page).toHaveURL(/\/movie\/library(?:$|\?)/);
        await openLibraryFile(
          page,
          hostedFixture.libraryName,
          hostedFixture.libraryFileId,
        );
        const libraryEvidence = await decoded(
          page,
          { ...fixture, origin: web.origin },
          "movie",
          `${directory}/library-decoded.png`,
        );
        assert.ok(
          engine.calls.playbackFiles.includes(
            String(hostedFixture.libraryFileId),
          ),
        );
        assert.equal(
          engine.calls.transfer,
          0,
          "Browsing and playing the library must not download anything",
        );
        await page.goto(
          `${web.origin}/#/detail/movie/${hostedFixture.fixtureImdbId}/${hostedFixture.fixtureImdbId}`,
        );
        await expect(
          page.getByText("Download to put.io", { exact: true }),
        ).toBeVisible();
        assert.equal(
          engine.calls.transfer,
          0,
          "Standard Stremio title streams must remain read-only",
        );
        await page.screenshot({
          path: `${directory}/standard-movie-streams.png`,
        });
        await page.goto(
          `${web.origin}/#/discover/${encodeURIComponent(manifestUrl)}/movie/discover-movies`,
        );
        const discoveryCard = page
          .getByText(discoveryName, { exact: true })
          .first();
        await expect(discoveryCard).toBeVisible();
        await discoveryCard.scrollIntoViewIfNeeded();
        await expect(discoveryCard).toBeInViewport();
        await page.waitForTimeout(800);
        await page.screenshot({
          path: `${directory}/catalog.png`,
          animations: "disabled",
        });
        await page.goto(`${web.origin}/#/search`);
        const searchInput = page.getByRole("textbox").first();
        await searchInput.fill(`${discoveryName} 2026`);
        await searchInput.press("Enter");
        const searchResult = page
          .getByText(`${discoveryName} 1080p`, { exact: true })
          .first();
        await expect(searchResult).toBeVisible();
        await searchResult.scrollIntoViewIfNeeded();
        await expect(searchResult).toBeInViewport();
        await page.waitForTimeout(800);
        await page.screenshot({
          path: `${directory}/search.png`,
          animations: "disabled",
        });
        assert.equal(
          engine.calls.transfer,
          0,
          "Search must not submit a transfer",
        );
        await searchResult.click();
        await expect(
          page.getByText("Download to put.io", { exact: true }),
        ).toBeVisible();
        await expect(
          page
            .getByText(
              "A self-generated playback demo. No real account or provider transfer.",
              { exact: false },
            )
            .first(),
        ).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator('img[src$="/poster.svg"]')
              .evaluateAll((images) =>
                images.some(
                  (image) =>
                    image instanceof HTMLImageElement &&
                    image.complete &&
                    image.naturalWidth > 0,
                ),
              ),
          )
          .toBe(true);
        await page.screenshot({
          path: `${directory}/release-context.png`,
          animations: "disabled",
        });
        assert.equal(
          engine.calls.transfer,
          0,
          "Opening a search result must not submit a transfer",
        );
        await page.goto(
          `${web.origin}/#/discover/${encodeURIComponent(manifestUrl)}/series/discover-series`,
        );
        await page
          .getByText(seriesName, { exact: true })
          .filter({ visible: true })
          .first()
          .click();
        await expect(
          page
            .getByText("A generated series synopsis.", { exact: false })
            .filter({ visible: true })
            .first(),
        ).toBeVisible();
        await page
          .getByText("A generated first episode", { exact: false })
          .filter({ visible: true })
          .first()
          .click();
        await expect(
          page.getByText("Download to put.io", { exact: true }),
        ).toBeVisible();
        await expect(
          page
            .getByText(`${seriesName} S01E01 1080p`, { exact: false })
            .first(),
        ).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator('img[src$="/poster.svg"]')
              .evaluateAll((images) =>
                images.some(
                  (image) =>
                    image instanceof HTMLImageElement &&
                    image.complete &&
                    image.naturalWidth > 0,
                ),
              ),
          )
          .toBe(true);
        assert.equal(
          engine.calls.transfer,
          0,
          "Opening a TV episode release list must not submit a transfer",
        );
        await page.screenshot({
          path: `${directory}/episode-context.png`,
          animations: "disabled",
        });
        await page.goto(`${web.origin}/#/`);
        await page.getByText(discoveryName, { exact: true }).first().click();
        const release = page.getByText("Download to put.io", { exact: true });
        await expect(release).toBeVisible();
        assert.equal(
          engine.calls.transfer,
          0,
          "Discovery must not acquire on mount",
        );
        await release.scrollIntoViewIfNeeded();
        await expect(release).toBeInViewport();
        await page.waitForTimeout(800);
        await page.screenshot({
          path: `${directory}/discovery.png`,
          animations: "disabled",
        });
        const target = `chill:movie:${Buffer.from("fixture-movie").toString("base64url")}`;
        const base = `/s/${credential}`;
        const playPath = `${base}/play/movie/${encodeURIComponent(target)}/fixture-release.m3u8`;
        const head = await fetch(`${adapter.current.origin}${playPath}`, {
          method: "HEAD",
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
        });
        assert.equal(head.status, 200);
        assert.equal(
          head.headers.get("content-type"),
          "application/vnd.apple.mpegurl",
        );
        assert.equal(
          engine.calls.transfer,
          0,
          "Media HEAD must not submit a transfer",
        );
        await release.click();
        await expect.poll(() => engine.calls.transfer).toBe(1);
        await page.waitForTimeout(2500);
        assert.equal(pendingMediaRequested, false);
        assert.equal(
          await page
            .locator("video")
            .evaluateAll((videos) =>
              videos.some(
                (video) =>
                  video instanceof HTMLVideoElement &&
                  video.getVideoPlaybackQuality().totalVideoFrames > 0,
              ),
            ),
          false,
          "A pending download must keep the player loading without a placeholder video",
        );
        await page.screenshot({ path: `${directory}/loading.png` });
        assert.equal(
          new URL(page.url()).origin,
          web.origin,
          "Download selection must stay in Stremio",
        );
        const loadingUrl = page.url();
        engine.state.completed = true;
        const automaticPlayback = await decoded(
          page,
          { ...fixture, origin: web.origin },
          "movie",
          `${directory}/automatic-decoded.png`,
        );
        assert.equal(
          page.url(),
          loadingUrl,
          "Completion must play without navigation or reselection",
        );
        assert.ok(playlistRequests.has(playPath));
        assert.equal(
          pendingMediaRequested,
          false,
          "Pending status clips must never be requested",
        );
        assert.equal(
          engine.calls.transfer,
          1,
          "Waiting must not duplicate the transfer",
        );
        const statusReplay = async (transferId: bigint) =>
          fetch(`${adapter.current.origin}${base}/status/${transferId}.m3u8`, {
            redirect: "manual",
            signal: AbortSignal.timeout(10000),
          });
        const replay = await statusReplay(1n);
        assert.equal(replay.status, 302);
        assert.equal(
          replay.headers.get("location"),
          `${media.origin}/hls/movie/master.m3u8`,
        );
        await page.goto(`${web.origin}/#/`);
        await adapter.current.close();
        const originalOrigin = adapter.current.origin;
        adapter.current = await startHostedAdapter({
          engineBaseUrl: engine.origin,
          webOrigin: setupServer.origin,
          port: Number(new URL(originalOrigin).port),
        });
        assert.equal(adapter.current.origin, originalOrigin);
        const resumed = await statusReplay(1n);
        assert.equal(resumed.status, 302);
        assert.equal(
          resumed.headers.get("location"),
          `${media.origin}/hls/movie/master.m3u8`,
        );
        assert.equal(
          engine.calls.transfer,
          1,
          "Status reads before and after restart must not submit",
        );
        await page.goto(
          `${web.origin}/#/discover/${encodeURIComponent(manifestUrl)}/movie/library`,
        );
        await openLibraryFile(page, movieName, hostedFixture.fileId);
        const evidence = await decoded(
          page,
          { ...fixture, origin: web.origin },
          "movie",
          `${directory}/decoded.png`,
        );
        const seekEvidence = await seekRenderedDestination(page, directory);
        const subtitleEvidence = await verifySubtitleControls(page, directory);
        await page.goto(
          `${web.origin}/#/discover/${encodeURIComponent(manifestUrl)}/series/discover-series`,
        );
        await page
          .getByText(seriesName, { exact: true })
          .filter({ visible: true })
          .first()
          .click();
        await page
          .getByText("A generated first episode", { exact: false })
          .filter({ visible: true })
          .first()
          .click();
        await page.getByText("Download to put.io", { exact: true }).click();
        await expect.poll(() => engine.calls.transfer).toBe(2);
        const episodeEvidence = await decoded(
          page,
          { ...fixture, origin: web.origin },
          "episode1",
          `${directory}/episode-decoded.png`,
        );
        const episodePath = `${base}/play/series/${encodeURIComponent(`chill:episode:${seriesImdbId}:1:1`)}/fixture-episode-release.m3u8`;
        assert.ok(
          playlistRequests.has(episodePath),
          "Episode must consume the selected adapter playlist URL",
        );
        assert.equal(
          episodeMediaRequested,
          true,
          "Selected episode must load the resolved fixture media",
        );
        const episodeStatus = await statusReplay(2n);
        assert.equal(episodeStatus.status, 302);
        assert.equal(
          episodeStatus.headers.get("location"),
          `${media.origin}/hls/episode1/master.m3u8`,
        );
        assert.equal(engine.calls.transfer, 2);
        assert.equal(
          credentialLeak,
          false,
          "Credential left the adapter origin",
        );
        assert.equal(
          engine.calls.rejected,
          0,
          "Generated Engine request contract failed",
        );
        const recoveryEvidence = [];
        for (const recovery of recoveryCases) {
          const before: number = engine.calls.transfer;
          await page.goto(
            `${web.origin}/#/discover/${encodeURIComponent(manifestUrl)}/movie/discover-movies`,
          );
          await page
            .getByText(recovery.name, { exact: true })
            .filter({ visible: true })
            .first()
            .click();
          const recoveryRelease = page
            .getByText("Download to put.io", { exact: true })
            .filter({ visible: true });
          const recoveryTarget = `chill:movie:${Buffer.from(`fixture-${recovery.kind}`).toString("base64url")}`;
          const previewShow = page
            .getByRole("link")
            .and(
              page.locator(
                `a[href^="#/detail/"][href*="${encodeURIComponent(recoveryTarget)}"]`,
              ),
            )
            .filter({ visible: true })
            .last();
          await expect(previewShow.or(recoveryRelease).first()).toBeVisible();
          if (await previewShow.isVisible())
            await previewShow.click({ timeout: 1000 }).catch(async () => {
              await expect(recoveryRelease).toBeVisible();
            });
          await expect(recoveryRelease).toBeVisible();
          const recoveryPath: string = `${base}/play/movie/${encodeURIComponent(recoveryTarget)}/fixture-${recovery.kind}-release.m3u8`;
          for (const method of ["HEAD", "OPTIONS"]) {
            const probe: Response = await fetch(
              `${adapter.current.origin}${recoveryPath}`,
              {
                method,
                redirect: "manual",
                signal: AbortSignal.timeout(10000),
              },
            );
            assert.ok(probe.ok, `${method} failed for ${recovery.kind}`);
          }
          assert.equal(
            engine.calls.transfer,
            before,
            "Recovery browse, metadata, streams, HEAD and OPTIONS must remain read-only",
          );
          await recoveryRelease.click();
          await expect.poll(() => engine.calls.transfer).toBe(before + 1);
          await expect(
            page
              .getByText(
                /Video is not supported|Failed to fetch|error occurred|Could not play/i,
              )
              .filter({ visible: true })
              .first(),
          ).toBeVisible({ timeout: 15000 });
          assert.equal(
            noticeRequests.size,
            0,
            "HLS errors must never play status videos",
          );
          await page.screenshot({
            path: `${directory}/${recovery.kind}-error.png`,
          });
          if (recovery.kind !== "unknown") {
            const replay = await statusReplay(recovery.transferId);
            assert.equal(replay.status, 409);
            assert.deepEqual(await replay.json(), { error: recovery.kind });
          }
          assert.equal(
            engine.calls.transfer,
            before + 1,
            "Status reads must not duplicate a transfer",
          );
          recoveryEvidence.push({
            state: recovery.kind,
            playerErrorRendered: true,
            statusVideoRequested: false,
            statusReadOnly: true,
            readOnlyProbes: ["HEAD", "OPTIONS"],
          });
        }
        await page.goto(
          `${web.origin}/#/discover/${encodeURIComponent(manifestUrl)}/movie/library`,
        );
        await expect(
          page.getByText(multipleMovieName, { exact: true }).first(),
        ).toBeVisible();
        await openLibraryFile(
          page,
          multipleEpisodeName,
          hostedFixture.multipleEpisodeId,
        );
        const selectedFileEvidence = await decoded(
          page,
          { ...fixture, origin: web.origin },
          "episode1",
          `${directory}/multiple-file-decoded.png`,
        );
        assert.ok(playlistRequests.has("/hls/episode1/master.m3u8"));
        assert.equal(
          engine.calls.transfer,
          5,
          "Choosing a file from the library must not submit",
        );
        await page.goto(`${web.origin}/#/`);
        engine.state.credentialRejected = true;
        await page.goto(
          `${web.origin}/#/discover/${encodeURIComponent(manifestUrl)}/movie/library`,
        );
        await expect(
          page.getByText("Reconnect chill.institute", { exact: true }).first(),
        ).toBeVisible();
        await page.screenshot({
          path: `${directory}/reconnect-catalog.png`,
          animations: "disabled",
        });
        await page.goto(
          `${web.origin}/#/detail/movie/${hostedFixture.fixtureImdbId}/${hostedFixture.fixtureImdbId}`,
        );
        await expect(
          page
            .getByText(`Reconnect at ${setupServer.origin}/stremio`, {
              exact: false,
            })
            .first(),
        ).toBeVisible();
        await page.screenshot({
          path: `${directory}/reconnect-source.png`,
          animations: "disabled",
        });
        const rejectedPlay = await fetch(
          `${adapter.current.origin}${playPath}`,
          {
            redirect: "manual",
            signal: AbortSignal.timeout(10000),
          },
        );
        assert.equal(rejectedPlay.status, 409);
        assert.deepEqual(await rejectedPlay.json(), { error: "reconnect" });
        assert.ok(engine.calls.unauthenticated > 0);
        assert.equal(engine.calls.transfer, 5);
        assert.equal(
          engine.calls.rejected,
          0,
          "Recovery Engine request contract failed",
        );
        assert.equal(
          credentialLeak,
          false,
          "Recovery leaked the generated credential",
        );
        runs.push({
          run,
          status: "passed",
          evidence: {
            publicManifestConfigurationRequired: true,
            publicConfigureOpenedSetup: true,
            externalLinkWarning: "generated-page-with-verified-destination",
            libraryNestedDecoded: libraryEvidence,
            libraryReadOnly: true,
            decoded: evidence,
            episodeDecoded: episodeEvidence,
            recovery: recoveryEvidence,
            multipleFileDecoded: selectedFileEvidence,
            seek: seekEvidence,
            subtitles: subtitleEvidence,
            standardMovieStreamsVisible: true,
            standardMovieMetadata: "generated-cinemeta-response",
            discoveryReadOnly: true,
            searchReadOnly: true,
            searchResultsVisible: true,
            searchResultOpened: true,
            releaseArtworkDecoded: true,
            episodeReleaseContext: true,
            explicitAcquisition: true,
            mediaHeadReadOnly: true,
            pendingPlayerLoading: true,
            pendingNoticeRequested: false,
            automaticPlayback,
            statusReadAcrossRestart: true,
            stayedInStremio: true,
            exactlyOneTransferPerSelection: true,
            completedDownloadInLibrary: true,
            rejectedCredentialReconnect: true,
            credentialConfinedToAdapter: true,
            hlsPlaylistsRequested: [...playlistRequests].filter((path) =>
              path.startsWith("/hls/"),
            ),
            fakeOnlyVideo: true,
          },
        });
      } catch (error) {
        runs.push({
          run,
          status: "failed",
          evidence: {
            playerErrors,
            playlistRequests: [...playlistRequests].map(redactCredentials),
            videoErrors: await page
              .locator("video")
              .evaluateAll((videos) =>
                videos.map((video) =>
                  video instanceof HTMLVideoElement
                    ? { code: video.error?.code, message: video.error?.message }
                    : {},
                ),
              )
              .catch(() => []),
          },
          error: safeError(
            `${String(error)}; navigation failures: ${navigationFailures.join(", ")}`,
          ),
        });
        await page
          .screenshot({ path: `${directory}/failure.png` })
          .catch(() => {});
        await writeFile(
          `${directory}/page.txt`,
          safeError(
            await page
              .locator("body")
              .innerText()
              .catch(() => "Page unavailable"),
          ),
        );
        throw error;
      } finally {
        signal.removeEventListener("abort", abort);
        const recording = page.video();
        await context.close();
        if (recording) videos.push(await recording.path());
      }
    }).pipe(Effect.timeout("5 minutes"));
  }
}).pipe(
  Effect.scoped,
  Effect.timeout("8 minutes"),
  Effect.catch((error) =>
    Effect.sync(() => {
      failure = safeError(error);
      process.exitCode = 1;
    }),
  ),
  Effect.ensuring(
    Effect.promise(async () => {
      const closed = await Promise.all(endpoints.map(listenerClosed));
      const servicesClosed = endpoints.length === 6 && closed.every(Boolean);
      const passed =
        !failure &&
        cleanupErrors.length === 0 &&
        servicesClosed &&
        browserClosed &&
        runs.length === 1 &&
        runs.every((run) => run.status === "passed");
      if (!passed) process.exitCode = 1;
      await mkdir(directory, { recursive: true });
      const receipt = redactCredentials(
        JSON.stringify(
          {
            status: passed ? "passed" : "failed",
            versions,
            error: failure,
            credentials: "generated-fake-only",
            live: "not-run",
            engine: "local-generated-RPC-fixture",
            servicesClosed,
            browserClosed,
            videos,
            cleanupErrors,
            calls,
            runs,
          },
          null,
          2,
        ),
      );
      assert.ok(!receipt.includes(credential));
      await writeFile(`${directory}/results.json`, receipt);
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
