import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, request, type Server } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import {
  AudioCodec,
  Container,
  GetFolderRequestSchema,
  GetFolderResponseSchema,
  ResolvePlaybackRequestSchema,
  ResolvePlaybackResponseSchema,
  VideoCodec,
} from "@chill-institute/contracts/chill/v4/api_pb";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { chromium, expect } from "@playwright/test";
import { Effect } from "effect";
import { engineLayer } from "../src/engine.ts";
import { startAdapter } from "../src/server.ts";
import { decoded, redact } from "./browser.ts";
import { startFixture } from "./fixture.ts";
import { validateProvenance } from "./provenance.ts";
import { versions } from "./versions.ts";
import { startWeb } from "./web.ts";

const directory = `artifacts/adapter-${new Date().toISOString().replaceAll(":", "-")}`;
const token = randomBytes(32).toString("hex");
const fileId = 9223372036854775807n;
const movieName = "Adapter Fixture Movie";
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
let pending = false;
const calls = { folder: 0, playback: 0, rejected: 0 };
const safeError = (error: unknown) =>
  redact(String(error)).replaceAll(token, "[fake-token]");

async function listen(server: Server, protocol = "http") {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `${protocol}://127.0.0.1:${address.port}`;
  endpoints.push(origin);
  return origin;
}
async function close(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
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

const program = Effect.gen(function* () {
  yield* Effect.promise(() => mkdir(directory, { recursive: true }));
  yield* validateProvenance();
  const fixture = yield* startFixture();
  endpoints.push(fixture.origin);
  const web = yield* startWeb;
  endpoints.push(web.origin);
  yield* Effect.promise(() => mkdir(".cache", { recursive: true }));
  const certificates = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp(".cache/adapter-tls-")),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  yield* Effect.tryPromise(() =>
    promisify(execFile)(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1",
        "-keyout",
        `${certificates}/key.pem`,
        "-out",
        `${certificates}/cert.pem`,
      ],
      { timeout: 15000 },
    ),
  );
  const key = yield* Effect.tryPromise(() =>
    readFile(`${certificates}/key.pem`),
  );
  const cert = yield* Effect.tryPromise(() =>
    readFile(`${certificates}/cert.pem`),
  );
  const media = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const server = createTlsServer({ key, cert }, (req, res) => {
        if (
          !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "") ||
          new URL(req.url ?? "/", fixture.origin).pathname !==
            "/media/movie.mp4"
        ) {
          res.writeHead(404).end();
          return;
        }
        const upstream = request(
          `${fixture.origin}/media/movie.mp4`,
          {
            method: req.method,
            headers: req.headers.range ? { range: req.headers.range } : {},
            timeout: 10000,
          },
          (response) => {
            res.writeHead(response.statusCode ?? 502, response.headers);
            response.pipe(res);
          },
        );
        upstream.once("timeout", () => upstream.destroy());
        upstream.once("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
        res.once("close", () => upstream.destroy());
        upstream.end();
      });
      return { server, origin: await listen(server, "https") };
    }),
    ({ server }) => Effect.promise(() => close(server)),
  );
  const rpc = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const server = createServer(async (req, res) => {
        try {
          assert.equal(req.method, "POST");
          assert.equal(req.headers.authorization, `Bearer ${token}`);
          let body = "";
          for await (const chunk of req) {
            body += String(chunk);
            assert.ok(body.length < 4096);
          }
          let response: string;
          if (req.url === "/chill.v4.UserService/GetFolder") {
            assert.equal(fromJsonString(GetFolderRequestSchema, body).id, 0n);
            calls.folder++;
            response = toJsonString(
              GetFolderResponseSchema,
              create(GetFolderResponseSchema, {
                parent: { id: 0n, name: "Library", fileType: "FOLDER" },
                files: [{ id: fileId, name: movieName, fileType: "VIDEO" }],
              }),
            );
          } else {
            assert.equal(req.url, "/chill.v4.UserService/ResolvePlayback");
            assert.equal(
              fromJsonString(ResolvePlaybackRequestSchema, body).fileId,
              fileId,
            );
            calls.playback++;
            response = toJsonString(
              ResolvePlaybackResponseSchema,
              create(ResolvePlaybackResponseSchema, {
                result: pending
                  ? { case: "pending", value: { reason: 1 } }
                  : {
                      case: "ready",
                      value: {
                        media: {
                          url: `${media.origin}/media/movie.mp4`,
                          expiry: { case: "expiryUnknown", value: true },
                        },
                        format: {
                          container: Container.MP4,
                          videoCodec: VideoCodec.H264,
                          audioCodec: AudioCodec.AAC,
                        },
                      },
                    },
              }),
            );
          }
          res
            .writeHead(200, {
              "content-type": "application/json",
              "cache-control": "no-store",
            })
            .end(response);
        } catch {
          calls.rejected++;
          res
            .writeHead(400, { "content-type": "application/json" })
            .end(
              '{"code":"invalid_argument","message":"Fixture request rejected"}',
            );
        }
      });
      return { server, origin: await listen(server) };
    }),
    ({ server }) => Effect.promise(() => close(server)),
  );
  const adapter = yield* Effect.acquireRelease(
    Effect.tryPromise(() =>
      startAdapter({
        layer: engineLayer({ baseUrl: rpc.origin, token }),
        folderId: 0n,
      }),
    ),
    (server) => Effect.promise(server.close),
  );
  endpoints.push(adapter.origin);
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
  for (const run of [1, 2]) {
    yield* Effect.tryPromise(async (signal) => {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        serviceWorkers: "block",
        ignoreHTTPSErrors: true,
      });
      const abort = () => {
        void context.close().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      let credentialLeak = false;
      await context.route("**/*", async (route) => {
        const req = route.request();
        if (
          req.url().includes(token) ||
          JSON.stringify(await req.allHeaders()).includes(token)
        )
          credentialLeak = true;
        return [web.origin, adapter.origin, media.origin].includes(
          new URL(req.url()).origin,
        )
          ? route.continue()
          : route.abort();
      });
      const page = await context.newPage();
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
          .fill(adapter.manifestUrl);
        await page.getByText("Add", { exact: true }).click();
        await page
          .getByText("Install", { exact: true })
          .filter({ visible: true })
          .click();
        const movie = async () => {
          await page.goto(`${web.origin}/#/`);
          await page.getByText(movieName, { exact: true }).first().click();
        };
        await movie();
        await page
          .getByText("chill.institute", { exact: true })
          .filter({ visible: true })
          .last()
          .click();
        const initial = await decoded(
          page,
          { ...fixture, origin: media.origin },
          "movie",
          `${directory}/run-${run}-movie.png`,
        );
        await movie();
        pending = true;
        const before = calls.playback;
        await page.reload();
        await expect(
          page.getByText(/No streams|No .*streams/i).first(),
        ).toBeVisible();
        assert.ok(
          calls.playback > before,
          "Pending state must come from Engine",
        );
        pending = false;
        await page.reload();
        await page
          .getByText("chill.institute", { exact: true })
          .filter({ visible: true })
          .last()
          .click();
        const recovered = await decoded(
          page,
          { ...fixture, origin: media.origin },
          "movie",
          `${directory}/run-${run}-recovered.png`,
        );
        assert.equal(credentialLeak, false, "Engine bearer reached browser");
        assert.equal(
          calls.rejected,
          0,
          "Generated Engine request contract failed",
        );
        runs.push({
          run,
          status: "passed",
          evidence: {
            initial,
            recovered,
            guestInstallation: true,
            engineBearerAbsentFromBrowser: true,
            pendingExplicitReload: true,
          },
        });
      } catch (error) {
        runs.push({ run, status: "failed", error: safeError(error) });
        await writeFile(
          `${directory}/run-${run}-page.txt`,
          safeError(
            await page
              .locator("body")
              .innerText()
              .catch(() => "Page unavailable"),
          ),
        );
        throw error;
      } finally {
        pending = false;
        signal.removeEventListener("abort", abort);
        await context.close();
      }
      console.log(JSON.stringify({ run, status: runs.at(-1)?.status }));
    }).pipe(Effect.timeout("3 minutes"));
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
      const servicesClosed = endpoints.length === 5 && closed.every(Boolean);
      const passed =
        !failure &&
        cleanupErrors.length === 0 &&
        servicesClosed &&
        browserClosed &&
        runs.length === 2 &&
        runs.every((run) => run.status === "passed");
      if (!passed) process.exitCode = 1;
      await mkdir(directory, { recursive: true });
      await writeFile(
        `${directory}/results.json`,
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
            cleanupErrors,
            calls,
            runs,
          },
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
