import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Schema } from "effect";
import { manifest, type Fixture } from "./fixture.ts";

const require = createRequire(import.meta.url);
const LintResult = Schema.Struct({
  valid: Schema.Boolean,
  errors: Schema.Array(Schema.Unknown),
});
const Metas = Schema.Struct({
  metas: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String }),
  ),
});
const Streams = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({ name: Schema.String, url: Schema.String }),
  ),
});
const Episodes = Schema.Struct({
  meta: Schema.Struct({
    videos: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        season: Schema.Number,
        episode: Schema.Number,
      }),
    ),
  }),
});
// The official CommonJS packages expose no TypeScript definitions; validate their responses at this boundary.
interface OfficialClient {
  get(
    resource: string,
    type: string,
    id: string,
    extra?: Record<string, string>,
  ): Promise<unknown>;
}
interface ClientPackage {
  fromDescriptor(descriptor: {
    manifest: unknown;
    transportUrl: string;
  }): OfficialClient;
}
interface LinterPackage {
  lintManifest(value: unknown): unknown;
}
const clientPackage: ClientPackage = require("stremio-addon-client");
const linter: LinterPackage = require("stremio-addon-linter");
export interface ProtocolResult {
  name: string;
  status: "passed";
  evidence: Record<string, unknown>;
}
export async function verifyProtocol(
  fixture: Fixture,
): Promise<ProtocolResult[]> {
  const results: ProtocolResult[] = [];
  const lint = Schema.decodeUnknownSync(LintResult)(
    linter.lintManifest(manifest),
  );
  assert.equal(lint.valid, true, JSON.stringify(lint.errors));
  results.push({
    name: "official-manifest-linter",
    status: "passed",
    evidence: { version: "1.7.0" },
  });
  const request = (path: string, init?: RequestInit) =>
    fetch(`${fixture.origin}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5000),
    });
  const manifestResponse = await request("/manifest.json");
  assert.equal(
    manifestResponse.headers.get("access-control-allow-origin"),
    "*",
  );
  assert.equal(manifestResponse.status, 200);
  const preflight = await request("/media/movie.mp4", {
    method: "OPTIONS",
    headers: {
      Origin: "http://127.0.0.1:9999",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "Range",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
  assert.match(
    preflight.headers.get("access-control-allow-methods") ?? "",
    /GET/,
  );
  assert.match(
    preflight.headers.get("access-control-allow-headers") ?? "",
    /Range/,
  );
  assert.equal((await request("/stream/movie/%E0%A4%A.json")).status, 400);
  const missingSubtitles = await request("/subtitles/movie/unknown.json");
  assert.deepEqual(await missingSubtitles.json(), { subtitles: [] });
  const client = clientPackage.fromDescriptor({
    manifest: await manifestResponse.json(),
    transportUrl: `${fixture.origin}/manifest.json`,
  });
  const movies = Schema.decodeUnknownSync(Metas)(
    await client.get("catalog", "movie", "fixture-movies"),
  );
  assert.equal(movies.metas[0]?.id, "fixture:movie");
  const episodes = Schema.decodeUnknownSync(Episodes)(
    await client.get("meta", "series", "fixture:series"),
  );
  assert.deepEqual(
    episodes.meta.videos.map(({ season, episode }) => [season, episode]),
    [
      [1, 1],
      [1, 2],
    ],
  );
  await client.get("catalog", "movie", "fixture-movies", {
    search: "A & B / café",
  });
  assert.equal(fixture.metrics.searches.at(-1), "A & B / café");
  results.push({
    name: "official-client-routing",
    status: "passed",
    evidence: {
      version: "1.16.1",
      movieCount: movies.metas.length,
      episodes: episodes.meta.videos.map(({ id }) => id),
      encodedSearch: true,
      malformedEncoding: 400,
      unsupportedSubtitles: "empty",
      cors: true,
      corsPreflight: 204,
    },
  });
  for (const path of [
    "/stream/movie/unknown.json",
    "/stream/movie/fixture%3Aseries%3A1%3A1.json",
    "/stream/series/fixture%3Amovie.json",
  ]) {
    const response = await request(path);
    assert.equal(response.status, 200);
    assert.equal(
      Schema.decodeUnknownSync(Streams)(await response.json()).streams.length,
      0,
    );
  }
  assert.equal((await request("/meta/movie/unknown.json")).status, 404);
  assert.equal(
    (await request("/unsupported/movie/fixture%3Amovie.json")).status,
    404,
  );
  const streams = Schema.decodeUnknownSync(Streams)(
    await client.get("stream", "movie", "fixture:movie"),
  );
  assert.equal(streams.streams.length, 5);
  for (const id of ["fixture:series:1:1", "fixture:series:1:2"])
    assert.equal(
      Schema.decodeUnknownSync(Streams)(
        await client.get("stream", "series", id),
      ).streams.length,
      5,
    );
  fixture.setPending(true);
  assert.equal(
    Schema.decodeUnknownSync(Streams)(
      await client.get("stream", "movie", "fixture:movie"),
    ).streams.length,
    0,
  );
  assert.equal(
    Schema.decodeUnknownSync(Streams)(
      await client.get("stream", "movie", "fixture:movie"),
    ).streams.length,
    5,
  );
  results.push({
    name: "ids-pending-retry",
    status: "passed",
    evidence: {
      unsupportedIds: "empty",
      unsupportedMeta: 404,
      pendingAttempts: 2,
    },
  });
  const head = await request("/media/movie.mp4", { method: "HEAD" });
  const length = Number(head.headers.get("content-length"));
  assert.ok(length > 10000);
  for (const [range, bytes] of [
    ["bytes=0-31", 32],
    ["bytes=-32", 32],
  ] as const) {
    const response = await request("/media/movie.mp4", {
      headers: { Range: range },
    });
    assert.equal(response.status, 206);
    assert.equal((await response.arrayBuffer()).byteLength, bytes);
  }
  assert.equal(
    (
      await request("/media/movie.mp4", {
        headers: { Range: "bytes=999999999-" },
      })
    ).status,
    416,
  );
  assert.equal(
    (await request("/media/movie.mp4", { headers: { Range: "bytes=1-2,4-5" } }))
      .status,
    416,
  );
  assert.equal((await request("/media/nope.mp4")).status, 404);
  assert.equal(
    (await request("/failure/interrupted.mp4", { method: "HEAD" })).status,
    200,
  );
  const failuresBefore = fixture.metrics.failures;
  assert.equal((await request("/failure/pending.mp4")).status, 503);
  assert.equal((await request("/failure/unavailable.mp4")).status, 404);
  assert.equal((await request("/failure/expired.mp4")).status, 410);
  await assert.rejects(async () => {
    const response = await request("/failure/interrupted.mp4");
    await response.arrayBuffer();
  });
  assert.equal(
    fixture.metrics.failures - failuresBefore,
    4,
    "Each failure gets one bounded attempt",
  );
  assert.ok(fixture.metrics.interruptedBytes > 0);
  assert.ok(fixture.metrics.interruptedCuts > 0);
  const recovered = await request("/media/movie.mp4", {
    headers: { Range: "bytes=0-31" },
  });
  assert.equal(recovered.status, 206);
  assert.equal((await recovered.arrayBuffer()).byteLength, 32);
  for (const language of ["english", "spanish"]) {
    const response = await request(`/media/${language}.vtt`);
    assert.match(response.headers.get("content-type") ?? "", /text\/vtt/);
    assert.match(await response.text(), /^WEBVTT/);
  }
  results.push({
    name: "media-range-and-failure-recovery",
    status: "passed",
    evidence: {
      head: true,
      byteRange: true,
      suffixRange: true,
      invalidRange: 416,
      unavailable: 404,
      expired: 410,
      pending: 503,
      interrupted: "connection-closed",
      attemptsPerFailure: 1,
      interruptedBytes: fixture.metrics.interruptedBytes,
      recovered: 206,
      subtitles: 2,
    },
  });
  return results;
}
