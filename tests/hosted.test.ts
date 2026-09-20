import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import * as proto from "@chill-institute/contracts/chill/v4/api_pb";
import { Schema } from "effect";
import { test } from "vite-plus/test";
import { startHostedAdapter } from "../src/hosted.ts";
import { InstallationStore } from "../src/installations.ts";
import { statusMessages, type StatusMediaKind } from "../src/status-media.ts";
import { discoveryTargetId } from "../src/discovery.ts";

const statusMedia = new Map(
  (Object.keys(statusMessages) as StatusMediaKind[]).map((kind) => [
    kind,
    Buffer.from("fixture-status-video"),
  ]),
);
const webOrigin = "http://127.0.0.1:3000";
const ownerToken = "fixture-owner-a";
const otherToken = "fixture-owner-b";
const target = discoveryTargetId({ kind: "movie", id: "fixture-film" });
const View = Schema.Struct({
  id: Schema.String,
  folderId: Schema.String,
  manifestUrl: Schema.String,
});
const Operation = Schema.Struct({
  id: Schema.String,
  state: Schema.String,
  transferId: Schema.optional(Schema.String),
});
const Videos = Schema.Struct({
  files: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      stremioId: Schema.String,
    }),
  ),
});
const Catalog = Schema.Struct({
  metas: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String }),
  ),
});
const Streams = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      url: Schema.optional(Schema.String),
      externalUrl: Schema.optional(Schema.String),
    }),
  ),
});
async function decode<A, I>(
  response: Response,
  schema: Schema.Codec<A, I>,
): Promise<A> {
  const value: unknown = await response.json();
  return Schema.decodeUnknownSync(schema)(value);
}

async function fixture() {
  const calls: { method: string; owner: string }[] = [];
  const searches: string[] = [];
  const state = {
    invalidRootFolder: false,
    loseTransferResponse: false,
    stallMovies: false,
    acquiredVisible: true,
    addCount: 0,
    transferFinished: true,
    singleFile: false,
    playbackPending: false,
    historicalTransferError: { status: 404, code: "not_found" },
  };
  const error = (response: ServerResponse, status: number, code: string) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ code, message: "fixture error" }));
  };
  const engine = createServer((request, response) => {
    void (async () => {
      const auth = request.headers.authorization;
      const owner =
        auth === `Bearer ${ownerToken}`
          ? "101"
          : auth === `Bearer ${otherToken}`
            ? "202"
            : undefined;
      if (!owner) {
        error(response, 401, "unauthenticated");
        return;
      }
      const method = request.url?.split("/").at(-1) ?? "";
      calls.push({ method, owner });
      assert.equal(request.method, "POST");
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const json = Buffer.concat(chunks).toString("utf8");
      response.setHeader("content-type", "application/json");
      switch (method) {
        case "GetUserProfile":
          fromJsonString(proto.GetUserProfileRequestSchema, json);
          response.end(
            toJsonString(
              proto.UserProfileSchema,
              create(proto.UserProfileSchema, {
                userId: owner,
                email: "private@fixture.test",
              }),
            ),
          );
          return;
        case "GetFolder": {
          const { id } = fromJsonString(proto.GetFolderRequestSchema, json);
          if (id === 0n && state.invalidRootFolder) {
            response.end("{}");
            return;
          }
          const files =
            id === 0n
              ? [{ id: 42n, name: "Nested library", fileType: "FOLDER" }]
              : id === 42n
                ? [{ id: 50n, name: "Existing video", fileType: "VIDEO" }]
                : id === 10n
                  ? [
                      {
                        id: 20n,
                        name: "Acquired film folder",
                        fileType: "FOLDER",
                      },
                      { id: 99n, name: "Unrelated video", fileType: "VIDEO" },
                    ]
                  : id === 20n
                    ? state.acquiredVisible
                      ? [
                          { id: 21n, name: "First video", fileType: "VIDEO" },
                          ...(state.singleFile
                            ? []
                            : [
                                {
                                  id: 22n,
                                  name: "Second video",
                                  fileType: "VIDEO",
                                },
                              ]),
                        ]
                      : []
                    : undefined;
          if (!files) {
            error(response, 404, "not_found");
            return;
          }
          response.end(
            toJsonString(
              proto.GetFolderResponseSchema,
              create(proto.GetFolderResponseSchema, {
                parent: { id, name: "Fixture folder", fileType: "FOLDER" },
                files,
              }),
            ),
          );
          return;
        }
        case "GetMovies":
          if (state.stallMovies) {
            response.writeHead(200);
            response.write("{");
            return;
          }
          fromJsonString(proto.GetMoviesRequestSchema, json);
          response.end(
            toJsonString(
              proto.GetMoviesResponseSchema,
              create(proto.GetMoviesResponseSchema, {
                movies: [
                  {
                    id: "fixture-film",
                    externalUrl: "https://www.imdb.com/title/tt1234567/",
                    title: "Independent film",
                    year: 2024,
                    overview: "Fixture overview",
                    posterUrl: "https://images.fixture.test/poster.jpg",
                  },
                ],
              }),
            ),
          );
          return;
        case "GetTVShowDetail": {
          const { imdbId } = fromJsonString(
            proto.GetTVShowDetailRequestSchema,
            json,
          );
          response.end(
            toJsonString(
              proto.GetTVShowDetailResponseSchema,
              create(proto.GetTVShowDetailResponseSchema, {
                show: { imdbId, title: "Independent series", year: 2024 },
                seasons: [{ seasonNumber: 1 }],
              }),
            ),
          );
          return;
        }
        case "GetTVShowSeason": {
          const { imdbId, seasonNumber } = fromJsonString(
            proto.GetTVShowSeasonRequestSchema,
            json,
          );
          response.end(
            toJsonString(
              proto.GetTVShowSeasonResponseSchema,
              create(proto.GetTVShowSeasonResponseSchema, {
                imdbId,
                seasonNumber,
                episodes: [
                  { seasonNumber, episodeNumber: 2, name: "Episode two" },
                ],
              }),
            ),
          );
          return;
        }
        case "Search": {
          const { query } = fromJsonString(proto.UserSearchRequestSchema, json);
          searches.push(query);
          response.end(
            toJsonString(
              proto.SearchResponseSchema,
              create(proto.SearchResponseSchema, {
                query,
                results: [
                  {
                    id: "fixture-release",
                    title: "Independent.Film.1080p",
                    indexer: "Fixture",
                    link: "https://engine.fixture.test/download?token=fixture-release-secret",
                    size: 12345n,
                    seeders: 3n,
                  },
                ],
              }),
            ),
          );
          return;
        }
        case "AddTransfer": {
          const { url } = fromJsonString(proto.AddTransferRequestSchema, json);
          assert.equal(
            url,
            "https://engine.fixture.test/download?token=fixture-release-secret",
          );
          state.addCount++;
          if (state.loseTransferResponse) {
            response.destroy();
            return;
          }
          response.end(
            toJsonString(
              proto.AddTransferResponseSchema,
              create(proto.AddTransferResponseSchema, {
                status: "success",
                transfer: {
                  id: 90n,
                  status: state.transferFinished ? "COMPLETED" : "DOWNLOADING",
                  isFinished: state.transferFinished,
                  percentDone: state.transferFinished ? 100 : 42,
                  fileId: 20n,
                  saveParentId: 10n,
                },
              }),
            ),
          );
          return;
        }
        case "GetTransfer": {
          const { id } = fromJsonString(proto.GetTransferRequestSchema, json);
          if (id !== 90n) {
            error(
              response,
              state.historicalTransferError.status,
              state.historicalTransferError.code,
            );
            return;
          }
          response.end(
            toJsonString(
              proto.GetTransferResponseSchema,
              create(proto.GetTransferResponseSchema, {
                transfer: {
                  id,
                  status: state.transferFinished ? "COMPLETED" : "DOWNLOADING",
                  isFinished: state.transferFinished,
                  percentDone: state.transferFinished ? 100 : 42,
                  fileId: 20n,
                  saveParentId: 10n,
                },
              }),
            ),
          );
          return;
        }
        case "ResolvePlayback": {
          const { fileId } = fromJsonString(
            proto.ResolvePlaybackRequestSchema,
            json,
          );
          assert.ok([21n, 22n, 50n].includes(fileId));
          if (state.playbackPending) {
            response.end(
              JSON.stringify({
                pending: { reason: "PENDING_REASON_PROCESSING" },
              }),
            );
            return;
          }
          response.end(
            toJsonString(
              proto.ResolvePlaybackResponseSchema,
              create(proto.ResolvePlaybackResponseSchema, {
                result: {
                  case: "ready",
                  value: {
                    media: {
                      url: `https://media.fixture.test/video-${fileId}?token=fixture-playback-secret`,
                      expiry: { case: "expiryUnknown", value: true },
                    },
                    format: { container: 1, videoCodec: 1, audioCodec: 1 },
                    subtitles: [
                      {
                        id: `english-${fileId}`,
                        language: "eng",
                        format: 1,
                        source: {
                          url: `https://media.fixture.test/subtitles-${fileId}.vtt`,
                          expiry: { case: "expiryUnknown", value: true },
                        },
                      },
                    ],
                  },
                },
              }),
            ),
          );
          return;
        }
        default:
          error(response, 404, "not_found");
      }
    })().catch(() => error(response, 500, "internal"));
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  const address = engine.address();
  assert.ok(address && typeof address !== "string");
  const directory = await mkdtemp(join(tmpdir(), "hosted-fixture-"));
  const file = join(directory, "installations.sqlite");
  const key = Buffer.alloc(32, 7);
  let store = await InstallationStore.open(file, key);
  let hosted = await startHostedAdapter({
    store,
    statusMedia,
    engineBaseUrl: `http://127.0.0.1:${address.port}`,
    webOrigin,
  });
  const api = (path: string, init: RequestInit = {}, token = ownerToken) => {
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      origin: webOrigin,
      "content-type": "application/json",
    });
    new Headers(init.headers).forEach((value, name) =>
      headers.set(name, value),
    );
    return fetch(`${hosted.origin}${path}`, { ...init, headers });
  };
  const install = async (token = ownerToken) => {
    const response = await api(
      "/api/installations",
      { method: "POST", body: JSON.stringify({ folderId: "42" }) },
      token,
    );
    assert.equal(response.status, 201);
    return decode(response, View);
  };
  return {
    calls,
    searches,
    state,
    api,
    install,
    historicalOperation(installationId: string) {
      const claim = store.claim(installationId, target, "historical-release");
      store.submitted(installationId, claim.operation.id, "91");
      return claim.operation.id;
    },
    get origin() {
      return hosted.origin;
    },
    async restart() {
      await hosted.close();
      store.close();
      store = await InstallationStore.open(file, key);
      hosted = await startHostedAdapter({
        store,
        statusMedia,
        engineBaseUrl: `http://127.0.0.1:${address.port}`,
        webOrigin,
      });
    },
    async close() {
      await hosted.close();
      store.close();
      engine.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        engine.close((cause) => (cause ? reject(cause) : resolve())),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function acquire(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const response = await f.api(`/api/installations/${id}/acquisitions`, {
    method: "POST",
    body: JSON.stringify({
      type: "movie",
      target,
      releaseId: "fixture-release",
    }),
  });
  assert.equal(response.status, 200);
  return decode(response, Operation);
}

test("hosted installation management authenticates owners, verifies folders and restricts API CORS", async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.origin}/api/installations`)).status, 401);
    assert.equal(
      (await f.api("/api/installations", {}, "fixture-invalid")).status,
      401,
    );
    const forbidden = await f.api("/api/installations", {
      headers: { origin: "https://other.example" },
    });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.headers.get("access-control-allow-origin"), null);
    const preflight = await fetch(`${f.origin}/api/installations`, {
      method: "OPTIONS",
      headers: { origin: webOrigin },
    });
    assert.equal(preflight.status, 204);
    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      webOrigin,
    );
    assert.match(
      preflight.headers.get("access-control-allow-headers") ?? "",
      /Authorization/,
    );
    const nonexistent = await f.api("/api/installations", {
      method: "POST",
      body: JSON.stringify({ folderId: "999" }),
    });
    assert.equal(nonexistent.status, 404);
    const installed = await f.install();
    assert.ok(
      f.calls.some(
        (call) => call.method === "GetFolder" && call.owner === "101",
      ),
    );
    const listed = await f.api("/api/installations");
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("cache-control"), "no-store");
    assert.equal(listed.headers.get("access-control-allow-origin"), webOrigin);
    const listing = await decode(
      listed,
      Schema.Struct({ installations: Schema.Array(View) }),
    );
    assert.equal(listing.installations.length, 1);
    assert.equal(listing.installations[0]?.id, installed.id);
    assert.doesNotMatch(
      JSON.stringify(listing),
      /fixture-owner|private@fixture/,
    );
    const other = await decode(
      await f.api("/api/installations", {}, otherToken),
      Schema.Struct({ installations: Schema.Array(View) }),
    );
    assert.deepEqual(other.installations, []);
    assert.equal(
      (
        await f.api(
          `/api/installations/${installed.id}`,
          { method: "DELETE" },
          otherToken,
        )
      ).status,
      404,
    );
    assert.equal((await fetch(installed.manifestUrl)).status, 200);
    assert.equal(
      (await f.api(`/api/installations/${installed.id}`, { method: "DELETE" }))
        .status,
      204,
    );
    assert.equal((await fetch(installed.manifestUrl)).status, 404);
  } finally {
    await f.close();
  }
});

test("capability manifest and discovery remain read-only and keep transfer URLs private", async () => {
  const f = await fixture();
  try {
    const installed = await f.install();
    const base = installed.manifestUrl.replace("/manifest.json", "");
    const manifest = await fetch(installed.manifestUrl);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get("cache-control"), "no-store");
    assert.equal(manifest.headers.get("access-control-allow-origin"), "*");
    const catalogResponse = await fetch(
      `${base}/catalog/movie/discover-movies.json`,
    );
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalogResponse.headers.get("cache-control"), "no-store");
    const catalog = await decode(catalogResponse, Catalog);
    assert.equal(catalog.metas[0]?.id, target);
    const streamResponse = await fetch(
      `${base}/stream/movie/${encodeURIComponent(target)}.json`,
    );
    assert.equal(streamResponse.status, 200);
    const stream = await decode(streamResponse, Streams);
    assert.equal(stream.streams[0]?.externalUrl, undefined);
    assert.match(stream.streams[0]?.url ?? "", /\/play\/movie\//);
    const releaseResponse = await f.api(
      `/api/installations/${installed.id}/releases?type=movie&target=${encodeURIComponent(target)}`,
    );
    assert.equal(releaseResponse.status, 200);
    const releaseText = await releaseResponse.text();
    assert.match(releaseText, /fixture-release/);
    assert.doesNotMatch(releaseText, /fixture-release-secret|https:\/\/engine/);
    assert.equal(
      (await f.api(`/api/installations/${installed.id}/acquisitions`)).status,
      404,
    );
    assert.equal(f.state.addCount, 0);
    assert.equal(
      (await fetch(`${f.origin}/i/${"x".repeat(43)}/manifest.json`)).status,
      404,
    );
    assert.equal(
      (await fetch(installed.manifestUrl, { method: "POST" })).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("explicit acquisition POST deduplicates simultaneous clicks and enables selected verified playback", async () => {
  const f = await fixture();
  try {
    const installed = await f.install();
    const [first, second] = await Promise.all([
      acquire(f, installed.id),
      acquire(f, installed.id),
    ]);
    assert.equal(first.id, second.id);
    assert.equal(f.state.addCount, 1);
    const state = await f.api(
      `/api/installations/${installed.id}/acquisitions/${first.id}`,
    );
    assert.equal(state.status, 200);
    const videos = await decode(state, Videos);
    assert.deepEqual(
      videos.files.map((file) => file.id),
      ["21", "22"],
    );
    const selected = videos.files.find((file) => file.id === "22");
    assert.ok(selected);
    const base = installed.manifestUrl.replace("/manifest.json", "");
    const playback = await fetch(
      `${base}/stream/movie/${encodeURIComponent(selected.stremioId)}.json`,
    );
    assert.equal(playback.status, 200);
    const stream = await decode(playback, Streams);
    assert.equal(
      stream.streams[0]?.url,
      "https://media.fixture.test/video-22?token=fixture-playback-secret",
    );
    const unrelated = await decode(
      await fetch(
        `${base}/stream/movie/${encodeURIComponent(`chill:acquired:${first.id}:99`)}.json`,
      ),
      Streams,
    );
    assert.deepEqual(unrelated.streams, []);
    const other = await f.install(otherToken);
    const otherBase = other.manifestUrl.replace("/manifest.json", "");
    assert.equal(
      (
        await f.api(
          `/api/installations/${installed.id}/acquisitions/${first.id}`,
          {},
          otherToken,
        )
      ).status,
      404,
    );
    const wrongOwnerPlayback = await decode(
      await fetch(
        `${otherBase}/stream/movie/${encodeURIComponent(selected.stremioId)}.json`,
      ),
      Streams,
    );
    assert.deepEqual(wrongOwnerPlayback.streams, []);
    f.state.acquiredVisible = false;
    const removed = await decode(
      await fetch(
        `${base}/stream/movie/${encodeURIComponent(selected.stremioId)}.json`,
      ),
      Streams,
    );
    assert.deepEqual(removed.streams, []);
  } finally {
    await f.close();
  }
});

test("acquired catalog skips missing historical transfers but preserves upstream failures", async () => {
  const f = await fixture();
  try {
    const installed = await f.install();
    const valid = await acquire(f, installed.id);
    const missing = f.historicalOperation(installed.id);
    const base = installed.manifestUrl.replace("/manifest.json", "");
    const response = await fetch(`${base}/catalog/movie/acquired.json`);
    assert.equal(response.status, 200);
    assert.deepEqual((await decode(response, Catalog)).metas, [
      { id: `chill:acquired:${valid.id}:21`, name: "First video" },
      { id: `chill:acquired:${valid.id}:22`, name: "Second video" },
    ]);
    assert.equal(
      (
        await f.api(
          `/api/installations/${installed.id}/acquisitions/${missing}`,
        )
      ).status,
      404,
    );
    for (const failure of [
      { status: 401, code: "unauthenticated" },
      { status: 403, code: "permission_denied" },
      { status: 429, code: "resource_exhausted" },
      { status: 504, code: "deadline_exceeded" },
      { status: 503, code: "unavailable" },
    ]) {
      f.state.historicalTransferError = failure;
      const failed = await fetch(`${base}/catalog/movie/acquired.json`);
      assert.equal(failed.status, failure.status);
      assert.deepEqual(await failed.json(), { error: failure.code });
    }
    assert.equal(f.state.addCount, 1);
  } finally {
    await f.close();
  }
});

test("lost provider response remains unknown across hosted restart and cannot submit again", async () => {
  const f = await fixture();
  try {
    const installed = await f.install();
    f.state.loseTransferResponse = true;
    const first = await acquire(f, installed.id);
    assert.equal(first.state, "unknown");
    assert.equal(first.transferId, undefined);
    assert.equal(f.state.addCount, 1);
    await f.restart();
    f.state.loseTransferResponse = false;
    const retry = await acquire(f, installed.id);
    assert.equal(retry.id, first.id);
    assert.equal(retry.state, "unknown");
    assert.equal(f.state.addCount, 1);
    const status = await f.api(
      `/api/installations/${installed.id}/acquisitions/${first.id}`,
    );
    assert.equal(status.status, 200);
    assert.deepEqual((await decode(status, Videos)).files, []);
  } finally {
    await f.close();
  }
});

test("hosted protocol configuration and malformed routes stay within their capability", async () => {
  const f = await fixture();
  try {
    const installed = await f.install();
    const base = installed.manifestUrl.replace("/manifest.json", "");
    const config = await fetch(`${base}/configure`, { redirect: "manual" });
    assert.equal(config.status, 302);
    assert.equal(config.headers.get("location"), `${webOrigin}/stremio`);
    assert.equal(config.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await fetch(`${base}/meta/movie/%ZZ.json`)).status, 400);
    assert.equal(
      (
        await fetch(
          `${base}/catalog/movie/discover-movies/search=x&search=y.json`,
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("a stalled protocol response times out once and the server remains usable", async () => {
  const f = await fixture();
  try {
    const installed = await f.install();
    const base = installed.manifestUrl.replace("/manifest.json", "");
    f.state.stallMovies = true;
    const response = await fetch(`${base}/catalog/movie/discover-movies.json`, {
      signal: AbortSignal.timeout(12_000),
    });
    assert.equal(response.status, 504);
    await response.arrayBuffer();
    f.state.stallMovies = false;
    assert.equal(
      (await fetch(`${base}/catalog/movie/discover-movies.json`)).status,
      200,
    );
  } finally {
    await f.close();
  }
}, 15_000);

async function releaseSelection(
  f: Awaited<ReturnType<typeof fixture>>,
  manifest: string,
) {
  const base = manifest.replace("/manifest.json", "");
  const response = await fetch(
    `${base}/stream/movie/${encodeURIComponent(target)}.json`,
  );
  assert.equal(response.status, 200);
  const entries = await decode(response, Streams);
  const url = entries.streams[0]?.url;
  assert.ok(url);
  assert.equal(entries.streams[0]?.externalUrl, undefined);
  return { base, url };
}

test("Stremio media selection waits for its download and plays without reselection", async () => {
  const f = await fixture();
  try {
    f.state.transferFinished = false;
    f.state.singleFile = true;
    const installed = await f.install();
    const { base, url } = await releaseSelection(f, installed.manifestUrl);
    assert.equal(f.state.addCount, 0);
    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(
      head.headers.get("content-type"),
      "application/vnd.apple.mpegurl",
    );
    assert.equal((await fetch(url, { method: "OPTIONS" })).status, 204);
    assert.equal(
      (await fetch(url, { headers: { purpose: "prefetch" } })).status,
      204,
    );
    assert.equal(f.state.addCount, 0);
    let responded = false;
    const selected = fetch(url, { redirect: "manual" }).then((response) => {
      responded = true;
      return response;
    });
    const submittedDeadline = Date.now() + 2000;
    while (f.state.addCount === 0 && Date.now() < submittedDeadline)
      await sleep(10);
    assert.equal(f.state.addCount, 1);
    const downloads = await decode(
      await fetch(`${base}/catalog/movie/downloads.json`),
      Catalog,
    );
    assert.equal(downloads.metas.length, 1);
    assert.match(
      downloads.metas[0]?.name ?? "",
      /Independent\.Film\.1080p.*42%/,
    );
    assert.equal(responded, false);
    const repeated = fetch(url, { redirect: "manual" });
    f.state.playbackPending = true;
    f.state.transferFinished = true;
    await sleep(2100);
    assert.equal(responded, false);
    f.state.playbackPending = false;
    for (const ready of await Promise.all([selected, repeated])) {
      assert.equal(ready.status, 302);
      assert.equal(
        ready.headers.get("location"),
        "https://media.fixture.test/video-21?token=fixture-playback-secret",
      );
    }
    assert.equal(f.state.addCount, 1);
    const operation = downloads.metas[0];
    assert.ok(operation);
    const streams = await decode(
      await fetch(
        `${base}/stream/movie/${encodeURIComponent(operation.id)}.json`,
      ),
      Streams,
    );
    assert.equal(streams.streams.length, 1);
    assert.match(streams.streams[0]?.url ?? "", /video-21/);
    await f.restart();
    assert.equal(
      (
        await fetch(`${f.origin}${new URL(url).pathname}`, {
          redirect: "manual",
        })
      ).status,
      302,
    );
    assert.equal(f.state.addCount, 1);
    await f.api(`/api/installations/${installed.id}`, { method: "DELETE" });
    assert.equal(
      (
        await fetch(`${f.origin}${new URL(url).pathname}`, {
          redirect: "manual",
        })
      ).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("revocation interrupts an open download wait without another submission", async () => {
  const f = await fixture();
  try {
    f.state.transferFinished = false;
    const installed = await f.install();
    const { url } = await releaseSelection(f, installed.manifestUrl);
    const selected = fetch(url, { redirect: "manual" });
    const deadline = Date.now() + 2000;
    while (f.state.addCount === 0 && Date.now() < deadline) await sleep(10);
    assert.equal(f.state.addCount, 1);
    assert.equal(
      (await f.api(`/api/installations/${installed.id}`, { method: "DELETE" }))
        .status,
      204,
    );
    assert.equal((await selected).status, 404);
    assert.equal(f.state.addCount, 1);
  } finally {
    await f.close();
  }
});

test("invalid playback continuations never start a download", async () => {
  const f = await fixture();
  try {
    const installed = await f.install();
    const { url } = await releaseSelection(f, installed.manifestUrl);
    for (const query of ["wait=6", "wait=-1", "wait=0&wait=1", "other=1"]) {
      assert.equal(
        (await fetch(`${url}?${query}`, { redirect: "manual" })).status,
        400,
      );
    }
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("multi-file Stremio selection requires choosing a file and never guesses the first video", async () => {
  const f = await fixture();
  try {
    const installed = await f.install();
    const { base, url } = await releaseSelection(f, installed.manifestUrl);
    const selected = await fetch(url, { redirect: "manual" });
    assert.equal(selected.status, 409);
    assert.deepEqual(await selected.json(), { error: "select-file" });
    const downloads = await decode(
      await fetch(`${base}/catalog/movie/downloads.json`),
      Catalog,
    );
    const operation = downloads.metas[0];
    assert.ok(operation);
    const choices = await decode(
      await fetch(
        `${base}/stream/movie/${encodeURIComponent(operation.id)}.json`,
      ),
      Streams,
    );
    assert.equal(choices.streams.length, 2);
    assert.match(choices.streams[0]?.url ?? "", /video-21/);
    assert.match(choices.streams[1]?.url ?? "", /video-22/);
    assert.equal(f.state.addCount, 1);
  } finally {
    await f.close();
  }
});

test("lost selected-media submission stays unknown after restart without resubmission", async () => {
  const f = await fixture();
  try {
    const installed = await f.install();
    const { url } = await releaseSelection(f, installed.manifestUrl);
    f.state.loseTransferResponse = true;
    const first = await fetch(url, { redirect: "manual" });
    assert.equal(first.status, 409);
    assert.deepEqual(await first.json(), { error: "unknown" });
    await f.restart();
    f.state.loseTransferResponse = false;
    const repeated = await fetch(`${f.origin}${new URL(url).pathname}`, {
      redirect: "manual",
    });
    assert.equal(repeated.status, 409);
    assert.deepEqual(await repeated.json(), { error: "unknown" });
    assert.equal(f.state.addCount, 1);
  } finally {
    await f.close();
  }
});

test("folder-free setup browses nested library videos across restart and revocation", async () => {
  const f = await fixture();
  try {
    const created = await f.api("/api/installations", {
      method: "POST",
      body: "{}",
    });
    assert.equal(created.status, 201);
    const installed = await decode(created, View);
    assert.equal(installed.folderId, "0");
    const path = new URL(installed.manifestUrl).pathname.replace(
      "/manifest.json",
      "/catalog/movie/library.json",
    );
    const catalog = await decode(await fetch(`${f.origin}${path}`), Catalog);
    assert.deepEqual(
      catalog.metas.map((file) => file.name),
      ["Existing video"],
    );
    await f.restart();
    assert.deepEqual(
      await decode(await fetch(`${f.origin}${path}`), Catalog),
      catalog,
    );
    assert.equal(f.state.addCount, 0);
    assert.equal(
      (await f.api(`/api/installations/${installed.id}`, { method: "DELETE" }))
        .status,
      204,
    );
    assert.equal((await fetch(`${f.origin}${path}`)).status, 404);
  } finally {
    await f.close();
  }
});

test("whole-library connection does not depend on parsing the root folder", async () => {
  const f = await fixture();
  try {
    f.state.invalidRootFolder = true;
    for (const body of ["{}", '{"folderId":"0"}']) {
      const created = await f.api("/api/installations", {
        method: "POST",
        body,
      });
      assert.equal(created.status, 201);
      const installed = await decode(created, View);
      assert.equal(installed.folderId, "0");
      assert.equal((await fetch(installed.manifestUrl)).status, 200);
    }
    assert.ok(f.calls.every((call) => call.method === "GetUserProfile"));
    const denied = await f.api(
      "/api/installations",
      { method: "POST", body: "{}" },
      "fixture-invalid",
    );
    assert.equal(denied.status, 401);
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("public catalog entry requires configuration and never accesses an account", async () => {
  const f = await fixture();
  try {
    const response = await fetch(`${f.origin}/manifest.json`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    const publicManifest = await decode(
      response,
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        behaviorHints: Schema.Struct({
          configurable: Schema.Boolean,
          configurationRequired: Schema.Boolean,
        }),
      }),
    );
    assert.equal(publicManifest.name, "chill.institute");
    assert.deepEqual(publicManifest.behaviorHints, {
      configurable: true,
      configurationRequired: true,
    });
    for (const path of ["/"]) {
      const redirected = await fetch(`${f.origin}${path}`, {
        redirect: "manual",
      });
      assert.equal(redirected.status, 302);
      assert.equal(redirected.headers.get("location"), `${webOrigin}/stremio`);
      assert.equal(redirected.headers.get("referrer-policy"), "no-referrer");
    }
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const setup = await fetch(`${f.origin}/configure`, {
        method,
        redirect: "manual",
      });
      assert.equal(setup.status, method === "OPTIONS" ? 204 : 200);
      assert.equal(setup.headers.get("location"), null);
      assert.equal(setup.headers.get("referrer-policy"), "no-referrer");
      if (method === "GET") {
        assert.match(setup.headers.get("content-type") ?? "", /^text\/html/);
        const html = await setup.text();
        assert.ok(
          [...html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi)].some(
            ([, href]) => href === `${webOrigin}/stremio`,
          ),
        );
        const stylesheet = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
        assert.ok(stylesheet);
        const hash = createHash("sha256").update(stylesheet).digest("base64");
        assert.equal(
          setup.headers.get("content-security-policy"),
          `default-src 'none'; style-src 'sha256-${hash}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        );
        assert.doesNotMatch(html, /<script\b|<link\b|<iframe\b/i);
      } else assert.equal(await setup.text(), "");
    }
    assert.equal(
      (await fetch(`${f.origin}/manifest.json`, { method: "OPTIONS" })).status,
      204,
    );
    for (const [name, contentType] of [["logo.png", "image/png"]]) {
      const assetUrl = `${f.origin}/configure-assets/${name}`;
      const asset = await fetch(assetUrl);
      assert.equal(asset.status, 200);
      assert.equal(asset.headers.get("content-type"), contentType);
      assert.ok((await asset.arrayBuffer()).byteLength > 0);
      const assetHead = await fetch(assetUrl, { method: "HEAD" });
      assert.equal(assetHead.status, 200);
      assert.equal(await assetHead.text(), "");
      assert.equal((await fetch(assetUrl, { method: "POST" })).status, 404);
    }
    assert.equal(
      (await fetch(`${f.origin}/configure-assets/missing.woff2`)).status,
      404,
    );
    const head = await fetch(`${f.origin}/manifest.json`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    for (const path of [
      "/catalog/movie/library.json",
      "/stream/movie/chill:file:50.json",
      "/api/installations",
    ]) {
      assert.notEqual((await fetch(`${f.origin}${path}`)).status, 200);
    }
    assert.deepEqual(f.calls, []);
    const installed = await f.install();
    const personal = await decode(
      await fetch(installed.manifestUrl),
      Schema.Struct({
        id: Schema.String,
        behaviorHints: Schema.Struct({
          configurable: Schema.Boolean,
          configurationRequired: Schema.Boolean,
        }),
      }),
    );
    assert.equal(personal.id, publicManifest.id);
    assert.equal(personal.behaviorHints.configurationRequired, false);
  } finally {
    await f.close();
  }
});

test("ordinary Stremio movie and episode cards offer read-only chill release search", async () => {
  const f = await fixture();
  try {
    const installed = await f.install();
    const base = installed.manifestUrl.replace("/manifest.json", "");
    const manifest: unknown = await (await fetch(installed.manifestUrl)).json();
    const isSupported: (
      manifest: unknown,
      resource: string,
      type: string,
      id: string,
    ) => boolean = createRequire(import.meta.url)(
      "stremio-addon-client/lib/util/isSupported.js",
    );
    assert.equal(isSupported(manifest, "stream", "movie", "tt1234567"), true);
    assert.equal(
      isSupported(manifest, "stream", "series", "tt7654321:1:2"),
      true,
    );
    assert.equal(isSupported(manifest, "meta", "movie", "tt1234567"), false);
    assert.equal(isSupported(manifest, "meta", "series", "tt7654321"), false);
    for (const input of [
      { type: "movie", id: "tt1234567", canonical: target },
      {
        type: "series",
        id: "tt7654321:1:2",
        canonical: "chill:episode:tt7654321:1:2",
      },
    ]) {
      const response = await fetch(
        `${base}/stream/${input.type}/${encodeURIComponent(input.id)}.json`,
      );
      assert.equal(response.status, 200);
      const stream = await decode(response, Streams);
      assert.equal(stream.streams.length, 1);
      assert.equal(
        stream.streams[0]?.url,
        `${base}/play/${input.type}/${encodeURIComponent(input.canonical)}/fixture-release.m3u8`,
      );
    }
    assert.deepEqual(f.searches, [
      "Independent film 2024",
      "Independent series S01E02",
    ]);
    const releases = await f.api(
      `/api/installations/${installed.id}/releases?type=movie&target=tt1234567`,
    );
    assert.equal(releases.status, 200);
    assert.match(await releases.text(), /fixture-release/);
    assert.equal(f.state.addCount, 0);
    assert.equal(
      f.calls.some(({ method }) => method === "AddTransfer"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("subtitle resources use the exact selected acquisition without starting downloads", async () => {
  const f = await fixture();
  try {
    const installed = await f.install();
    const base = installed.manifestUrl.replace("/manifest.json", "");
    const subtitles = async (id: string, filename?: string) => {
      const extra =
        filename === undefined ? "" : `/${new URLSearchParams({ filename })}`;
      const response = await fetch(
        `${base}/subtitles/movie/${encodeURIComponent(id)}${extra}.json`,
      );
      assert.equal(response.status, 200);
      return decode(
        response,
        Schema.Struct({
          subtitles: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              lang: Schema.String,
              url: Schema.String,
            }),
          ),
        }),
      );
    };
    assert.deepEqual(await subtitles("tt1234567", "fixture-release.mp4"), {
      subtitles: [],
    });
    assert.equal(f.state.addCount, 0);
    const operation = await acquire(f, installed.id);
    assert.equal(f.state.addCount, 1);
    assert.deepEqual(await subtitles("tt1234567", "fixture-release.mp4"), {
      subtitles: [],
    });
    f.state.singleFile = true;
    assert.deepEqual(await subtitles("tt1234567"), { subtitles: [] });
    assert.deepEqual(await subtitles("tt1234567", "another-release.mp4"), {
      subtitles: [],
    });
    const expected = {
      subtitles: [
        {
          id: "english-21",
          lang: "eng",
          url: "https://media.fixture.test/subtitles-21.vtt",
        },
      ],
    };
    assert.deepEqual(
      await subtitles("tt1234567", "fixture-release.mp4"),
      expected,
    );
    assert.deepEqual(
      await subtitles("tt1234567", "fixture-release.m3u8"),
      expected,
    );
    assert.deepEqual(
      await subtitles("tt1234567", `${operation.id}.mp4`),
      expected,
    );
    const invalid = await fetch(
      `${base}/subtitles/movie/tt1234567/${new URLSearchParams({ filename: "x".repeat(517) })}.json`,
    );
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "invalid_request" });
    assert.deepEqual(
      await subtitles(`chill:download:${operation.id}`),
      expected,
    );
    assert.deepEqual(
      await subtitles(`chill:acquired:${operation.id}:21`),
      expected,
    );
    assert.deepEqual(await subtitles("chill:file:50"), {
      subtitles: [
        {
          id: "english-50",
          lang: "eng",
          url: "https://media.fixture.test/subtitles-50.vtt",
        },
      ],
    });
    f.state.transferFinished = false;
    assert.deepEqual(await subtitles("tt1234567", "fixture-release.mp4"), {
      subtitles: [],
    });
    assert.equal(f.state.addCount, 1);
  } finally {
    await f.close();
  }
});
