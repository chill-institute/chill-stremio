import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import { setTimeout as wait } from "node:timers/promises";
import { Effect, Schema } from "effect";
import { redactCredentials } from "../../src/credential.ts";
import { startHostedAdapter } from "../../src/hosted.ts";
import { playbackWait } from "../../src/playback-wait.ts";
import {
  close,
  episodeTarget,
  fakeCredential,
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
// the add-on credential never enters retained evidence.
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
  other: number;
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
  const rest = /^\/s\/v4\.local\.[A-Za-z0-9_-]+(\/.*)$/.exec(pathname)?.[1];
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
  // The guest types the link; this keeps it within the issued-credential length range.
  const credential = fakeCredential(240);
  const engine = yield* startHostedEngine({
    mediaOrigin: media.origin,
    credential,
    hls,
  });
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
    other: 0,
  };
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
    adapter.current = await startAdapter(adapterPort);
    assert.equal(adapter.current.listenOrigin, adapterOrigin);
    restarts++;
  };
  const manifestUrl = `${proxy.origin}/s/${credential}/manifest.json`;
  const base = `${proxy.origin}/s/${credential}`;
  const extension = hls ? "m3u8" : "mp4";
  const playPath = (type: string, target: string, releaseId: string) =>
    `${base}/play/${type}/${encodeURIComponent(target)}/${encodeURIComponent(releaseId)}.${extension}`;
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
  const status = async (transferId: bigint) =>
    fetch(`${base}/status/${transferId}.${extension}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
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
      case "library": {
        assert.equal(calls.transfer, 1);
        const head = await replay("movie", movieId, "fixture-release", "HEAD");
        assert.equal(head.status, 200);
        const again = await status(1n);
        assert.equal(again.status, 302);
        assert.ok(again.headers.get("location")?.startsWith(media.origin));
        await restartAdapter();
        const resumed = await status(1n);
        assert.equal(resumed.status, 302);
        assert.equal(calls.transfer, 1, "Status reads submitted a transfer");
        return { libraryId: `chill:file:${hostedFixture.fileId}` };
      }
      case "library-playing":
        assert.ok(calls.playback >= 1, "Engine playback was not resolved");
        assert.equal(calls.transfer, 1, "Library playback submitted");
        return {};
      case "library-subtitles":
        assert.ok(
          metrics.subtitles > 0,
          "Native client did not request subtitles",
        );
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
        const recovery = hostedFixture.recoveryCases.find(
          (entry) => entry.kind === kind,
        );
        assert.ok(recovery);
        if (kind !== "unknown") {
          const again = await status(recovery.transferId);
          assert.equal(again.status, 302);
          assert.ok(
            again.headers.get("location")?.endsWith(`/notice/${kind}.mp4`),
          );
        }
        assert.equal(calls.transfer, before + 1, "Status read submitted");
        return { fileId: `chill:file:${hostedFixture.multipleEpisodeId}` };
      }
      case "select-file-playing":
        assert.equal(
          calls.playbackFiles.at(-1),
          String(hostedFixture.multipleEpisodeId),
          "Chosen second file was not the resolved playback",
        );
        return {};
      case "reject-credential":
        engine.state.credentialRejected = true;
        return {};
      case "reconnect-client":
        await pollUntil(
          () => calls.unauthenticated >= 1,
          20_000,
          "Client requests did not reach the rejecting Engine",
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
          record.error = redactCredentials(
            String(error instanceof Error ? error.message : error),
          );
          reply(409, { ok: false, error: record.error });
        }
      });
      return { server, origin: await listen(server) };
    }),
    ({ server }) => Effect.promise(() => close(server)),
  );
  return {
    certificate: certificates.cert,
    manifestUrl,
    controlUrl: `${control.origin}/${secret}`,
    secrets: [credential],
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
