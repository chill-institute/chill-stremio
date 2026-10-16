import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { Effect, Layer } from "effect";
import sdk, {
  type ContentType,
  type Manifest,
  type MetaDetail,
} from "stremio-addon-sdk";
import { acquisitionEngineLayer } from "./acquisition-engine.ts";
import { createAdmission, type Lease, type Refusal } from "./admission.ts";
import { credentialPattern } from "./credential.ts";
import { manifestDescriptions } from "./manifest-descriptions.ts";
import {
  createDiscovery,
  discoveryCatalogs,
  discoveryIdPrefixes,
  type SeasonEpisode,
} from "./discovery.ts";
import { DiscoveryDeadline, discoveryEngineLayer } from "./discovery-engine.ts";
import { engineLayer } from "./engine.ts";
import { createLibrary } from "./library.ts";
import {
  createSelection,
  ownedFileId,
  ownedPrefix,
  submissionBudgetMs,
  type Submission,
} from "./selection.ts";
import {
  playbackWait,
  waitForPlayback,
  type PlaybackResult,
} from "./playback-wait.ts";
import {
  loadStatusMedia,
  sendStatusMedia,
  statusMediaKinds,
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
/** An Engine rate limit, outage, timeout or failed fetch: a later read may pass. */
const transient = (error: unknown) =>
  error instanceof HttpFailure &&
  [
    "resource_exhausted",
    "unavailable",
    "deadline_exceeded",
    "unknown",
  ].includes(error.code);
/** Resolves once the signal aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<undefined>((resolve) => {
    if (signal.aborted) resolve(undefined);
    signal.addEventListener("abort", () => resolve(undefined), { once: true });
  });
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
function refuse(response: ServerResponse, refusal: Refusal, media: boolean) {
  response.setHeader("Retry-After", "5");
  // HLS players retry selected media after a 5xx but give up after any 4xx,
  // and after a cross-origin response they may not read.
  response.setHeader("Access-Control-Allow-Origin", "*");
  const linkLimit = refusal === "link" && !media;
  json(response, linkLimit ? 429 : 503, {
    error: linkLimit ? "resource_exhausted" : "unavailable",
  });
}
export async function startHostedAdapter(options: {
  statusMedia?: StatusMedia;
  /** How long a finished selection's submission is reused by identical requests. */
  selectionReuseMs?: number;
  /** How long an HLS selection waits automatically before it shows the pending clip. */
  selectionPendingMs?: number;
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
  // A unit is an open request or an unsettled submission. Stremio requests
  // every visible catalog, a title's resources and the player's resources at
  // once and cancels none on navigation; 16 covers one link on two synced
  // devices while leaving most of the process to other links.
  const admission = createAdmission({ total: 64, perLink: 16 });
  const shutdown = new AbortController();
  // Identical selections share one submission while any of their requests is
  // open and briefly afterwards: native players reopen the selected URL once
  // the first request resolves. Nothing survives a restart.
  const reuseMs = options.selectionReuseMs ?? 60_000;
  const pendingMs = options.selectionPendingMs ?? 240_000;
  const submissions = new Map<
    string,
    {
      submission: Promise<Submission>;
      users: number;
      settled: boolean;
      failed: boolean;
      /** When the current automatic wait began; the pending clip restarts it. */
      waitingSince: number;
      expiry?: ReturnType<typeof setTimeout>;
    }
  >();
  const forget = (key: string) => {
    clearTimeout(submissions.get(key)?.expiry);
    submissions.delete(key);
  };
  // When each HLS selection of a video already in put.io began waiting, and
  // when a request last joined or left it. Each of those reinserts its entry,
  // so the least recently seen come first.
  const ownedWaits = new Map<string, { since: number; lastSeen: number }>();
  // A request lasts at most its first read's 10 seconds and one HLS window,
  // so an entry idle longer has no open request.
  const longestRequestMs = 10_000 + playbackWait.hlsWindowMs;
  const liveOwnedWait = (key: string) => {
    const entry = ownedWaits.get(key);
    return entry !== undefined && performance.now() - entry.lastSeen <= reuseMs;
  };
  const joinOwnedWait = (key: string) => {
    const now = performance.now();
    const joined = ownedWaits.get(key);
    ownedWaits.delete(key);
    // Entries idle past the reuse window go. At 256, so do entries with no
    // open request, until the joining one fits; without any, the map grows.
    for (const [stale, candidate] of ownedWaits) {
      const idle = now - candidate.lastSeen;
      if (
        idle <= longestRequestMs ||
        (idle <= reuseMs && ownedWaits.size < 256)
      )
        break;
      ownedWaits.delete(stale);
    }
    const entry =
      joined && now - joined.lastSeen <= reuseMs
        ? joined
        : { since: now, lastSeen: now };
    entry.lastSeen = now;
    ownedWaits.set(key, entry);
    return entry;
  };
  const leaveOwnedWait = (
    key: string,
    entry: { since: number; lastSeen: number },
  ) => {
    if (ownedWaits.get(key) !== entry) return;
    ownedWaits.delete(key);
    entry.lastSeen = performance.now();
    ownedWaits.set(key, entry);
  };
  /** Identical selections under one credential share this hash. */
  const selectionKey = (
    credential: string,
    choice: { type: string; id: string; releaseId: string },
  ) =>
    createHash("sha256")
      .update(
        `${credential}\n${choice.type}\n${choice.id}\n${choice.releaseId}`,
      )
      .digest("hex");
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
    description: manifestDescriptions.personal,
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
  // Parsed as routing parses it, so dot segments cannot escape a link's limit.
  const personalRoute = (target = "/") => {
    const match = URL.canParse(target, origin)
      ? /^\/s\/([^/]+)\/([a-z]*)/.exec(new URL(target, origin).pathname)
      : null;
    // Status clips never contact Engine, and HLS players give up on a 4xx.
    if (
      !match?.[1] ||
      !credentialPattern.test(match[1]) ||
      match[2] === "notice"
    )
      return { media: false };
    return {
      credential: match[1],
      media: match[2] === "play" || match[2] === "status",
    };
  };
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'none'",
    );
    const controller = new AbortController();
    let lease: Lease | undefined;
    const route = personalRoute(request.url);
    // None of these contacts Engine. Refusing liveness would make ingress drop
    // the backend, and the Web player abandons playback when its HEAD probe of
    // the selected media fails.
    if (
      request.method !== "HEAD" &&
      request.method !== "OPTIONS" &&
      !(request.method === "GET" && request.url === "/health")
    ) {
      const admitted = admission.acquire(route.credential);
      if (typeof admitted === "string") {
        refuse(response, admitted, route.media);
        return;
      }
      lease = admitted;
    }
    controllers.add(controller);
    const requestDeadlineAt = Date.now() + 10_000;
    const expire = () => {
      controller.abort();
      json(response, 504, { error: "deadline_exceeded" });
    };
    let deadline = setTimeout(expire, 10_000);
    response.once("close", () => {
      clearTimeout(deadline);
      controllers.delete(controller);
      lease?.release();
      controller.abort();
    });
    request.once("aborted", () => controller.abort());
    const run = async <A, E extends { code: string }>(
      effect: Effect.Effect<A, E>,
      signal = controller.signal,
      deadlineAt = requestDeadlineAt,
    ) => {
      const result = await Effect.runPromise(
        effect.pipe(
          Effect.provideService(DiscoveryDeadline, deadlineAt),
          Effect.match({
            onSuccess: (value) => ({ ok: true as const, value }),
            onFailure: (error) => ({ ok: false as const, code: error.code }),
          }),
        ),
        { signal },
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
            logo: `${origin}/configure-assets/logo.png`,
            description: manifestDescriptions.public,
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
      const selection = createSelection({ base });
      const library = createLibrary(0n, true, {
        selectionUrl: selection.libraryUrl,
      });
      const discovery = createDiscovery();
      const playRoute =
        /^\/play\/(movie|series)\/([^/]+)\/([^/]+)\.(?:mp4|m3u8)$/.exec(path);
      // A season pack selection carries the episode it plays.
      const statusRoute =
        /^\/status\/([1-9][0-9]{0,18})(?:\/([1-9][0-9]{0,3})\/([1-9][0-9]{0,3}))?\.(?:mp4|m3u8)$/.exec(
          path,
        );
      const noticeRoute = /^\/notice\/([a-z-]+)\.(mp4|m3u8|ts)$/.exec(path);
      const noticeKind = statusMediaKinds.find(
        (kind) => kind === noticeRoute?.[1],
      );
      const noticeFormat = (["mp4", "m3u8", "ts"] as const).find(
        (format) => format === noticeRoute?.[2],
      );
      if (noticeKind && noticeFormat) {
        sendStatusMedia(
          request,
          response,
          statusMedia,
          noticeKind,
          noticeFormat,
        );
        return;
      }
      if (statusRoute?.[1] && BigInt(statusRoute[1]) > 9223372036854775807n)
        return fail("not_found");
      if (playRoute || statusRoute) {
        const hls = path.endsWith(".m3u8");
        // The pinned Web client's manifest request times out after 30 seconds,
        // redirects included, and then retries the selected URL, rejoining its
        // selection until the pending limit. Each HLS window ends before that,
        // even while the selection's submission runs on.
        const timing = hls
          ? { ...playbackWait, windowMs: playbackWait.hlsWindowMs }
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
        let choice: { type: string; id: string; releaseId: string } | undefined;
        if (playRoute?.[1] && playRoute[2] && playRoute[3]) {
          try {
            choice = {
              type: playRoute[1],
              id: decodeURIComponent(playRoute[2]),
              releaseId: decodeURIComponent(playRoute[3]),
            };
          } catch {
            return fail("invalid_request");
          }
        }
        const fileId = choice?.releaseId.startsWith(ownedPrefix)
          ? (ownedFileId(choice.releaseId) ?? fail("invalid_request"))
          : undefined;
        // Reads and polling stop when this window ends, as waiting for a new
        // submission does.
        const waiting = new AbortController();
        const windowEnd = setTimeout(() => waiting.abort(), timing.windowMs);
        const reading = AbortSignal.any([controller.signal, waiting.signal]);
        // A video already in the account needs no submission, transfer or
        // status URL. Its first read keeps the request deadline; while put.io
        // prepares it, an HLS selection waits out the window and continues at
        // its own URL until the pending limit.
        if (choice && fileId !== undefined) {
          const owned = { type: choice.type, id: choice.id, fileId };
          const key = selectionKey(credential, choice);
          const resolve = (signal?: AbortSignal) =>
            run(selection.owned(owned).pipe(Effect.provide(layer)), signal);
          let result: PlaybackResult;
          let waited: { since: number; lastSeen: number } | undefined;
          try {
            // Failing a waiting selection would end playback on a 4xx or
            // restart the wait on a 5xx, so a failed read holds the rest of
            // the window and the next window reads again. A continuation, or
            // the player's retry while the wait is remembered, already waits.
            let held = false;
            result = await resolve().catch((error: unknown) => {
              if (
                !hls ||
                !transient(error) ||
                (continuation === "0" && !liveOwnedWait(key))
              )
                throw error;
              held = true;
              return { status: "pending" } satisfies PlaybackResult;
            });
            if (hls && "status" in result && result.status === "pending") {
              // As for a download, the later deadline leaves room to redirect.
              clearTimeout(deadline);
              deadline = setTimeout(
                expire,
                requestDeadlineAt + timing.windowMs - Date.now(),
              );
              waited = joinOwnedWait(key);
              if (held) await aborted(reading);
              else
                result = await waitForPlayback(
                  result,
                  () =>
                    resolve(reading).catch(async (error: unknown) => {
                      if (!transient(error)) throw error;
                      await aborted(reading);
                      return { status: "pending" } satisfies PlaybackResult;
                    }),
                  reading,
                  { ...timing, pollMs: playbackWait.ownedPollMs },
                );
            }
          } catch (error) {
            if (rejected(error)) result = { status: "reconnect" };
            else if (
              waited &&
              waiting.signal.aborted &&
              !controller.signal.aborted
            )
              result = { status: "pending" };
            else throw error;
          } finally {
            clearTimeout(windowEnd);
            if (waited) leaveOwnedWait(key, waited);
          }
          if (response.destroyed || response.writableEnded) return;
          let location =
            "url" in result
              ? result.url
              : `${base}/notice/${result.status}.${hls ? "m3u8" : "mp4"}`;
          if ("status" in result && result.status === "pending") {
            if (
              waited &&
              Number(continuation) < playbackWait.continuations &&
              performance.now() - waited.since < pendingMs
            )
              location = `${base}${path}?wait=${Number(continuation) + 1}`;
            else {
              // Selecting the row again waits again.
              if (waited) waited.since = performance.now();
              location = `${base}/notice/preparing.${hls ? "m3u8" : "mp4"}`;
            }
          }
          response.writeHead(302, { Location: location }).end();
          return;
        }
        // The later deadline leaves room to redirect.
        clearTimeout(deadline);
        deadline = setTimeout(expire, timing.windowMs + 10_000);
        let transferId: bigint | undefined;
        let episode: SeasonEpisode | undefined;
        let result: PlaybackResult;
        let release = () => {};
        let selected: { waitingSince: number } | undefined;
        const inspect = (id: bigint) =>
          run(
            selection.status(id, episode).pipe(Effect.provide(layer)),
            reading,
          );
        try {
          if (choice) {
            const { type, id, releaseId } = choice;
            const key = selectionKey(credential, choice);
            let shared = submissions.get(key);
            if (!shared) {
              // The submission holds its own unit, so reconnecting clients
              // cannot run more Engine work for a link than its limit.
              const unit = admission.acquire(credential);
              if (typeof unit === "string") {
                refuse(response, unit, true);
                return;
              }
              // A running submission may have no open request between a
              // continuation and its follow-up, so only settled ones go.
              for (const [stale, candidate] of submissions)
                if (
                  submissions.size >= 256 &&
                  candidate.users === 0 &&
                  candidate.settled
                )
                  forget(stale);
              // The submission outlives any single client and window. An
              // interrupted submission may still have created the transfer.
              const signal = AbortSignal.any([
                shutdown.signal,
                AbortSignal.timeout(submissionBudgetMs),
              ]);
              const created = {
                submission: run(
                  selection
                    .submit({ type, id, releaseId })
                    .pipe(Effect.provide(layer)),
                  signal,
                  Date.now() + submissionBudgetMs,
                ).catch((error: unknown): Submission => {
                  if (signal.aborted) return { status: "unknown" };
                  throw error;
                }),
                users: 0,
                settled: false,
                failed: false,
                waitingSince: performance.now(),
              };
              created.submission.then(
                () => {
                  created.settled = true;
                  unit.release();
                },
                () => {
                  created.settled = true;
                  created.failed = true;
                  unit.release();
                  // A failure no client still waits on is not reused.
                  if (created.users === 0 && submissions.get(key) === created)
                    forget(key);
                },
              );
              shared = created;
              submissions.set(key, shared);
            }
            const entry = shared;
            selected = entry;
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
            // A window that ends first continues at this URL, which rejoins
            // the same submission.
            const submitted = await Promise.race([
              entry.submission,
              aborted(reading),
            ]);
            if (submitted === undefined) result = { status: "pending" };
            else if ("transferId" in submitted) {
              transferId = submitted.transferId;
              episode = submitted.episode;
              result = await inspect(transferId);
            } else result = submitted;
          } else {
            transferId = BigInt(statusRoute?.[1] ?? "0");
            if (statusRoute?.[2] && statusRoute[3])
              episode = {
                season: Number(statusRoute[2]),
                episode: Number(statusRoute[3]),
              };
            result = await inspect(transferId);
          }
          const polled = transferId;
          if (polled !== undefined)
            result = await waitForPlayback(
              result,
              () => inspect(polled),
              reading,
              timing,
            );
        } catch (error) {
          if (rejected(error)) result = { status: "reconnect" };
          // Search no longer lists the release, or its indexers failed.
          else if (
            hls &&
            playRoute &&
            transferId === undefined &&
            error instanceof HttpFailure &&
            (error.code === "not_found" || error.code === "unavailable")
          )
            result = { status: "release-unavailable" };
          else if (
            transferId !== undefined &&
            waiting.signal.aborted &&
            !controller.signal.aborted
          )
            result = { status: "pending" };
          else throw error;
        } finally {
          clearTimeout(windowEnd);
          release();
        }
        if (response.destroyed || response.writableEnded) return;
        if ("status" in result && result.status === "pending") {
          const exhausted = Number(continuation) >= playbackWait.continuations;
          if (
            hls &&
            (exhausted ||
              (selected !== undefined &&
                performance.now() - selected.waitingSince >= pendingMs))
          ) {
            if (selected) selected.waitingSince = performance.now();
            response
              .writeHead(302, { Location: `${base}/notice/pending.m3u8` })
              .end();
          } else if (exhausted) {
            response.setHeader("Retry-After", "5");
            json(response, 503, { error: "download_pending" });
          } else {
            const next =
              transferId === undefined
                ? `${base}${path}`
                : `${base}/status/${transferId}${episode ? `/${episode.season}/${episode.episode}` : ""}.${hls ? "m3u8" : "mp4"}`;
            response
              .writeHead(302, {
                Location: `${next}?wait=${Number(continuation) + 1}`,
              })
              .end();
          }
          return;
        }
        const location =
          "url" in result
            ? result.url
            : `${base}/notice/${result.status}.${hls ? "m3u8" : "mp4"}`;
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
        logo: `${origin}/configure-assets/logo.png`,
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
        // Undated discovery episodes omit `released`, which DefinitelyTyped requires.
        return { meta: result.meta as MetaDetail };
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
      const failed =
        error instanceof HttpFailure
          ? error.code
          : controller.signal.aborted
            ? "deadline_exceeded"
            : "unavailable";
      // HLS players give up on selected media after a 4xx; a 5xx they retry.
      const code =
        route.media && failed === "resource_exhausted" ? "unavailable" : failed;
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
        shutdown.abort();
        for (const controller of controllers) controller.abort();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })),
  };
}
