import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { attachStreamHandler, Sources } from "../src/addon.ts";
import sdk, {
  type Manifest,
  type Stream,
  type MetaDetail,
} from "stremio-addon-sdk";

export const manifest: Manifest = {
  id: "institute.chill.fixture",
  version: "0.1.0",
  name: "Chill Fixture",
  description: "Self-generated, credential-free playback fixtures.",
  resources: ["catalog", "meta", "stream", "subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["fixture:"],
  catalogs: [
    {
      type: "movie",
      id: "fixture-movies",
      name: "Fixture Movies",
      extra: [{ name: "search", isRequired: false }],
    },
    {
      type: "series",
      id: "fixture-series",
      name: "Fixture Series",
      extra: [{ name: "search", isRequired: false }],
    },
  ],
};
export class FixtureError extends Schema.TaggedError<FixtureError>()(
  "FixtureError",
  {
    cause: Schema.Defect(),
  },
) {}
export interface Fixture {
  origin: string;
  metrics: {
    requests: number;
    streamRequests: number;
    mediaRequests: number;
    failures: number;
    interruptedBytes: number;
    interruptedCuts: number;
    interruptedActive: number;
    interruptedTimeouts: number;
    searches: string[];
  };
  close(): Promise<void>;
  setPending(pending: boolean): void;
  reset(): void;
  prepareInterruption(): { arm(): void; cancel(): void };
}
export async function startFixtureServer(
  options: { mediaDir?: string; port?: number } = {},
): Promise<Fixture> {
  const directory = resolve(options.mediaDir ?? ".cache/media");
  const metrics = {
    requests: 0,
    streamRequests: 0,
    mediaRequests: 0,
    failures: 0,
    interruptedBytes: 0,
    interruptedCuts: 0,
    interruptedActive: 0,
    interruptedTimeouts: 0,
    searches: [] as string[],
  };
  const interruptions = new Set<(cut: boolean) => void>();
  let interruption:
    | { armed: boolean; deadline: ReturnType<typeof setTimeout> }
    | undefined;
  const cancelInterruption = () => {
    if (interruption) clearTimeout(interruption.deadline);
    interruption = undefined;
    for (const finish of interruptions) finish(false);
  };
  let pending = false;
  let origin = "";
  const builder = new sdk.addonBuilder(manifest);
  const subtitles = () => [
    { id: "fixture-english", lang: "eng", url: `${origin}/media/english.vtt` },
    { id: "fixture-spanish", lang: "spa", url: `${origin}/media/spanish.vtt` },
  ];
  const movie = (): MetaDetail & {
    behaviorHints: { defaultVideoId: string };
  } => ({
    id: "fixture:movie",
    type: "movie",
    name: "Fixture Movie",
    description: "Generated movie with visible frame markers and audio.",
    poster: `${origin}/poster.svg`,
    behaviorHints: { defaultVideoId: "fixture:movie" },
  });
  const series = (): MetaDetail => ({
    id: "fixture:series",
    type: "series",
    name: "Fixture Series",
    poster: `${origin}/poster.svg`,
    description: "Two numbered generated episodes.",
    videos: [1, 2].map((episode) => ({
      id: `fixture:series:1:${episode}`,
      title: `Fixture Episode ${episode}`,
      season: 1,
      episode,
      released: "2026-01-01T00:00:00.000Z",
    })),
  });
  builder.defineCatalogHandler(async ({ type, id, extra }) => {
    if (
      (type !== "movie" || id !== "fixture-movies") &&
      (type !== "series" || id !== "fixture-series")
    )
      return { metas: [] };
    if (extra.search) metrics.searches.push(extra.search);
    return {
      metas: [type === "movie" ? movie() : series()].filter(
        (meta) =>
          !extra.search ||
          meta.name.toLowerCase().includes(extra.search.toLowerCase()),
      ),
      cacheMaxAge: 0,
    };
  });
  builder.defineMetaHandler(async ({ type, id }) => {
    if (type === "movie" && id === "fixture:movie") return { meta: movie() };
    if (type === "series" && id === "fixture:series") return { meta: series() };
    throw Object.assign(new Error("Unknown fixture"), { noHandler: true });
  });
  const bridge = attachStreamHandler(
    builder,
    Layer.succeed(
      Sources,
      Sources.of({
        streams: Effect.fn("Fixture.streams")(function* ({ type, id }) {
          metrics.streamRequests++;
          const file =
            type === "movie" && id === "fixture:movie"
              ? "movie"
              : type === "series" && id === "fixture:series:1:1"
                ? "episode1"
                : type === "series" && id === "fixture:series:1:2"
                  ? "episode2"
                  : undefined;
          if (!file) return [];
          if (pending) {
            pending = false;
            return [];
          }
          const streams: Stream[] = [
            { name: "Direct fixture", url: `${origin}/media/${file}.mp4` },
            { name: "Pending fixture", url: `${origin}/failure/pending.mp4` },
            {
              name: "Unavailable fixture",
              url: `${origin}/failure/unavailable.mp4`,
            },
            { name: "Expired fixture", url: `${origin}/failure/expired.mp4` },
            {
              name: "Interrupted fixture",
              url: `${origin}/failure/interrupted.mp4`,
            },
          ].map((stream) => ({
            ...stream,
            subtitles: subtitles(),
            behaviorHints: { bingeGroup: "fixture", notWebReady: false },
          }));
          return streams;
        }),
      }),
    ),
  );
  builder.defineSubtitlesHandler(async ({ type, id }) => ({
    subtitles:
      (type === "movie" && id === "fixture:movie") ||
      (type === "series" &&
        ["fixture:series:1:1", "fixture:series:1:2"].includes(id))
        ? subtitles()
        : [],
  }));
  const router = sdk.getRouter(builder.getInterface());
  async function handle(request: IncomingMessage, response: ServerResponse) {
    metrics.requests++;
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Range");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Range,Accept-Ranges,Content-Length",
    );
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    try {
      decodeURIComponent(path);
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }
    if (path === "/poster.svg") {
      response.setHeader("Content-Type", "image/svg+xml");
      response.end(
        '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#2040d0"/><text x="30" y="220" fill="white" font-size="32">Chill Fixture</text></svg>',
      );
      return;
    }
    if (path.startsWith("/failure/")) {
      metrics.failures++;
      if (path === "/failure/interrupted.mp4") {
        const file = join(directory, "movie.mp4");
        const info = await stat(file);
        response.writeHead(200, {
          "Content-Type": "video/mp4",
          "Content-Length": info.size,
        });
        if (request.method === "HEAD") {
          response.end();
          return;
        }
        if (response.destroyed) return;
        const stream = createReadStream(file, {
          start: 0,
          end: Math.floor(info.size / 3),
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (cut: boolean) => {
          if (!interruptions.delete(finish)) return;
          clearTimeout(timer);
          metrics.interruptedActive--;
          if (cut && !response.destroyed) metrics.interruptedCuts++;
          stream.destroy();
          response.destroy();
        };
        interruptions.add(finish);
        metrics.interruptedActive++;
        response.once("close", () => finish(false));
        stream.on("data", (data: Buffer) => {
          metrics.interruptedBytes += data.length;
        });
        stream.on("error", () => finish(false));
        stream.pipe(response, { end: false });
        if (interruption?.armed) finish(true);
        else if (!interruption) timer = setTimeout(() => finish(true), 4000);
        return;
      }
      response.writeHead(
        path.endsWith("expired.mp4")
          ? 410
          : path.endsWith("pending.mp4")
            ? 503
            : 404,
      );
      response.end();
      return;
    }
    if (path.startsWith("/media/")) {
      const filename = path.slice("/media/".length);
      if (
        ![
          "movie.mp4",
          "episode1.mp4",
          "episode2.mp4",
          "english.vtt",
          "spanish.vtt",
        ].includes(filename)
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      const file = join(directory, filename);
      const info = await stat(file);
      metrics.mediaRequests++;
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader(
        "Content-Type",
        filename.endsWith(".vtt") ? "text/vtt; charset=utf-8" : "video/mp4",
      );
      let start = 0;
      let end = info.size - 1;
      if (request.headers.range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        if (!match || (!match[1] && !match[2])) {
          response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
          response.end();
          return;
        }
        if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
        else {
          start = Number(match[1]);
          if (match[2]) end = Math.min(end, Number(match[2]));
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= info.size
        ) {
          response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
          response.end();
          return;
        }
        response.statusCode = 206;
        response.setHeader(
          "Content-Range",
          `bytes ${start}-${end}/${info.size}`,
        );
      }
      response.setHeader("Content-Length", end - start + 1);
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(file, { start, end });
      response.once("close", () => stream.destroy());
      stream.on("error", () => response.destroy());
      stream.pipe(response);
      return;
    }
    router(request, response, () => {
      if (!response.writableEnded) {
        response.writeHead(404);
        response.end();
      }
    });
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", resolve);
    });
  } catch (error) {
    await bridge.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Missing fixture listener");
  }
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    metrics,
    close: async () => {
      cancelInterruption();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
      await bridge.close();
    },
    setPending: (value) => {
      pending = value;
    },
    prepareInterruption: () => {
      if (interruption || interruptions.size)
        throw new Error("An interruption is already active");
      const session = {
        armed: false,
        deadline: setTimeout(() => {
          metrics.interruptedTimeouts++;
          session.armed = true;
          for (const finish of interruptions) finish(true);
        }, 35000),
      };
      interruption = session;
      return {
        arm: () => {
          if (interruption !== session || session.armed)
            throw new Error(
              "Interruption is cancelled, expired or already armed",
            );
          if (!interruptions.size)
            throw new Error("No active media response to interrupt");
          clearTimeout(session.deadline);
          session.armed = true;
          for (const finish of interruptions) finish(true);
        },
        cancel: () => {
          if (interruption === session) cancelInterruption();
        },
      };
    },
    reset: () => {
      cancelInterruption();
      pending = false;
      metrics.requests = 0;
      metrics.streamRequests = 0;
      metrics.mediaRequests = 0;
      metrics.failures = 0;
      metrics.interruptedBytes = 0;
      metrics.interruptedCuts = 0;
      metrics.interruptedTimeouts = 0;
      metrics.searches.length = 0;
    },
  };
}
export const startFixture = Effect.fn("startFixture")(function* (
  options: { mediaDir?: string; port?: number } = {},
) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => startFixtureServer(options),
      catch: (cause) => new FixtureError({ cause }),
    }),
    (fixture) => Effect.promise(() => fixture.close()),
  );
});
