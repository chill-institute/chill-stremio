import { mkdir, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { chromium } from "@playwright/test";
import { startFixture } from "./fixture.ts";
import { startWeb } from "./web.ts";
import { verifyProtocol } from "./protocol.ts";
import { exerciseBrowser, redact, type Scenario } from "./browser.ts";
import { versions } from "./versions.ts";
import { validateProvenance, type Provenance } from "./provenance.ts";

const root = `artifacts/${new Date().toISOString().replaceAll(":", "-")}`;
interface RunResult {
  run: number;
  status: string;
  scenarios: Scenario[];
  browser?: string;
  error?: string;
  cleanupErrors?: string[];
  servicesClosed?: boolean;
  browserClosed?: boolean;
}
const runs: RunResult[] = [];
const endpoints = new Map<number, string[]>();
let provenance: Provenance | undefined;
let failure: string | undefined;
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
const oneRun = Effect.fn("harness.freshRun")(
  function* (run: number) {
    const directory = `${root}/run-${run}`;
    yield* Effect.promise(() => mkdir(directory, { recursive: true }));
    const result: RunResult = { run, status: "running", scenarios: [] };
    runs.push(result);
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        if (result.status === "running") {
          result.status = "failed";
          result.error = "Run interrupted or resource acquisition failed";
        }
        const closed = await Promise.all(
          (endpoints.get(run) ?? []).map(listenerClosed),
        );
        result.servicesClosed = closed.length === 2 && closed.every(Boolean);
        if (!result.servicesClosed) {
          result.status = "failed";
          (result.cleanupErrors ??= []).push(
            "Fixture or Web service cleanup did not verify",
          );
        }
        await writeFile(
          `${directory}/result.json`,
          JSON.stringify(result, null, 2),
        );
      }),
    );
    const fixture = yield* startFixture();
    endpoints.set(run, [fixture.origin]);
    const web = yield* startWeb;
    endpoints.get(run)?.push(web.origin);
    const browser = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        chromium.launch({
          channel: "chromium",
          headless: true,
          timeout: 20000,
        }),
      ),
      (b) =>
        Effect.tryPromise(async () => {
          await b.close();
          result.browserClosed = !b.isConnected();
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.catch(() =>
            Effect.sync(() => {
              result.browserClosed = false;
              result.status = "failed";
              (result.cleanupErrors ??= []).push(
                "Browser cleanup failed or exceeded its deadline",
              );
            }),
          ),
        ),
    );
    result.browser = browser.version();
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
      if (signal.aborted) abort();
      const allowed = new Set([web.origin, fixture.origin]);
      await context.route("**/*", (route) =>
        allowed.has(new URL(route.request().url()).origin)
          ? route.continue()
          : route.abort(),
      );
      await context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: false,
      });
      const page = await context.newPage();
      try {
        result.scenarios.push(...(await verifyProtocol(fixture)));
        fixture.reset();
        await exerciseBrowser(
          page,
          web.origin,
          fixture,
          directory,
          result.scenarios,
        );
        signal.throwIfAborted();
        result.status = "passed";
        await context.tracing.stop();
      } catch (error) {
        result.status = "failed";
        result.error ??= redact(String(error));
        await page
          .screenshot({ path: `${directory}/failure.png`, timeout: 5000 })
          .catch(() => {});
        await writeFile(
          `${directory}/page.txt`,
          redact(
            await page
              .locator("body")
              .innerText()
              .catch(() => "Page unavailable"),
          ),
        );
        await context.tracing
          .stop({ path: `${directory}/trace.zip` })
          .catch(() => {});
      } finally {
        signal.removeEventListener("abort", abort);
        await writeFile(
          `${directory}/metrics.json`,
          JSON.stringify(fixture.metrics, null, 2),
        );
        await context.close();
      }
    });
  },
  Effect.scoped,
  Effect.timeout("5 minutes"),
);

const program = Effect.gen(function* () {
  yield* Effect.promise(() => mkdir(root, { recursive: true }));
  provenance = yield* validateProvenance();
  for (const run of [1, 2]) {
    yield* oneRun(run).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          const result = runs.find((r) => r.run === run);
          if (result) {
            result.status = "failed";
            result.error ??= redact(String(error));
          } else
            runs.push({
              run,
              status: "failed",
              scenarios: [],
              error: redact(String(error)),
            });
        }),
      ),
    );
    console.log(JSON.stringify({ run, status: runs.at(-1)?.status }));
  }
  const passed =
    runs.length === 2 && runs.every((run) => run.status === "passed");
  if (!passed) process.exitCode = 1;
}).pipe(
  Effect.timeout("11 minutes"),
  Effect.catch((error) =>
    Effect.sync(() => {
      failure = redact(String(error));
      process.exitCode = 1;
    }),
  ),
  Effect.ensuring(
    Effect.promise(async () => {
      const passed =
        !failure &&
        runs.length === 2 &&
        runs.every((run) => run.status === "passed");
      if (!passed) process.exitCode = 1;
      await mkdir(root, { recursive: true });
      await writeFile(
        `${root}/results.json`,
        JSON.stringify(
          {
            status: passed ? "passed" : "failed",
            error: failure,
            versions,
            provenance,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            remainingResourceTypes: process.getActiveResourcesInfo(),
            credentials: false,
            native: "not-run",
            live: "not-run",
            runs,
          },
          null,
          2,
        ),
      );
      console.log(
        JSON.stringify({
          status: passed ? "passed" : "failed",
          results: `${root}/results.json`,
        }),
      );
    }),
  ),
  Effect.provide(NodeServices.layer),
);
NodeRuntime.runMain(program);
