import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Effect, Layer, Schema } from "effect";
import sdk, { type Manifest } from "stremio-addon-sdk";
import {
  AcquisitionEngine,
  acquisitionEngineLayer,
  inspectTransferFiles,
} from "./acquisition-engine.ts";
import {
  createDiscovery,
  discoveryCatalogs,
  discoveryIdPrefixes,
  discoveryTargetId,
} from "./discovery.ts";
import { discoveryEngineLayer } from "./discovery-engine.ts";
import { engineLayer } from "./engine.ts";
import { createLibrary } from "./library.ts";
import {
  InstallationFailure,
  type Installation,
  type InstallationStore,
  type Acquisition,
} from "./installations.ts";
import { createSelection } from "./selection.ts";
import { playbackWait, waitForPlayback } from "./playback-wait.ts";
import {
  loadStatusMedia,
  sendStatusMedia,
  type StatusMediaKind,
  type StatusMedia,
} from "./status-media.ts";
import { adapterManifest } from "./server.ts";
import { configureAssets, configurePage } from "./configure-page.ts";

const FolderId = Schema.String.check(
  Schema.isPattern(/^(0|[1-9][0-9]{0,18})$/),
  Schema.makeFilter((value) => BigInt(value) <= 9223372036854775807n),
);
const Selection = Schema.Struct({
  type: Schema.Literals(["movie", "series"]),
  target: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1600)),
});
const Acquire = Schema.Struct({
  ...Selection.fields,
  releaseId: Schema.NonEmptyString.check(Schema.isMaxLength(512)),
});
const Bearer = Schema.String.check(
  Schema.isPattern(/^Bearer [A-Za-z0-9._~+/-]+=*$/),
  Schema.isMaxLength(8200),
);
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
    storage_unavailable: 503,
  })[code] ?? 502;
function parse<A, I>(schema: Schema.Codec<A, I>, value: unknown): A {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    return fail("invalid_request");
  }
}
async function body(request: IncomingMessage) {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json")
    return fail("invalid_request");
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 8192) return fail("invalid_request");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return fail("invalid_request");
  }
}
function json(response: ServerResponse, code: number, value?: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
  });
  response.end(value === undefined ? undefined : JSON.stringify(value));
}
const publicOperation = (operation: Acquisition) => ({
  id: operation.id,
  state: operation.state,
  transferId: operation.transferId,
});

export async function startHostedAdapter(options: {
  store: InstallationStore;
  statusMedia?: StatusMedia;
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
  let origin = options.publicOrigin ?? "";
  let listenOrigin = "";
  const idPrefixes = [
    ...(adapterManifest.idPrefixes ?? []),
    ...discoveryIdPrefixes,
    "chill:acquired:",
    "chill:download:",
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
        types: ["movie", "series"],
        idPrefixes: [...idPrefixes, "tt"],
      },
    ],
    catalogs: [
      ...discoveryCatalogs.filter(({ id }) => id === "discover-releases"),
      ...adapterManifest.catalogs,
      ...discoveryCatalogs.filter(({ id }) => id !== "discover-releases"),
      { type: "movie", id: "downloads", name: "Downloads" },
      { type: "movie", id: "acquired", name: "Acquired videos" },
    ],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
  const installationView = (installation: Installation) => ({
    id: installation.id,
    folderId: installation.folderId,
    createdAt: installation.createdAt,
    manifestUrl: `${origin}/i/${installation.capability}/manifest.json`,
  });
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
          response
            .writeHead(302, { Location: `${options.webOrigin}/stremio` })
            .end();
        }
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        const allowed = request.headers.origin === options.webOrigin;
        if (request.headers.origin && !allowed)
          return fail("permission_denied");
        if (allowed) {
          response.setHeader("Access-Control-Allow-Origin", options.webOrigin);
          response.setHeader("Vary", "Origin");
        }
        if (request.method === "OPTIONS") {
          response.setHeader(
            "Access-Control-Allow-Methods",
            "GET, POST, DELETE, OPTIONS",
          );
          response.setHeader(
            "Access-Control-Allow-Headers",
            "Authorization, Content-Type",
          );
          json(response, 204);
          return;
        }
        if (!Schema.is(Bearer)(request.headers.authorization))
          return fail("unauthenticated");
        const token = request.headers.authorization.slice(7);
        const layer = acquisitionEngineLayer({
          baseUrl: options.engineBaseUrl,
          token,
        });
        const profile = await run(
          Effect.flatMap(AcquisitionEngine, (engine) =>
            engine.getProfile(),
          ).pipe(Effect.provide(layer)),
        );
        const installations = options.store.list(profile.userId);
        if (url.pathname === "/api/installations") {
          if (request.method === "GET") {
            json(response, 200, {
              installations: installations.map(installationView),
            });
            return;
          }
          if (request.method === "POST") {
            const input = parse(
              Schema.Struct({ folderId: Schema.optional(FolderId) }),
              await body(request),
            );
            const folderId = input.folderId ?? "0";
            if (folderId !== "0") {
              await run(
                Effect.flatMap(AcquisitionEngine, (engine) =>
                  engine.getFolder(BigInt(folderId)),
                ).pipe(Effect.provide(layer)),
              );
            }
            json(
              response,
              201,
              installationView(
                options.store.create({
                  owner: profile.userId,
                  token,
                  folderId,
                }),
              ),
            );
            return;
          }
          return fail("not_found");
        }
        const parts = url.pathname.split("/");
        const installation = installations.find(
          (entry) => entry.id === parts[3],
        );
        if (parts[2] !== "installations" || !installation)
          return fail("not_found");
        if (parts.length === 4 && request.method === "DELETE") {
          options.store.revoke(profile.userId, installation.id);
          json(response, 204);
          return;
        }
        const discovery = createDiscovery();
        const discoveryLayer = discoveryEngineLayer({
          baseUrl: options.engineBaseUrl,
          token,
        });
        if (
          parts.length === 5 &&
          parts[4] === "releases" &&
          request.method === "GET"
        ) {
          const input = parse(Selection, {
            type: url.searchParams.get("type"),
            target: url.searchParams.get("target"),
          });
          const target = await run(
            discovery
              .resolveTarget({ type: input.type, id: input.target })
              .pipe(Effect.provide(discoveryLayer)),
          );
          const releases = await run(
            discovery.releases(target).pipe(Effect.provide(discoveryLayer)),
          );
          const operation = options.store
            .operations(installation.id)
            .find((entry) => entry.target === discoveryTargetId(target));
          json(response, 200, {
            releases: releases.map(({ id, title, indexer, size, seeders }) => ({
              id,
              title,
              indexer,
              size: String(size),
              seeders: String(seeders),
            })),
            operation: operation && publicOperation(operation),
          });
          return;
        }
        if (
          parts.length === 5 &&
          parts[4] === "acquisitions" &&
          request.method === "POST"
        ) {
          const input = parse(Acquire, await body(request));
          const target = await run(
            discovery
              .resolveTarget({ type: input.type, id: input.target })
              .pipe(Effect.provide(discoveryLayer)),
          );
          const canonical = discoveryTargetId(target);
          const prior = options.store
            .operations(installation.id)
            .find(
              (entry) =>
                entry.target === canonical &&
                entry.releaseId === input.releaseId,
            );
          if (prior) {
            json(response, 200, publicOperation(prior));
            return;
          }
          const releases = await run(
            discovery.releases(target).pipe(Effect.provide(discoveryLayer)),
          );
          const release = releases.find(
            (entry) => entry.id === input.releaseId,
          );
          if (!release) return fail("not_found");
          if (controller.signal.aborted) return fail("deadline_exceeded");
          const claim = options.store.claim(
            installation.id,
            canonical,
            release.id,
            release.title,
          );
          if (claim.fresh) {
            // A lost provider response cannot safely be retried. The durable claim remains unknown.
            try {
              const transfer = await run(
                Effect.flatMap(AcquisitionEngine, (engine) =>
                  engine.addTransfer(release.url),
                ).pipe(Effect.provide(layer)),
              );
              options.store.submitted(
                installation.id,
                claim.operation.id,
                String(transfer.id),
              );
            } catch {
              /* Preserve the durable unknown outcome, including cancellation. */
            }
          }
          const operation = options.store
            .operations(installation.id)
            .find((entry) => entry.id === claim.operation.id);
          if (!operation) return fail("storage_unavailable");
          json(response, 200, publicOperation(operation));
          return;
        }
        if (
          parts.length === 6 &&
          parts[4] === "acquisitions" &&
          request.method === "GET"
        ) {
          const operation = options.store
            .operations(installation.id)
            .find((entry) => entry.id === parts[5]);
          if (!operation) return fail("not_found");
          if (!operation.transferId) {
            json(response, 200, { ...publicOperation(operation), files: [] });
            return;
          }
          const result = await run(
            Effect.gen(function* () {
              const engine = yield* AcquisitionEngine;
              const transfer = yield* engine.getTransfer(
                BigInt(operation.transferId ?? "0"),
              );
              const files = yield* inspectTransferFiles(transfer);
              return { transfer, files };
            }).pipe(Effect.provide(layer)),
          );
          json(response, 200, {
            ...publicOperation(operation),
            transfer: {
              status: result.transfer.status,
              percentDone: result.transfer.percentDone,
            },
            files: result.files.map((file) => ({
              id: String(file.id),
              name: file.name,
              stremioId: `chill:acquired:${operation.id}:${file.id}`,
            })),
          });
          return;
        }
        return fail("not_found");
      }
      const match = /^\/i\/([A-Za-z0-9_-]{43})(\/.*)$/.exec(url.pathname);
      if (!match?.[1] || !match[2]) return fail("not_found");
      const installation = options.store.resolve(match[1]);
      if (!installation) return fail("not_found");
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
        json(response, 204);
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD")
        return fail("not_found");
      const layer = Layer.mergeAll(
        engineLayer({
          baseUrl: options.engineBaseUrl,
          token: installation.token,
        }),
        discoveryEngineLayer({
          baseUrl: options.engineBaseUrl,
          token: installation.token,
        }),
        acquisitionEngineLayer({
          baseUrl: options.engineBaseUrl,
          token: installation.token,
        }),
      );
      const library = createLibrary(
        BigInt(installation.folderId),
        installation.folderId === "0",
      );
      const discovery = createDiscovery();
      const selection = createSelection({
        store: options.store,
        installation,
        origin,
      });
      const playRoute =
        /^\/play\/(movie|series)\/([^/]+)\/([^/]+)\.(?:mp4|m3u8)$/.exec(
          match[2],
        );
      const statusRoute = /^\/status\/([0-9a-f-]{36})\.(?:mp4|m3u8)$/.exec(
        match[2],
      );
      const noticeRoute =
        /^\/notice\/(pending|unknown|failed|select-file|unavailable)\.mp4$/.exec(
          match[2],
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
      if (playRoute || statusRoute) {
        const hls = match[2].endsWith(".m3u8");
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
        let result;
        if (playRoute?.[1] && playRoute[2] && playRoute[3]) {
          let id: string;
          let releaseId: string;
          try {
            id = decodeURIComponent(playRoute[2]);
            releaseId = decodeURIComponent(playRoute[3]);
          } catch {
            return fail("invalid_request");
          }
          result = await run(
            selection
              .play({ type: playRoute[1], id, releaseId })
              .pipe(Effect.provide(layer)),
          );
        } else if (statusRoute?.[1]) {
          result = await run(
            selection.status(statusRoute[1]).pipe(Effect.provide(layer)),
          );
        } else return fail("not_found");
        const operationId = result.operationId;
        result = await waitForPlayback(
          result,
          async () => {
            if (!options.store.resolve(installation.capability))
              return fail("not_found");
            return run(
              selection.status(operationId).pipe(Effect.provide(layer)),
            );
          },
          controller.signal,
          timing,
        );
        if (response.destroyed || response.writableEnded) return;
        if ("status" in result && result.status === "pending") {
          if (Number(continuation) >= playbackWait.continuations) {
            response.setHeader("Retry-After", "5");
            json(response, 503, { error: "download_pending" });
          } else {
            response
              .writeHead(302, {
                Location: `${origin}/i/${installation.capability}/status/${result.operationId}.${hls ? "m3u8" : "mp4"}?wait=${Number(continuation) + 1}`,
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
          "url" in result
            ? result.url
            : `${origin}/i/${installation.capability}/notice/${result.status}.mp4`;
        response.writeHead(302, { Location: location }).end();
        return;
      }
      if (request.method !== "GET") return fail("not_found");
      const acquiredFiles = Effect.fn("Hosted.acquiredFiles")(function* (
        operation: Acquisition,
      ) {
        if (!operation.transferId) return [];
        const engine = yield* AcquisitionEngine;
        return yield* inspectTransferFiles(
          yield* engine.getTransfer(BigInt(operation.transferId)),
        );
      });
      const acquired = Effect.fn("Hosted.acquired")(function* (id: string) {
        const parsed =
          /^chill:acquired:([0-9a-f-]{36}):([1-9][0-9]{0,18})$/.exec(id);
        const operation = options.store
          .operations(installation.id)
          .find((entry) => entry.id === parsed?.[1]);
        if (!operation) return undefined;
        return (yield* acquiredFiles(operation)).find(
          (file) => String(file.id) === parsed?.[2],
        );
      });
      const builder = new sdk.addonBuilder({
        ...manifest,
        behaviorHints: {
          ...manifest.behaviorHints,
          configurationRequired: false,
        },
        logo: undefined,
      });
      builder.defineCatalogHandler(async ({ type, id, extra }) => {
        if (id === "downloads" && type === "movie")
          return run(selection.downloads().pipe(Effect.provide(layer)));
        if (id === "acquired" && type === "movie") {
          const operations = options.store
            .operations(installation.id)
            .filter((operation) => operation.transferId)
            .slice(0, 10);
          return run(
            Effect.gen(function* () {
              const groups = yield* Effect.forEach(
                operations,
                (operation) =>
                  acquiredFiles(operation).pipe(
                    Effect.catch((error) =>
                      error.code === "not_found"
                        ? Effect.succeed([])
                        : Effect.fail(error),
                    ),
                    Effect.map((files) =>
                      files.map((file) => ({
                        id: `chill:acquired:${operation.id}:${file.id}`,
                        type: "movie" as const,
                        name: file.name,
                      })),
                    ),
                  ),
                { concurrency: 2 },
              );
              return { metas: groups.flat().slice(0, 100) };
            }).pipe(Effect.provide(layer)),
          );
        }
        const input = {
          type,
          id,
          extra: {
            search: extra.search,
            skip: extra.skip === undefined ? undefined : String(extra.skip),
          },
        };
        return id === "library"
          ? run(library.catalog(input).pipe(Effect.provide(layer)))
          : run(discovery.catalog(input).pipe(Effect.provide(layer)));
      });
      builder.defineMetaHandler(async (input) => {
        if (
          input.type === "movie" &&
          /^chill:download:[0-9a-f-]{36}$/.test(input.id)
        )
          return run(
            selection
              .meta(input.id.slice("chill:download:".length))
              .pipe(Effect.provide(layer)),
          );
        let result;
        if (input.id.startsWith("chill:acquired:") && input.type === "movie") {
          const file = await run(
            acquired(input.id).pipe(Effect.provide(layer)),
          );
          result = {
            meta: file
              ? {
                  id: input.id,
                  type: "movie" as const,
                  name: file.name,
                  behaviorHints: { defaultVideoId: input.id },
                }
              : null,
          };
        } else
          result = input.id.startsWith("chill:file:")
            ? await run(library.meta(input).pipe(Effect.provide(layer)))
            : await run(discovery.meta(input).pipe(Effect.provide(layer)));
        if (!result.meta) return fail("not_found");
        return { meta: result.meta };
      });
      builder.defineStreamHandler(async (input) => {
        if (
          input.type === "movie" &&
          /^chill:download:[0-9a-f-]{36}$/.test(input.id)
        )
          return run(
            selection
              .operationStreams(input.id.slice("chill:download:".length))
              .pipe(Effect.provide(layer)),
          );
        if (input.id.startsWith("chill:acquired:") && input.type === "movie") {
          const file = await run(
            acquired(input.id).pipe(Effect.provide(layer)),
          );
          return file
            ? run(
                createLibrary(file.parentId)
                  .streams({ type: "movie", id: `chill:file:${file.id}` })
                  .pipe(Effect.provide(layer)),
              )
            : { streams: [] };
        }
        return input.id.startsWith("chill:file:")
          ? run(library.streams(input).pipe(Effect.provide(layer)))
          : run(selection.streams(input).pipe(Effect.provide(layer)));
      });
      builder.defineSubtitlesHandler(async (input) => {
        if (input.id.startsWith("chill:file:")) {
          const result = await run(
            library.streams(input).pipe(Effect.provide(layer)),
          );
          return {
            subtitles: result.streams.flatMap(
              (stream) => stream.subtitles ?? [],
            ),
          };
        }
        if (input.type === "movie" && input.id.startsWith("chill:acquired:")) {
          const file = await run(
            acquired(input.id).pipe(Effect.provide(layer)),
          );
          if (!file) return { subtitles: [] };
          const result = await run(
            createLibrary(file.parentId)
              .streams({ type: "movie", id: `chill:file:${file.id}` })
              .pipe(Effect.provide(layer)),
          );
          return {
            subtitles: result.streams.flatMap(
              (stream) => stream.subtitles ?? [],
            ),
          };
        }
        // The SDK accepts filename extras, but its TypeScript definition omits them.
        const extra = parse(
          Schema.Struct({
            filename: Schema.optional(
              Schema.String.check(Schema.isMaxLength(516)),
            ),
          }),
          input.extra,
        );
        return run(
          selection
            .subtitles({ ...input, filename: extra.filename })
            .pipe(Effect.provide(layer)),
        );
      });
      const addon = builder.getInterface();
      if (match[2] === "/manifest.json") {
        json(response, 200, addon.manifest);
        return;
      }
      if (match[2] === "/configure") {
        response
          .writeHead(302, { Location: `${options.webOrigin}/stremio` })
          .end();
        return;
      }
      const route =
        /^\/(catalog|meta|stream|subtitles)\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/.exec(
          match[2],
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
        error instanceof HttpFailure || error instanceof InstallationFailure
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
        for (const controller of controllers) controller.abort();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })),
  };
}
