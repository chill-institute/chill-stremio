import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { Effect, Layer } from "effect";
import sdk, { type ContentType, type Manifest } from "stremio-addon-sdk";
import { acquisitionEngineLayer } from "./acquisition-engine.ts";
import { credentialPattern } from "./credential.ts";
import {
  createDiscovery,
  discoveryCatalogs,
  discoveryIdPrefixes,
} from "./discovery.ts";
import { discoveryEngineLayer } from "./discovery-engine.ts";
import { engineLayer } from "./engine.ts";
import { createLibrary } from "./library.ts";
import { createSelection, type Submission } from "./selection.ts";
import {
  playbackWait,
  waitForPlayback,
  type PlaybackResult,
} from "./playback-wait.ts";
import {
  loadStatusMedia,
  sendStatusMedia,
  type StatusMediaKind,
  type StatusMedia,
} from "./status-media.ts";
import { adapterManifest } from "./server.ts";
import { configureAssets, configurePage } from "./configure-page.ts";

class HttpFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new HttpFailure(code);
};
const status = (code: string) =>
  ({
    unauthenticated: 401,
    permission_denied: 403,
    not_found: 404,
    invalid_request: 400,
    resource_exhausted: 429,
    deadline_exceeded: 504,
    unavailable: 503,
  })[code] ?? 502;
function json(response: ServerResponse, code: number, value?: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}
export async function startHostedAdapter(options: {
  statusMedia?: StatusMedia;
  /** How long a finished selection's submission is reused by identical requests. */
  selectionReuseMs?: number;
  engineBaseUrl: string;
  webOrigin: string;
  publicOrigin?: string;
  host?: string;
  port?: number;
}) {
  const validOrigin = (value: string) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      url.origin === value &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  };
  if (
    !validOrigin(options.webOrigin) ||
    (options.publicOrigin && !validOrigin(options.publicOrigin))
  )
    throw new Error("Invalid hosted origin");
  const statusMedia = options.statusMedia ?? (await loadStatusMedia());
  const controllers = new Set<AbortController>();
  // Identical selections share one submission while any of their requests is
  // open and briefly afterwards: native players reopen the selected URL once
  // the first request resolves. Nothing survives a restart.
  const reuseMs = options.selectionReuseMs ?? 60_000;
  const submissions = new Map<
    string,
    {
      submission: Promise<Submission>;
      users: number;
      failed: boolean;
      expiry?: ReturnType<typeof setTimeout>;
    }
  >();
  const forget = (key: string) => {
    clearTimeout(submissions.get(key)?.expiry);
    submissions.delete(key);
  };
  let origin = options.publicOrigin ?? "";
  let listenOrigin = "";
  const reconnectUrl = `${options.webOrigin}/stremio`;
  const idPrefixes = [
    ...(adapterManifest.idPrefixes ?? []),
    ...discoveryIdPrefixes,
    "chill:reconnect",
  ];
  const manifest: Manifest = {
    ...adapterManifest,
    description:
      "Early access, work in progress. Discover movies and series, choose releases and play your put.io videos through chill.institute.",
    types: ["movie", "series"],
    idPrefixes,
    resources: [
      "catalog",
      { name: "meta", types: ["movie", "series"], idPrefixes },
      {
        name: "stream",
        types: ["movie", "series"],
        idPrefixes: [...idPrefixes, "tt"],
      },
      {
        name: "subtitles",
        types: ["movie"],
        idPrefixes: adapterManifest.idPrefixes ?? [],
      },
    ],
    catalogs: [
      ...discoveryCatalogs.filter(({ id }) => id === "discover-releases"),
      ...adapterManifest.catalogs,
      ...discoveryCatalogs.filter(({ id }) => id !== "discover-releases"),
    ],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
  const reconnectMeta = (type: ContentType) => ({
    id: "chill:reconnect",
    type,
    name: "Reconnect chill.institute",
    description: `This add-on link is no longer accepted. Open ${reconnectUrl} and install the add-on again.`,
    behaviorHints: { defaultVideoId: "chill:reconnect" },
  });
  const reconnectStream = {
    name: "chill.institute",
    title: `Reconnect at ${reconnectUrl}`,
    externalUrl: reconnectUrl,
  };
  const rejected = (error: unknown) =>
    error instanceof HttpFailure &&
    (error.code === "unauthenticated" || error.code === "permission_denied");
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    const controller = new AbortController();
    if (controllers.size >= 64) {
      json(response, 503, { error: "unavailable" });
      return;
    }
    controllers.add(controller);
    let deadline = setTimeout(() => {
      controller.abort();
      json(response, 504, { error: "deadline_exceeded" });
    }, 10_000);
    response.once("close", () => {
      clearTimeout(deadline);
      controllers.delete(controller);
      controller.abort();
    });
    request.once("aborted", () => controller.abort());
    const run = async <A, E extends { code: string }>(
      effect: Effect.Effect<A, E>,
    ) => {
      const result = await Effect.runPromise(
        effect.pipe(
          Effect.match({
            onSuccess: (value) => ({ ok: true as const, value }),
            onFailure: (error) => ({ ok: false as const, code: error.code }),
          }),
        ),
        { signal: controller.signal },
      );
      return result.ok ? result.value : fail(result.code);
    };
    const handle = async () => {
      if (
        request.headers.host !== new URL(origin).host ||
        (request.url?.length ?? 0) > 4096
      )
        return fail("not_found");
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin) return fail("not_found");
      if (url.pathname === "/health" && request.method === "GET") {
        json(response, 200, { status: "ok" });
        return;
      }
      const asset = configureAssets.get(url.pathname);
      if (asset && (request.method === "GET" || request.method === "HEAD")) {
        response.writeHead(200, {
          "Content-Type": asset.contentType,
          "Cache-Control": "public, max-age=3600",
        });
        response.end(request.method === "HEAD" ? undefined : asset.body);
        return;
      }
      if (["/", "/configure", "/manifest.json"].includes(url.pathname)) {
        response.setHeader("Access-Control-Allow-Origin", "*");
        if (request.method === "OPTIONS") {
          response.setHeader(
            "Access-Control-Allow-Methods",
            "GET, HEAD, OPTIONS",
          );
          json(response, 204);
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD")
          return fail("not_found");
        if (url.pathname === "/manifest.json") {
          json(response, 200, {
            ...manifest,
            description:
              "Early access. Connect your put.io account to discover movies and series, choose releases and play your videos inside Stremio. Requires a put.io account.",
            behaviorHints: { configurable: true, configurationRequired: true },
          });
        } else if (url.pathname === "/configure") {
          const page = configurePage(options.webOrigin);
          response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": page.contentSecurityPolicy,
          });
          response.end(page.html);
        } else {
          response.writeHead(302, { Location: reconnectUrl }).end();
        }
        return;
      }
      const match = /^\/s\/([^/]+)(\/.*)$/.exec(url.pathname);
      const credential = match?.[1];
      const path = match?.[2];
      if (!credential || !path || !credentialPattern.test(credential))
        return fail("not_found");
      const base = `${origin}/s/${credential}`;
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        json(response, 204);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return fail("not_found");
      const auth = { baseUrl: options.engineBaseUrl, credential };
      const layer = Layer.mergeAll(
        engineLayer(auth),
        discoveryEngineLayer(auth),
        acquisitionEngineLayer(auth),
      );
      const library = createLibrary(0n, true);
      const discovery = createDiscovery();
      const selection = createSelection({ base });
      const playRoute =
        /^\/play\/(movie|series)\/([^/]+)\/([^/]+)\.(?:mp4|m3u8)$/.exec(path);
      const statusRoute = /^\/status\/([1-9][0-9]{0,18})\.(?:mp4|m3u8)$/.exec(
        path,
      );
      const noticeRoute =
        /^\/notice\/(pending|unknown|failed|select-file|unavailable|reconnect)\.mp4$/.exec(
          path,
        );
      if (noticeRoute?.[1]) {
        sendStatusMedia(
          request,
          response,
          statusMedia,
          noticeRoute[1] as StatusMediaKind,
        );
        return;
      }
      if (statusRoute?.[1] && BigInt(statusRoute[1]) > 9223372036854775807n)
        return fail("not_found");
      if (playRoute || statusRoute) {
        const hls = path.endsWith(".m3u8");
        const timing = hls
          ? { ...playbackWait, windowMs: 25_000 }
          : playbackWait;
        // The pinned player probes content type with HEAD before consuming the selected media URL.
        if (request.method === "HEAD") {
          response
            .writeHead(200, {
              "Content-Type": hls
                ? "application/vnd.apple.mpegurl"
                : "video/mp4",
            })
            .end();
          return;
        }
        if (
          request.headers.purpose === "prefetch" ||
          request.headers["sec-purpose"]?.includes("prefetch")
        ) {
          response.writeHead(204).end();
          return;
        }
        const continuation = url.searchParams.get("wait") ?? "0";
        if (
          !/^[0-5]$/.test(continuation) ||
          url.searchParams.size > (url.searchParams.has("wait") ? 1 : 0)
        )
          return fail("invalid_request");
        clearTimeout(deadline);
        deadline = setTimeout(() => {
          controller.abort();
          json(response, 504, { error: "deadline_exceeded" });
        }, timing.windowMs + 10_000);
        let transferId: bigint | undefined;
        let result: PlaybackResult;
        let release = () => {};
        const inspect = (id: bigint) =>
          run(selection.status(id).pipe(Effect.provide(layer)));
        try {
          if (playRoute?.[1] && playRoute[2] && playRoute[3]) {
            const type = playRoute[1];
            let id: string;
            let releaseId: string;
            try {
              id = decodeURIComponent(playRoute[2]);
              releaseId = decodeURIComponent(playRoute[3]);
            } catch {
              return fail("invalid_request");
            }
            const key = createHash("sha256")
              .update(`${credential}\n${type}\n${id}\n${releaseId}`)
              .digest("hex");
            let shared = submissions.get(key);
            if (!shared) {
              for (const [stale, candidate] of submissions)
                if (submissions.size >= 256 && candidate.users === 0)
                  forget(stale);
              const created = {
                submission: run(
                  selection
                    .submit({ type, id, releaseId })
                    .pipe(Effect.provide(layer)),
                ),
                users: 0,
                failed: false,
              };
              created.submission.catch(() => {
                created.failed = true;
              });
              shared = created;
              submissions.set(key, shared);
            }
            const entry = shared;
            clearTimeout(entry.expiry);
            entry.users++;
            release = () => {
              if (--entry.users > 0 || submissions.get(key) !== entry) return;
              if (entry.failed) forget(key);
              else {
                entry.expiry = setTimeout(() => forget(key), reuseMs);
                entry.expiry.unref();
              }
            };
            const submitted = await entry.submission;
            if ("transferId" in submitted) {
              transferId = submitted.transferId;
              result = await inspect(transferId);
            } else result = submitted;
          } else {
            transferId = BigInt(statusRoute?.[1] ?? "0");
            result = await inspect(transferId);
          }
          const polled = transferId;
          if (polled !== undefined)
            result = await waitForPlayback(
              result,
              () => inspect(polled),
              controller.signal,
              timing,
            );
        } catch (error) {
          if (!rejected(error)) throw error;
          result = { status: "reconnect" };
        } finally {
          release();
        }
        if (response.destroyed || response.writableEnded) return;
        if ("status" in result && result.status === "pending") {
          if (Number(continuation) >= playbackWait.continuations) {
            response.setHeader("Retry-After", "5");
            json(response, 503, { error: "download_pending" });
          } else {
            response
              .writeHead(302, {
                Location: `${base}/status/${transferId}.${hls ? "m3u8" : "mp4"}?wait=${Number(continuation) + 1}`,
              })
              .end();
          }
          return;
        }
        if (hls && "status" in result) {
          json(response, 409, { error: result.status });
          return;
        }
        const location =
          "url" in result ? result.url : `${base}/notice/${result.status}.mp4`;
        response.writeHead(302, { Location: location }).end();
        return;
      }
      if (request.method !== "GET") return fail("not_found");
      const builder = new sdk.addonBuilder({
        ...manifest,
        behaviorHints: {
          ...manifest.behaviorHints,
          configurationRequired: false,
        },
        logo: undefined,
      });
      builder.defineCatalogHandler(async ({ type, id, extra }) => {
        const input = {
          type,
          id,
          extra: {
            search: extra.search,
            skip: extra.skip === undefined ? undefined : String(extra.skip),
          },
        };
        try {
          return id === "library"
            ? await run(library.catalog(input).pipe(Effect.provide(layer)))
            : await run(discovery.catalog(input).pipe(Effect.provide(layer)));
        } catch (error) {
          if (rejected(error)) return { metas: [reconnectMeta(type)] };
          throw error;
        }
      });
      builder.defineMetaHandler(async (input) => {
        if (input.id === "chill:reconnect")
          return { meta: reconnectMeta(input.type) };
        const result = input.id.startsWith("chill:file:")
          ? await run(library.meta(input).pipe(Effect.provide(layer)))
          : await run(discovery.meta(input).pipe(Effect.provide(layer)));
        if (!result.meta) return fail("not_found");
        return { meta: result.meta };
      });
      builder.defineStreamHandler(async (input) => {
        if (input.id === "chill:reconnect")
          return { streams: [reconnectStream] };
        try {
          return input.id.startsWith("chill:file:")
            ? await run(library.streams(input).pipe(Effect.provide(layer)))
            : await run(selection.streams(input).pipe(Effect.provide(layer)));
        } catch (error) {
          if (rejected(error)) return { streams: [reconnectStream] };
          throw error;
        }
      });
      builder.defineSubtitlesHandler(async (input) => {
        if (!input.id.startsWith("chill:file:")) return { subtitles: [] };
        try {
          const result = await run(
            library.streams(input).pipe(Effect.provide(layer)),
          );
          return {
            subtitles: result.streams.flatMap(
              (stream) => stream.subtitles ?? [],
            ),
          };
        } catch (error) {
          if (rejected(error)) return { subtitles: [] };
          throw error;
        }
      });
      const addon = builder.getInterface();
      if (path === "/manifest.json") {
        json(response, 200, addon.manifest);
        return;
      }
      if (path === "/configure") {
        response.writeHead(302, { Location: reconnectUrl }).end();
        return;
      }
      const route =
        /^\/(catalog|meta|stream|subtitles)\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/.exec(
          path,
        );
      if (!route?.[1] || !route[2] || !route[3]) return fail("not_found");
      let type: string;
      let id: string;
      try {
        type = decodeURIComponent(route[2]);
        id = decodeURIComponent(route[3]);
      } catch {
        return fail("invalid_request");
      }
      const extra: Record<string, string> = {};
      for (const [key, value] of new URLSearchParams(route[4] ?? "")) {
        if (Object.hasOwn(extra, key)) return fail("invalid_request");
        extra[key] = value;
      }
      // The SDK runtime takes positional arguments; its DefinitelyTyped signature takes one object.
      // Keep HTTP completion here so a canceled SDK handler cannot write after the deadline response.
      const result: unknown = await Reflect.apply(addon.get, addon, [
        route[1],
        type,
        id,
        extra,
      ]);
      json(response, 200, result);
    };
    void handle().catch((error) => {
      const code =
        error instanceof HttpFailure
          ? error.code
          : controller.signal.aborted
            ? "deadline_exceeded"
            : "unavailable";
      json(response, status(code), { error: code });
    });
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, options.host ?? "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    listenOrigin = `http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`;
    origin ||= listenOrigin;
  } catch {
    server.closeAllConnections();
    server.close();
    throw new Error("Hosted adapter could not start");
  }
  let closing: Promise<void> | undefined;
  return {
    origin,
    /** The bound listener, which differs from `origin` behind an ingress. */
    listenOrigin,
    close: () =>
      (closing ??= new Promise<void>((resolve, reject) => {
        for (const key of submissions.keys()) forget(key);
        for (const controller of controllers) controller.abort();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })),
  };
}
