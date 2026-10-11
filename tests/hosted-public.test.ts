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

async function runPublic(origin: string, presented: string) {
  const directory = await mkdtemp(join(tmpdir(), "hosted-public-"));
  try {
    const child = spawn(process.execPath, [fileURLToPath(harness)], {
      cwd: directory,
      env: {
        CHILL_PUBLIC_STREMIO_ORIGIN: origin,
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

async function adapter(engine: "accepting" | "rejecting" | "no-releases") {
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
    engineBaseUrl: await listen(fake),
    webOrigin: "http://127.0.0.1:3000",
  });
  return {
    origin: hosted.origin,
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
] as const) {
  test(`public check with ${outcome} and records no credential`, async () => {
    const hosted = await adapter(engine);
    try {
      const run = await runPublic(hosted.origin, credential);
      assert.equal(run.code, failedStep ? 1 : 0);
      assert.equal(run.receipt.passed, !failedStep);
      assert.equal(
        run.receipt.steps.find((step) => !step.passed)?.name,
        failedStep,
      );
      for (const text of [run.text, run.output])
        assert.ok(!text.includes("v4.local."));
    } finally {
      await hosted.close();
    }
  });
}

test("public check fails at configuration without a credential", async () => {
  const hosted = await adapter("accepting");
  try {
    for (const presented of ["", "  ", "not-a-credential"]) {
      const run = await runPublic(hosted.origin, presented);
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
      response.end('{"behaviorHints":{"configurationRequired":true}}');
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
