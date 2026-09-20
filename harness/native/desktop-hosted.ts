import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import { Effect, Schema } from "effect";
import { startHostedAdapter } from "../../src/hosted.ts";
import { InstallationStore } from "../../src/installations.ts";
import { playbackWait } from "../../src/playback-wait.ts";
import {
  close,
  episodeTarget,
  generateCertificates,
  hostedFixture,
  listen,
  movieTarget,
  seriesMetaId,
  startHostedEngine,
  startHostedMedia,
  type HostedEngineCalls,
  type RecoveryKind,
} from "../hosted-fixture.ts";

// Serves the actual hosted adapter to the native desktop guest behind an
// observing loopback proxy, and answers the guest's stage checkpoints with
// harness-side assertions. Only request classes and statuses are recorded;
// the installation capability never enters retained evidence.
export interface ProxyMetrics {
  manifest: number;
  catalog: number;
  meta: number;
  stream: number;
  subtitles: number;
  playHead: number;
  playGet: number;
  playOptions: number;
  prefetchHinted: number;
  notice: Record<string, number>;
  status: number;
  api: number;
  other: number;
  deniedAfterRevocation: number;
}
export interface HostedSnapshot {
  engineCalls: HostedEngineCalls;
  proxy: ProxyMetrics;
  media: { cuts: number; refused: number };
  adapterRestarts: number;
  stages: StageRecord[];
}
export interface StageRecord {
  stage: string;
  kind?: string;
  at: number;
  ok: boolean;
  error?: string;
}
const StageInput = Schema.Struct({
  stage: Schema.String,
  kind: Schema.optional(Schema.Literals(["failed", "unknown", "select-file"])),
});
const classify = (pathname: string) => {
  if (pathname.startsWith("/api/")) return "api" as const;
  const rest = /^\/i\/[A-Za-z0-9_-]{43}(\/.*)$/.exec(pathname)?.[1];
  if (!rest) return "other" as const;
  if (rest === "/manifest.json") return "manifest" as const;
  if (rest.startsWith("/catalog/")) return "catalog" as const;
  if (rest.startsWith("/meta/")) return "meta" as const;
  if (rest.startsWith("/stream/")) return "stream" as const;
  if (rest.startsWith("/subtitles/")) return "subtitles" as const;
  if (rest.startsWith("/play/")) return "play" as const;
  if (rest.startsWith("/status/")) return "status" as const;
  const notice = /^\/notice\/([a-z-]+)\.mp4$/.exec(rest)?.[1];
  if (notice) return { notice };
  return "other" as const;
};
const pollUntil = async (
  predicate: () => boolean,
  timeoutMs: number,
  message: string,
) => {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await wait(250);
  }
};

export const startHostedDesktop = Effect.fn("startHostedDesktop")(function* (
  fixtureOrigin: string,
  webOrigin: string,
  hls = false,
) {
  const certificates = yield* generateCertificates();
  const { media } = yield* startHostedMedia(fixtureOrigin, certificates, {
    paceMovie: !hls,
    hls,
  });
  const engine = yield* startHostedEngine({ mediaOrigin: media.origin, hls });
  const privateDirectory = yield* Effect.acquireRelease(
    Effect.tryPromise(() => mkdtemp("/tmp/chill-desktop-hosted-")),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  const storeKey = randomBytes(32);
  const storePath = `${privateDirectory}/installations.sqlite`;
  const store = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => ({
      current: await InstallationStore.open(storePath, storeKey),
    })),
    (database) => Effect.sync(() => database.current.close()),
  );
  const metrics: ProxyMetrics = {
    manifest: 0,
    catalog: 0,
    meta: 0,
    stream: 0,
    subtitles: 0,
    playHead: 0,
    playGet: 0,
    playOptions: 0,
    prefetchHinted: 0,
    notice: {},
    status: 0,
    api: 0,
    other: 0,
    deniedAfterRevocation: 0,
  };
  let revoked = false;
  let adapterOrigin = "";
  const proxy = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const server = createServer((req, res) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        const kind = classify(pathname);
        if (typeof kind === "object")
          metrics.notice[kind.notice] = (metrics.notice[kind.notice] ?? 0) + 1;
        else if (kind === "play") {
          if (req.method === "GET") metrics.playGet++;
          else if (req.method === "HEAD") metrics.playHead++;
          else metrics.playOptions++;
          if (
            req.headers.purpose === "prefetch" ||
            req.headers["sec-purpose"]?.includes("prefetch")
          )
            metrics.prefetchHinted++;
        } else metrics[kind]++;
        const upstream = request(
          `${adapterOrigin}${req.url ?? "/"}`,
          {
            method: req.method,
            headers: req.headers,
            timeout: playbackWait.windowMs + 15_000,
          },
          (response) => {
            if (revoked && response.statusCode === 404)
              metrics.deniedAfterRevocation++;
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
        req.pipe(upstream);
      });
      return { server, origin: await listen(server) };
    }),
    ({ server }) => Effect.promise(() => close(server)),
  );
  const startAdapter = (port?: number) =>
    startHostedAdapter({
      store: store.current,
      engineBaseUrl: engine.origin,
      webOrigin,
      publicOrigin: proxy.origin,
      port,
    });
  const adapter = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => ({ current: await startAdapter() })),
    (server) => Effect.promise(() => server.current.close()),
  );
  adapterOrigin = adapter.current.listenOrigin;
  const adapterPort = Number(new URL(adapterOrigin).port);
  let restarts = 0;
  const restartAdapter = async () => {
    await adapter.current.close();
    store.current.close();
    store.current = await InstallationStore.open(storePath, storeKey);
    adapter.current = await startAdapter(adapterPort);
    assert.equal(adapter.current.listenOrigin, adapterOrigin);
    restarts++;
  };
  const created = yield* Effect.tryPromise(async () => {
    const response = await fetch(`${proxy.origin}/api/installations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${engine.token}`,
        "content-type": "application/json",
        origin: webOrigin,
      },
      body: '{"folderId":"0"}',
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(response.status, 201, "Installation was not created");
    return Schema.decodeUnknownSync(
      Schema.Struct({ id: Schema.String, manifestUrl: Schema.String }),
    )(await response.json());
  });
  const installation = store.current
    .list("1")
    .find((entry) => entry.id === created.id);
  assert.ok(installation, "Created installation is not listed");
  assert.ok(
    created.manifestUrl.startsWith(`${proxy.origin}/i/`),
    "Manifest must use the observed public origin",
  );
  const playPath = (type: string, target: string, releaseId: string) =>
    `${proxy.origin}/i/${installation.capability}/play/${type}/${encodeURIComponent(target)}/${encodeURIComponent(releaseId)}.${hls ? "m3u8" : "mp4"}`;
  const replay = async (
    type: string,
    target: string,
    releaseId: string,
    method = "GET",
  ) =>
    fetch(playPath(type, target, releaseId), {
      method,
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  const operationFor = (releaseId: string) => {
    const operation = store.current
      .operations(installation.id)
      .find((entry) => entry.releaseId === releaseId);
    assert.ok(operation, `No durable claim for ${releaseId}`);
    return operation;
  };
  const stages: StageRecord[] = [];
  const transferBefore = new Map<RecoveryKind, number>();
  const movieId = movieTarget(hostedFixture.movieId);
  const calls: HostedEngineCalls = engine.calls;
  const handle = async (
    input: typeof StageInput.Type,
  ): Promise<Record<string, unknown>> => {
    switch (input.stage) {
      case "installed":
        assert.ok(metrics.manifest >= 1, "Client did not fetch the manifest");
        return {};
      case "catalog":
        return { movieId };
      case "movie-detail":
      case "episode-detail":
        assert.equal(calls.transfer, 0, "Browsing submitted a transfer");
        assert.equal(
          metrics.playGet,
          0,
          "Client consumed media before selection",
        );
        assert.ok(metrics.stream >= 1, "Client did not list streams");
        return {};
      case "episode":
        return { seriesId: seriesMetaId, episodeId: episodeTarget };
      case "selected":
        await pollUntil(
          () => calls.transfer >= 1,
          30_000,
          "Selection did not submit one transfer",
        );
        assert.equal(calls.transfer, 1, "Selection submitted more than once");
        assert.ok(
          metrics.playGet >= 1,
          "Selection did not consume the media URL",
        );
        assert.equal(metrics.notice.pending ?? 0, 0);
        assert.equal(engine.state.completed, false);
        return {};
      case "complete":
        assert.equal(calls.transfer, 1);
        assert.equal(metrics.notice.pending ?? 0, 0);
        engine.state.completed = true;
        return {};
      case "automatic-playing":
        assert.ok(calls.playback >= 1);
        assert.equal(metrics.notice.pending ?? 0, 0);
        assert.equal(calls.transfer, 1);
        return {};
      case "download-subtitles":
        assert.ok(
          metrics.subtitles > 0,
          "Native client did not request subtitles",
        );
        return {};
      case "downloads": {
        assert.equal(calls.transfer, 1);
        const head = await replay("movie", movieId, "fixture-release", "HEAD");
        assert.equal(head.status, 200);
        const again = await replay("movie", movieId, "fixture-release");
        assert.equal(again.status, 302);
        assert.ok(again.headers.get("location")?.startsWith(media.origin));
        assert.equal(calls.transfer, 1, "Repeated media GET resubmitted");
        await restartAdapter();
        const resumed = await replay("movie", movieId, "fixture-release");
        assert.equal(resumed.status, 302);
        assert.equal(calls.transfer, 1, "Restarted adapter resubmitted");
        const operation = operationFor("fixture-release");
        return {
          acquiredId: `chill:acquired:${operation.id}:${hostedFixture.fileId}`,
        };
      }
      case "acquired-playing":
        assert.ok(calls.playback >= 1, "Engine playback was not resolved");
        assert.equal(calls.transfer, 1, "Acquired playback resubmitted");
        return {};
      case "interrupt":
        media.interrupt();
        return {};
      case "recovered":
        assert.ok(media.cuts >= 1, "No active media response was cut");
        assert.equal(calls.transfer, 1);
        return { cuts: media.cuts, refused: media.refused };
      case "recovery-detail": {
        assert.ok(input.kind, "Recovery stage needs a kind");
        transferBefore.set(input.kind, calls.transfer);
        return { movieId: movieTarget(`fixture-${input.kind}`) };
      }
      case "recovery-selected": {
        const kind = input.kind;
        assert.ok(kind, "Recovery stage needs a kind");
        const before = transferBefore.get(kind);
        assert.ok(before !== undefined, "Recovery detail stage was skipped");
        await pollUntil(
          () =>
            calls.transfer >= before + 1 && (metrics.notice[kind] ?? 0) >= 1,
          30_000,
          `Selection did not submit ${kind} and load its status clip`,
        );
        assert.equal(calls.transfer, before + 1);
        const target = movieTarget(`fixture-${kind}`);
        const again = await replay("movie", target, `fixture-${kind}-release`);
        assert.equal(again.status, 302);
        assert.ok(
          again.headers.get("location")?.endsWith(`/notice/${kind}.mp4`),
        );
        assert.equal(calls.transfer, before + 1, "Status replay resubmitted");
        return { operationId: operationFor(`fixture-${kind}-release`).id };
      }
      case "unknown-restart": {
        const before = calls.transfer;
        await restartAdapter();
        const again = await replay(
          "movie",
          movieTarget("fixture-unknown"),
          "fixture-unknown-release",
        );
        assert.equal(again.status, 302);
        assert.ok(
          again.headers.get("location")?.endsWith("/notice/unknown.mp4"),
        );
        assert.equal(calls.transfer, before, "Unknown outcome was resubmitted");
        return {};
      }
      case "select-file-playing":
        assert.equal(
          calls.playbackFiles.at(-1),
          String(hostedFixture.multipleEpisodeId),
          "Chosen second file was not the resolved playback",
        );
        return {};
      case "revoke": {
        const response = await fetch(
          `${proxy.origin}/api/installations/${installation.id}`,
          {
            method: "DELETE",
            headers: {
              authorization: `Bearer ${engine.token}`,
              origin: webOrigin,
            },
            signal: AbortSignal.timeout(10_000),
          },
        );
        assert.equal(response.status, 204);
        revoked = true;
        const manifest = await fetch(created.manifestUrl, {
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(manifest.status, 404, "Revoked manifest still served");
        return {};
      }
      case "revoked-client":
        await pollUntil(
          () => metrics.deniedAfterRevocation >= 1,
          20_000,
          "Client requests were not denied after revocation",
        );
        return {};
      default:
        throw new Error(`Unknown stage ${input.stage}`);
    }
  };
  const secret = randomBytes(16).toString("hex");
  const control = yield* Effect.acquireRelease(
    Effect.tryPromise(async () => {
      const server = createServer(async (req, res) => {
        const reply = (status: number, body: Record<string, unknown>) =>
          res
            .writeHead(status, { "content-type": "application/json" })
            .end(JSON.stringify(body));
        if (req.method !== "POST" || req.url !== `/${secret}/stage`)
          return reply(404, { ok: false, error: "not_found" });
        let raw = "";
        for await (const chunk of req) {
          raw += String(chunk);
          if (raw.length > 4096)
            return reply(413, { ok: false, error: "large" });
        }
        let input: typeof StageInput.Type;
        try {
          input = Schema.decodeUnknownSync(Schema.fromJsonString(StageInput))(
            raw,
          );
        } catch {
          return reply(400, { ok: false, error: "invalid_stage" });
        }
        const record: StageRecord = {
          stage: input.stage,
          kind: input.kind,
          at: Date.now(),
          ok: false,
        };
        stages.push(record);
        try {
          const data = await handle(input);
          record.ok = true;
          reply(200, { ok: true, ...data });
        } catch (error) {
          record.error = String(error instanceof Error ? error.message : error)
            .replaceAll(installation.capability, "[capability]")
            .replaceAll(engine.token, "[token]");
          reply(409, { ok: false, error: record.error });
        }
      });
      return { server, origin: await listen(server) };
    }),
    ({ server }) => Effect.promise(() => close(server)),
  );
  return {
    certificate: certificates.cert,
    manifestUrl: created.manifestUrl,
    controlUrl: `${control.origin}/${secret}`,
    secrets: [installation.capability, engine.token],
    endpoints: [media.origin, engine.origin, proxy.origin, control.origin],
    snapshot: (): HostedSnapshot => ({
      engineCalls: { ...calls, playbackFiles: [...calls.playbackFiles] },
      proxy: { ...metrics, notice: { ...metrics.notice } },
      media: { cuts: media.cuts, refused: media.refused },
      adapterRestarts: restarts,
      stages: stages.map((record) => ({ ...record })),
    }),
  };
});
