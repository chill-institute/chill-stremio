import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { chromium, expect } from "@playwright/test";
import { Effect, Schema } from "effect";
import {
  inspectFrame,
  type FrameEvidence,
} from "../native/desktop-evidence.ts";
import { movieAdvances } from "../native/desktop-contract.ts";
import { versions } from "../versions.ts";
import { startWeb } from "../web.ts";
import { proveDecoded } from "./adapter.ts";

const Streams = Schema.Struct({
  streams: Schema.Array(Schema.Struct({ url: Schema.String })),
});

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
    let webOrigin: string | undefined;
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (webOrigin)
          input.cleanup.webClosed = await listenerClosed(webOrigin);
      }),
    );
    const web = yield* startWeb;
    webOrigin = web.origin;
    const browser = yield* Effect.acquireRelease(
      Effect.tryPromise(() => chromium.launch({ headless: true })),
      (browser) =>
        Effect.tryPromise(async () => {
          await browser.close();
          input.cleanup.browserClosed = !browser.isConnected();
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
          input.cleanup.contextClosed = true;
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchCause(() => Effect.void),
        ),
    );
    const adapterOrigin = new URL(input.manifestUrl).origin;
    const allowedOrigins = new Set([
      web.origin,
      adapterOrigin,
      ...input.mediaUrls.map((url) => new URL(url).origin),
    ]);
    return yield* Effect.tryPromise(async (signal) => {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      page.setDefaultNavigationTimeout(20_000);
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
        } else if (allowedOrigins.has(new URL(request.url()).origin))
          await route.continue();
        else await route.abort();
      });
      const abort = () => {
        void page.close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await page.addLocatorHandler(
          page.getByText("Don't show again", { exact: true }),
          async (prompt) => {
            await prompt.click({ timeout: 1000 }).catch(() => {});
          },
          { noWaitAfter: true },
        );
        input.onStage("installation");
        await page.goto(`${web.origin}/#/addons`);
        await page.getByTitle("Add addon", { exact: true }).click();
        await page.getByPlaceholder("Paste addon URL").fill(input.manifestUrl);
        await page.getByText("Add", { exact: true }).click();
        await page
          .getByText("Install", { exact: true })
          .filter({ visible: true })
          .click();
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
