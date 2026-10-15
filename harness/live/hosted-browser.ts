import assert from "node:assert/strict";
import { createConnection } from "node:net";
import {
  chromium,
  expect,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { Effect, Schema } from "effect";
import { decoded as fixtureDecoded } from "../browser.ts";
import {
  inspectFrame,
  type FrameEvidence,
} from "../native/desktop-evidence.ts";
import { movieAdvances } from "../native/desktop-contract.ts";
import { versions } from "../versions.ts";
import { startWeb } from "../web.ts";
import {
  AcquireWebNotice,
  type AcquireWebInput,
  type AcquireWebProof,
} from "./acquire.ts";
import { proveDecoded } from "./adapter.ts";
import {
  pollListing,
  type OwnedWebCleanup,
  type OwnedWebInput,
  type OwnedWebProof,
} from "./owned.ts";

const Streams = Schema.Struct({
  streams: Schema.Array(Schema.Struct({ url: Schema.String })),
});
const NamedStreams = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      url: Schema.optional(Schema.String),
    }),
  ),
});
const cinemetaOrigin = "https://v3-cinemeta.strem.io";

// put.io redirects media requests to its CDN hosts.
const isPutioMediaHost = (url: URL) =>
  url.protocol === "https:" && url.hostname.endsWith(".put.io");

export interface HostedBrowserCleanup {
  browserClosed: boolean;
  contextClosed: boolean;
  webClosed: boolean;
  engineBearerAbsent: boolean;
}

const listenerClosed = (origin: string) =>
  new Promise<boolean>((resolve) => {
    const url = new URL(origin);
    const socket = createConnection({
      host: url.hostname,
      port: Number(url.port),
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

/** The pinned Web client and a fresh Chromium context; cleanup records each close. */
const openGuestWeb = Effect.fn("live.hosted.openGuestWeb")(function* (
  cleanup: OwnedWebCleanup,
) {
  let webOrigin: string | undefined;
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      if (webOrigin) cleanup.webClosed = await listenerClosed(webOrigin);
    }),
  );
  const web = yield* startWeb;
  webOrigin = web.origin;
  const browser = yield* Effect.acquireRelease(
    Effect.tryPromise(() => chromium.launch({ headless: true })),
    (browser) =>
      Effect.tryPromise(async () => {
        await browser.close();
        cleanup.browserClosed = !browser.isConnected();
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.catchCause(() => Effect.void),
      ),
  );
  const context = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        serviceWorkers: "block",
      }),
    ),
    (context) =>
      Effect.tryPromise(async () => {
        await context.close();
        cleanup.contextClosed = true;
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.catchCause(() => Effect.void),
      ),
  );
  return { web, browser, context };
});

async function guestPage(context: BrowserContext) {
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.setDefaultNavigationTimeout(20_000);
  await page.addLocatorHandler(
    page.getByText("Don't show again", { exact: true }),
    async (prompt) => {
      await prompt.click({ timeout: 1000 }).catch(() => {});
    },
    { noWaitAfter: true },
  );
  return page;
}

/** Installs an add-on as a guest through the Add addon dialog. */
async function installAddon(
  page: Page,
  webOrigin: string,
  manifestUrl: string,
) {
  await page.goto(`${webOrigin}/#/addons`);
  await page.getByTitle("Add addon", { exact: true }).click();
  await page.getByPlaceholder("Paste addon URL").fill(manifestUrl);
  await page.getByText("Add", { exact: true }).click();
  await page
    .getByText("Install", { exact: true })
    .filter({ visible: true })
    .click();
}

export const proveHostedBrowserPlayback = Effect.fn("live.hosted.browser")(
  function* (input: {
    manifestUrl: string;
    stremioId: string;
    streamPath: string;
    mediaUrls: readonly string[];
    token: string;
    cleanup: HostedBrowserCleanup;
    onStage: (
      stage:
        | "installation"
        | "stream-listing"
        | "decoded"
        | "controls-hidden"
        | "intact-frames",
    ) => void;
    onDecoded: (decoded: Awaited<ReturnType<typeof proveDecoded>>) => void;
    onFrames: (frames: readonly FrameEvidence[]) => void;
  }) {
    const { web, browser, context } = yield* openGuestWeb(input.cleanup);
    const adapterOrigin = new URL(input.manifestUrl).origin;
    const allowedOrigins = new Set([
      web.origin,
      adapterOrigin,
      ...input.mediaUrls.map((url) => new URL(url).origin),
    ]);
    return yield* Effect.tryPromise(async (signal) => {
      const page = await guestPage(context);
      await context.route("**/*", async (route) => {
        const request = route.request();
        const headers = await request.allHeaders();
        if (
          request.url().includes(input.token) ||
          JSON.stringify(headers).includes(input.token) ||
          headers.authorization
        ) {
          input.cleanup.engineBearerAbsent = false;
          await route.abort();
        } else if (
          allowedOrigins.has(new URL(request.url()).origin) ||
          isPutioMediaHost(new URL(request.url()))
        )
          await route.continue();
        else await route.abort();
      });
      const abort = () => {
        void page.close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        input.onStage("installation");
        await installAddon(page, web.origin, input.manifestUrl);
        input.onStage("stream-listing");
        const [response] = await Promise.all([
          page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.origin === adapterOrigin &&
              url.pathname === input.streamPath &&
              response.request().method() === "GET"
            );
          }),
          page.goto(
            `${web.origin}/#/detail/movie/${encodeURIComponent(input.stremioId)}/${encodeURIComponent(input.stremioId)}`,
          ),
        ]);
        const streams = Schema.decodeUnknownSync(Streams)(
          await response.json(),
        );
        assert.equal(streams.streams.length, 1);
        const expectedSources = streams.streams.map(({ url }) => {
          assert.equal(new URL(url).protocol, "https:");
          allowedOrigins.add(new URL(url).origin);
          return url;
        });
        await page
          .getByText("chill.institute", { exact: true })
          .filter({ visible: true })
          .last()
          .click();
        const video = page.locator("video");
        await video.hover();
        input.onStage("decoded");
        const decoded = await proveDecoded(page, expectedSources);
        input.onDecoded(decoded);
        assert.ok(decoded.second.audioBytes > decoded.first.audioBytes);
        input.onStage("controls-hidden");
        await expect(page.locator('[class*="control-bar-layer"]')).toHaveCSS(
          "opacity",
          "0",
        );
        input.onStage("intact-frames");
        const first = await inspectFrame(
          await video.screenshot({ timeout: 5000 }),
        );
        input.onFrames([first]);
        const started = performance.now();
        await page.waitForTimeout(2000);
        const second = await inspectFrame(
          await video.screenshot({ timeout: 5000 }),
        );
        input.onFrames([first, second]);
        assert.ok(movieAdvances(first, second, performance.now() - started));
        assert.equal(input.cleanup.engineBearerAbsent, true);
        return {
          client: versions.web,
          browser: browser.version(),
          installation: "fresh-guest-ui",
          accountAddonMutation: false,
          decoded,
          intactFrames: [first, second],
          topology: "same-devbox-loopback-adapter-direct-provider-https",
        };
      } finally {
        signal.removeEventListener("abort", abort);
      }
    });
  },
  Effect.timeout("2 minutes"),
  Effect.scoped,
);

/**
 * Plays an owned movie's Play from put.io row in the pinned Web client as a
 * fresh guest. The lane plays only the generated fixture, so its size, marker
 * and identity colour are checked too. Nothing is captured to disk.
 */
export const proveOwnedWebPlayback = Effect.fn("live.owned.web")(
  function* (input: OwnedWebInput) {
    const { web, browser, context } = yield* openGuestWeb(input.cleanup);
    const adapterOrigin = new URL(input.manifestUrl).origin;
    const observed = { selections: 0, playlists: 0, segments: 0 };
    let confined = true;
    const page = yield* Effect.tryPromise(async () => {
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const headers = await request.allHeaders();
        // Only the adapter may see the credential; nothing sends Authorization.
        if (
          headers.authorization ||
          (url.origin !== adapterOrigin &&
            (request.url().includes(input.credential) ||
              JSON.stringify(headers).includes(input.credential)))
        ) {
          confined = false;
          await route.abort();
        } else if (
          [web.origin, adapterOrigin, cinemetaOrigin].includes(url.origin) ||
          isPutioMediaHost(url)
        )
          await route.continue();
        else await route.abort();
      });
      context.on("request", (request) => {
        if (request.method() === "GET" && request.url() === input.selectedUrl)
          observed.selections++;
      });
      context.on("response", (response) => {
        const url = new URL(response.url());
        if (
          response.request().method() !== "GET" ||
          !isPutioMediaHost(url) ||
          ![200, 206].includes(response.status())
        )
          return;
        if (url.pathname.endsWith(".m3u8")) observed.playlists++;
        else observed.segments++;
      });
      return guestPage(context);
    });
    input.onStage("installation");
    yield* Effect.tryPromise(() =>
      installAddon(page, web.origin, input.manifestUrl),
    );

    input.onStage("stream-listing");
    const detail = `${web.origin}/#/detail/movie/${encodeURIComponent(input.stremioId)}/${encodeURIComponent(input.stremioId)}`;
    let streamListings = 0;
    const listed = yield* pollListing(input.listing, (poll) =>
      Effect.tryPromise(async () => {
        streamListings = poll;
        const [response] = await Promise.all([
          page.waitForResponse(
            (response) => {
              const url = new URL(response.url());
              return (
                url.origin === adapterOrigin &&
                url.pathname === input.streamPath &&
                response.request().method() === "GET"
              );
            },
            { timeout: 30_000 },
          ),
          poll === 1 ? page.goto(detail) : page.reload(),
        ]);
        if (response.status() !== 200) return undefined;
        const rows = Schema.decodeUnknownSync(NamedStreams)(
          await response.json(),
        ).streams.filter((row) => row.name === "Play from put.io");
        return rows.length === 1 && rows[0]?.url === input.selectedUrl
          ? true
          : undefined;
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );
    assert.equal(listed, true);

    return yield* Effect.tryPromise(async () => {
      input.onStage("selection");
      const row = page
        .getByText("Play from put.io", { exact: true })
        .filter({ visible: true });
      await expect(row).toHaveCount(1);
      await row.click();
      input.onStage("playback");
      const video = page.locator("video");
      const sample = () =>
        video.evaluate((element: HTMLVideoElement) => ({
          time: element.currentTime,
          frames: element.getVideoPlaybackQuality().totalVideoFrames,
        }));
      await expect
        .poll(
          () =>
            video
              .evaluate((element: HTMLVideoElement) => element.readyState)
              .catch(() => 0),
          { timeout: 60_000 },
        )
        .toBeGreaterThanOrEqual(2);
      const first = await sample();
      await expect
        .poll(async () => (await sample()).time, { timeout: 15_000 })
        .toBeGreaterThan(first.time + 1);
      const second = await sample();
      assert.ok(second.frames > first.frames);
      await expect
        .poll(() => observed.playlists > 0 && observed.segments > 0)
        .toBe(true);
      input.onStage("fixture-frames");
      const frames = await fixtureDecoded(
        page,
        { origin: web.origin },
        "movie",
      );
      assert.ok(observed.selections > 0);
      assert.equal(confined, true);
      return {
        client: versions.web,
        browser: browser.version(),
        streamListings,
        selections: observed.selections,
        playlistResponses: observed.playlists,
        segmentResponses: observed.segments,
        currentTime: [first.time, second.time],
        decodedFrames: [first.frames, second.frames],
        fixture: {
          width: frames.second.width,
          height: frames.second.height,
          markers: [frames.first.marker, frames.second.marker],
        },
      } satisfies OwnedWebProof;
    });
  },
  Effect.timeout("8 minutes"),
  Effect.scoped,
);

/** Compares a request path with a decoded path, as Stremio may escape `:`. */
const samePath = (url: URL, path: string) => {
  try {
    return decodeURIComponent(url.pathname) === path;
  } catch {
    return false;
  }
};

/**
 * Selects the pinned release row in the pinned Web client as a fresh guest and
 * lets the page follow the adapter's redirects, retries and pending clips,
 * selecting the same row again after each pending clip. The context refuses
 * any other media URL on the adapter, so no other row can submit. Nothing is
 * captured to disk.
 */
export const proveAcquiredWebPlayback = Effect.fn("live.acquire.web")(
  function* (input: AcquireWebInput) {
    const { web, browser, context } = yield* openGuestWeb(input.cleanup);
    const manifest = new URL(input.manifestUrl);
    const adapterOrigin = manifest.origin;
    const personal = manifest.pathname.replace(/manifest\.json$/, "");
    const selected = new URL(input.selectedUrl);
    const observed = {
      selections: 0,
      otherSelections: 0,
      statusRequests: 0,
      pendingNotices: 0,
      notice: undefined as string | undefined,
      mediaAt: undefined as number | undefined,
      playlists: 0,
      segments: 0,
      files: new Set<number>(),
    };
    let confined = true;
    const page = yield* Effect.tryPromise(async () => {
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const headers = await request.allHeaders();
        // Only the adapter may see the credential; nothing sends Authorization.
        if (
          headers.authorization ||
          (url.origin !== adapterOrigin &&
            (request.url().includes(input.credential) ||
              JSON.stringify(headers).includes(input.credential)))
        ) {
          confined = false;
          await route.abort();
        } else if (
          url.origin === adapterOrigin &&
          url.pathname.startsWith(`${personal}play/`) &&
          !(
            url.pathname === selected.pathname &&
            /^(?:\?wait=[0-9]{1,2})?$/.test(url.search)
          )
        ) {
          // Another row's media URL never reaches the adapter.
          observed.otherSelections++;
          await route.abort();
        } else if (
          [web.origin, adapterOrigin, cinemetaOrigin].includes(url.origin) ||
          isPutioMediaHost(url)
        )
          await route.continue();
        else await route.abort();
      });
      context.on("request", (request) => {
        const url = new URL(request.url());
        if (isPutioMediaHost(url)) {
          if (observed.mediaAt === undefined) {
            observed.mediaAt = performance.now();
            input.onMedia();
          }
          // The API's playlist URL names the file; CDN segment URLs do not.
          const file = /^\/v2\/files\/([1-9][0-9]{0,15})\//.exec(
            url.pathname,
          )?.[1];
          if (file) observed.files.add(Number(file));
          return;
        }
        if (request.method() !== "GET" || url.origin !== adapterOrigin) return;
        if (request.url() === input.selectedUrl) observed.selections++;
        else if (url.pathname.startsWith(`${personal}status/`))
          observed.statusRequests++;
        else if (url.pathname.startsWith(`${personal}notice/`)) {
          const notice = /^([a-z-]{1,32})\.m3u8$/.exec(
            url.pathname.slice(`${personal}notice/`.length),
          )?.[1];
          if (notice === "pending") observed.pendingNotices++;
          else if (notice) observed.notice ??= notice;
        }
      });
      context.on("response", (response) => {
        const url = new URL(response.url());
        if (
          response.request().method() !== "GET" ||
          !isPutioMediaHost(url) ||
          ![200, 206].includes(response.status())
        )
          return;
        if (url.pathname.endsWith(".m3u8")) observed.playlists++;
        else observed.segments++;
      });
      return guestPage(context);
    });
    input.onStage("installation");
    yield* Effect.tryPromise(() =>
      installAddon(page, web.origin, input.manifestUrl),
    );

    input.onStage("stream-listing");
    const detail = `${web.origin}/#/detail/${input.detail.type}/${encodeURIComponent(input.detail.id)}/${encodeURIComponent(input.detail.videoId)}`;
    let streamListings = 0;
    // The pinned row's place among the rows with its name, as Stremio lists them.
    const listed = yield* pollListing(input.listing, (poll) =>
      Effect.tryPromise(async () => {
        streamListings = poll;
        const [response] = await Promise.all([
          page.waitForResponse(
            (response) => {
              const url = new URL(response.url());
              return (
                url.origin === adapterOrigin &&
                samePath(url, input.streamPath) &&
                response.request().method() === "GET"
              );
            },
            { timeout: 30_000 },
          ),
          poll === 1 ? page.goto(detail) : page.reload(),
        ]);
        if (response.status() !== 200) return undefined;
        const rows = Schema.decodeUnknownSync(NamedStreams)(
          await response.json(),
        ).streams.filter((row) => row.name === input.rowName);
        const pinned = rows.flatMap((row, index) =>
          row.url === input.selectedUrl ? [index] : [],
        );
        const [index] = pinned;
        return pinned.length === 1 && index !== undefined
          ? { index, count: rows.length }
          : undefined;
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );
    if (!listed)
      return yield* Effect.fail(new Error("The pinned row was not listed"));

    yield* input.beforeSelection;
    return yield* Effect.tryPromise({
      try: async (signal) => {
        input.onStage("selection");
        const rows = page
          .getByText(input.rowName, { exact: true })
          .filter({ visible: true });
        let rowSelections = 0;
        const select = async () => {
          await expect(rows).toHaveCount(listed.count, { timeout: 30_000 });
          await rows.nth(listed.index).click();
          rowSelections++;
        };
        await select();
        const selectedAt = performance.now();
        input.onStage("acquisition");
        let pendingSeen = 0;
        while (observed.mediaAt === undefined) {
          signal.throwIfAborted();
          if (observed.otherSelections > 0) {
            input.onStage("other-selection");
            throw new Error("Another media URL was requested");
          }
          if (observed.notice !== undefined)
            throw new AcquireWebNotice({ notice: observed.notice });
          if (observed.pendingNotices > pendingSeen) {
            pendingSeen = observed.pendingNotices;
            // The same row rejoins the download once the clip leaves the
            // player; the pinned title's page is opened again in case Stremio
            // moved on to another video.
            input.onStage("reselection");
            await expect(page).not.toHaveURL(/#\/player\//, {
              timeout: 60_000,
            });
            if (page.url() !== detail) await page.goto(detail);
            await select();
            input.onStage("acquisition");
          }
          await page.waitForTimeout(1000);
        }
        input.onStage("playback");
        const video = page.locator("video");
        const sample = () =>
          video.evaluate((element: HTMLVideoElement) => ({
            time: element.currentTime,
            frames: element.getVideoPlaybackQuality().totalVideoFrames,
          }));
        await expect
          .poll(
            () =>
              video
                .evaluate((element: HTMLVideoElement) => element.readyState)
                .catch(() => 0),
            { timeout: 120_000 },
          )
          .toBeGreaterThanOrEqual(2);
        const first = await sample();
        await expect
          .poll(async () => (await sample()).time, { timeout: 15_000 })
          .toBeGreaterThan(first.time + 1);
        const second = await sample();
        assert.ok(second.frames > first.frames);
        await expect
          .poll(() => observed.playlists > 0 && observed.segments > 0)
          .toBe(true);
        assert.equal(observed.otherSelections, 0);
        assert.equal(confined, true);
        return {
          client: versions.web,
          browser: browser.version(),
          streamListings,
          rowSelections,
          selections: observed.selections,
          otherSelections: observed.otherSelections,
          statusRequests: observed.statusRequests,
          pendingNotices: observed.pendingNotices,
          playlistResponses: observed.playlists,
          segmentResponses: observed.segments,
          playedFiles: [...observed.files],
          currentTime: [first.time, second.time],
          decodedFrames: [first.frames, second.frames],
          selectionToMediaMs: observed.mediaAt - selectedAt,
        } satisfies AcquireWebProof;
      },
      // A terminal notice keeps its type; the lane maps it to a stage.
      catch: (error) => error,
    });
  },
  Effect.scoped,
);
