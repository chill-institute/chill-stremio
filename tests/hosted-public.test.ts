import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import * as proto from "@chill-institute/contracts/chill/v4/api_pb";
import { Schema } from "effect";
import { test } from "vite-plus/test";
import { startHostedAdapter } from "../src/hosted.ts";
import { manifestDescriptions } from "../src/manifest-descriptions.ts";
import { statusMediaKinds, statusPlaylist } from "../src/status-media.ts";

const harness = new URL("../harness/live/public.ts", import.meta.url);
const credential = `v4.local.${randomBytes(300).toString("base64url")}`;
const Receipt = Schema.Struct({
  passed: Schema.Boolean,
  steps: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      passed: Schema.Boolean,
      detail: Schema.optional(Schema.String),
    }),
  ),
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function runPublic(
  origin: string,
  presented: string,
  engineBaseUrl = origin,
) {
  const directory = await mkdtemp(join(tmpdir(), "hosted-public-"));
  try {
    const child = spawn(process.execPath, [fileURLToPath(harness)], {
      cwd: directory,
      env: {
        CHILL_PUBLIC_STREMIO_ORIGIN: origin,
        CHILL_ENGINE_BASE_URL: engineBaseUrl,
        CHILL_STREMIO_CREDENTIAL: presented,
      },
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => (output += String(chunk)));
    const [code] = await once(child, "close");
    const [run] = await readdir(join(directory, "artifacts"));
    assert.ok(run);
    const text = await readFile(
      join(directory, "artifacts", run, "results.json"),
      "utf8",
    );
    return {
      code,
      output,
      text,
      receipt: Schema.decodeUnknownSync(Receipt)(JSON.parse(text)),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const ownedName = "Night.of.the.Living.Dead.1968.1080p.WEB.mkv";

async function adapter(
  engine:
    | "accepting"
    | "rejecting"
    | "no-releases"
    | "no-season-grant"
    | "no-owned-grant",
) {
  const fake = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      response.setHeader("content-type", "application/json");
      if (
        engine === "rejecting" ||
        request.headers["x-chill-stremio-credential"] !== credential ||
        request.headers.authorization !== undefined
      ) {
        response.writeHead(401).end('{"code":"unauthenticated"}');
        return;
      }
      switch (request.url) {
        case "/chill.v4.UserService/GetFolder":
          assert.equal(
            fromJsonString(proto.GetFolderRequestSchema, body).id,
            0n,
          );
          response.end(
            toJsonString(
              proto.GetFolderResponseSchema,
              create(proto.GetFolderResponseSchema, {
                parent: { id: 0n, name: "Library", fileType: "FOLDER" },
                files: [{ id: 50n, name: "Library video", fileType: "VIDEO" }],
              }),
            ),
          );
          return;
        case "/chill.v4.UserService/GetMovies":
          response.end(
            toJsonString(
              proto.GetMoviesResponseSchema,
              create(proto.GetMoviesResponseSchema, {
                movies: [
                  {
                    id: "reference-movie",
                    externalUrl: "https://www.imdb.com/title/tt0133093/",
                    title: "Reference movie",
                    year: 1999,
                  },
                ],
              }),
            ),
          );
          return;
        case "/chill.v4.UserService/GetTVShowDetail":
          response.end(
            toJsonString(
              proto.GetTVShowDetailResponseSchema,
              create(proto.GetTVShowDetailResponseSchema, {
                show: { imdbId: "tt0903747", title: "Reference series" },
                seasons: [{ seasonNumber: 1 }],
              }),
            ),
          );
          return;
        case "/chill.v4.UserService/GetTVShowSeason":
          response.end(
            toJsonString(
              proto.GetTVShowSeasonResponseSchema,
              create(proto.GetTVShowSeasonResponseSchema, {
                imdbId: "tt0903747",
                seasonNumber: 1,
                episodes: [
                  { seasonNumber: 1, episodeNumber: 1, name: "Pilot" },
                ],
              }),
            ),
          );
          return;
        case "/chill.v4.UserService/GetTVShowSeasonDownloads":
          assert.deepEqual(
            fromJsonString(proto.GetTVShowSeasonDownloadsRequestSchema, body),
            create(proto.GetTVShowSeasonDownloadsRequestSchema, {
              imdbId: "tt0903747",
              seasonNumber: 1,
            }),
          );
          if (engine === "no-season-grant") {
            response
              .writeHead(403)
              .end(
                '{"code":"procedure_not_allowed","message":"procedure not allowed for this credential"}',
              );
            return;
          }
          response.end("{}");
          return;
        case "/chill.v4.UserService/FindOwnedVideos": {
          const { title, year } = fromJsonString(
            proto.FindOwnedVideosRequestSchema,
            body,
          );
          if (engine === "no-owned-grant") {
            response
              .writeHead(403)
              .end(
                '{"code":"procedure_not_allowed","message":"procedure not allowed for this credential"}',
              );
            return;
          }
          response.end(
            toJsonString(
              proto.FindOwnedVideosResponseSchema,
              create(proto.FindOwnedVideosResponseSchema, {
                videos:
                  title === "Night of the Living Dead" && year === 1968
                    ? [{ id: 4242n, name: ownedName, fileType: "VIDEO" }]
                    : [],
              }),
            ),
          );
          return;
        }
        case "/chill.v4.UserService/Search": {
          const { query } = fromJsonString(proto.UserSearchRequestSchema, body);
          response.end(
            toJsonString(
              proto.SearchResponseSchema,
              create(proto.SearchResponseSchema, {
                query,
                results:
                  engine === "no-releases"
                    ? []
                    : [
                        {
                          id: "reference-release",
                          title: "Reference.Movie.1999.1080p",
                          indexer: "Fixture",
                          link: "https://engine.fixture.test/reference.torrent",
                          size: 12345n,
                          seeders: 3n,
                        },
                      ],
              }),
            ),
          );
          return;
        }
        default:
          response.writeHead(404).end('{"code":"not_found"}');
      }
    })();
  });
  const engineBaseUrl = await listen(fake);
  const hosted = await startHostedAdapter({
    statusMedia: new Map(
      statusMediaKinds.map((kind) => [
        kind,
        {
          mp4: Buffer.from("fixture-status-video"),
          m3u8: Buffer.from(statusPlaylist(kind)),
          ts: Buffer.alloc(188 * 2, 0x47),
        },
      ]),
    ),
    engineBaseUrl,
    webOrigin: "http://127.0.0.1:3000",
  });
  return {
    origin: hosted.origin,
    engineBaseUrl,
    async close() {
      await hosted.close();
      await close(fake);
    },
  };
}

for (const [engine, failedStep, outcome] of [
  ["accepting", undefined, "an accepting Engine passes"],
  ["rejecting", "library", "a rejecting Engine fails at library"],
  ["no-releases", "standard-title", "no releases fails at standard-title"],
  [
    "no-season-grant",
    "season-downloads",
    "no season lookup grant fails at season-downloads",
  ],
  [
    "no-owned-grant",
    "owned-videos",
    "no owned-video lookup grant fails at owned-videos",
  ],
] as const) {
  test(`public check with ${outcome} and records no credential`, async () => {
    const hosted = await adapter(engine);
    try {
      const run = await runPublic(
        hosted.origin,
        credential,
        hosted.engineBaseUrl,
      );
      assert.equal(run.code, failedStep ? 1 : 0);
      assert.equal(run.receipt.passed, !failedStep);
      assert.equal(
        run.receipt.steps.find((step) => !step.passed)?.name,
        failedStep,
      );
      for (const text of [run.text, run.output])
        for (const secret of ["v4.local.", ownedName, "4242"])
          assert.ok(!text.includes(secret), secret);
      if (!failedStep)
        assert.deepEqual(run.receipt.steps.at(-1), {
          name: "owned-videos",
          passed: true,
          detail: "videos 1",
        });
    } finally {
      await hosted.close();
    }
  });
}

test("public check fails at configuration without a credential", async () => {
  const hosted = await adapter("accepting");
  try {
    for (const presented of ["", "  ", "not-a-credential"]) {
      const run = await runPublic(
        hosted.origin,
        presented,
        hosted.engineBaseUrl,
      );
      assert.equal(run.code, 1);
      assert.deepEqual(run.receipt.steps, [
        {
          name: "configuration",
          passed: false,
          detail: "designated add-on credential absent",
        },
      ]);
    }
  } finally {
    await hosted.close();
  }
});

test("public check redacts credential material an endpoint echoes back", async () => {
  const echo = createServer((request, response) => {
    if (request.url === "/manifest.json") {
      response.end(
        JSON.stringify({
          behaviorHints: { configurationRequired: true },
          description: manifestDescriptions.public,
        }),
      );
      return;
    }
    // A non-JSON personal manifest puts the echoed credential into the parse error.
    response.end(request.url?.slice("/s/".length) ?? "");
  });
  const origin = await listen(echo);
  try {
    const run = await runPublic(origin, credential);
    assert.equal(run.code, 1);
    assert.equal(run.receipt.steps.at(-1)?.name, "unexpected");
    for (const text of [run.text, run.output])
      assert.ok(!text.includes("v4.local."));
  } finally {
    await close(echo);
  }
});

test("public check fails when a deployed manifest carries other copy", async () => {
  for (const [stale, failedStep] of [
    ["public", "public-manifest"],
    ["personal", "manifest"],
  ] as const) {
    const copy = { ...manifestDescriptions, [stale]: "Early access." };
    const deployed = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/manifest.json"
            ? {
                behaviorHints: { configurationRequired: true },
                description: copy.public,
              }
            : { description: copy.personal },
        ),
      );
    });
    const origin = await listen(deployed);
    try {
      const run = await runPublic(origin, credential);
      assert.equal(run.code, 1);
      assert.deepEqual(run.receipt.steps.at(-1), {
        name: failedStep,
        passed: false,
        detail: "description differs from this checkout",
      });
    } finally {
      await close(deployed);
    }
  }
});

test("public check loads only Node built-ins and package-free repo modules", async () => {
  const pending = [harness];
  const seen = new Set<string>();
  for (let file = pending.pop(); file; file = pending.pop()) {
    if (seen.has(file.href)) continue;
    seen.add(file.href);
    const source = await readFile(file, "utf8");
    for (const [, specifier = ""] of source.matchAll(
      /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g,
    )) {
      if (specifier.startsWith("node:")) continue;
      assert.match(specifier, /^\.\.?\//, `${file.pathname}: ${specifier}`);
      pending.push(new URL(specifier, file));
    }
  }
  assert.ok(seen.size > 1);
});
