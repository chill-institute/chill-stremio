import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomBytes } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import * as proto from "@chill-institute/contracts/chill/v4/api_pb";
import { Schema } from "effect";
import { test } from "vite-plus/test";
import { redactCredentials } from "../src/credential.ts";
import { startHostedAdapter } from "../src/hosted.ts";
import { statusMessages, type StatusMediaKind } from "../src/status-media.ts";
import { discoveryTargetId } from "../src/discovery.ts";

const statusMedia = new Map(
  (Object.keys(statusMessages) as StatusMediaKind[]).map((kind) => [
    kind,
    Buffer.from("fixture-status-video"),
  ]),
);
const webOrigin = "http://127.0.0.1:3000";
const credential = () => `v4.local.${randomBytes(300).toString("base64url")}`;
const ownerCredential = credential();
const otherCredential = credential();
const target = discoveryTargetId({ kind: "movie", id: "fixture-film" });
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

async function fixture(options: { selectionReuseMs?: number } = {}) {
  const calls: { method: string; owner: string }[] = [];
  const searches: string[] = [];
  const state = {
    loseTransferResponse: false,
    stallMovies: false,
    addCount: 0,
    addDelayMs: 0,
    addCredentials: [] as (string | string[] | undefined)[],
    transferFinished: true,
    singleFile: false,
    playbackPending: false,
    rejection: undefined as { status: number; code: string } | undefined,
  };
  const error = (response: ServerResponse, status: number, code: string) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ code, message: "fixture error" }));
  };
  const engine = createServer((request, response) => {
    void (async () => {
      const presented = request.headers["x-chill-stremio-credential"];
      const owner =
        presented === ownerCredential
          ? "101"
          : presented === otherCredential
            ? "202"
            : undefined;
      if (!owner || request.headers.authorization !== undefined) {
        error(response, 401, "unauthenticated");
        return;
      }
      const method = request.url?.split("/").at(-1) ?? "";
      calls.push({ method, owner });
      assert.equal(request.method, "POST");
      if (state.rejection) {
        error(response, state.rejection.status, state.rejection.code);
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const json = Buffer.concat(chunks).toString("utf8");
      response.setHeader("content-type", "application/json");
      switch (method) {
        case "GetFolder": {
          const { id } = fromJsonString(proto.GetFolderRequestSchema, json);
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
          state.addCredentials.push(presented);
          await sleep(state.addDelayMs);
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
            error(response, 404, "not_found");
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
  const start = () =>
    startHostedAdapter({
      statusMedia,
      engineBaseUrl: `http://127.0.0.1:${address.port}`,
      webOrigin,
      selectionReuseMs: options.selectionReuseMs,
    });
  let hosted = await start();
  return {
    calls,
    searches,
    state,
    get origin() {
      return hosted.origin;
    },
    base(value = ownerCredential) {
      return `${hosted.origin}/s/${value}`;
    },
    async restart() {
      await hosted.close();
      hosted = await start();
    },
    async close() {
      await hosted.close();
      engine.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        engine.close((cause) => (cause ? reject(cause) : resolve())),
      );
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function releaseSelection(f: Fixture) {
  const response = await fetch(
    `${f.base()}/stream/movie/${encodeURIComponent(target)}.json`,
  );
  assert.equal(response.status, 200);
  const entries = await decode(response, Streams);
  const url = entries.streams[0]?.url;
  assert.ok(url);
  assert.equal(entries.streams[0]?.externalUrl, undefined);
  return url;
}

test("credential manifest and discovery remain read-only and keep transfer URLs private", async () => {
  const f = await fixture();
  try {
    const manifest = await fetch(`${f.base()}/manifest.json`);
    assert.equal(manifest.status, 200);
    assert.equal(manifest.headers.get("cache-control"), "no-store");
    assert.equal(manifest.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(f.calls, []);
    const catalogResponse = await fetch(
      `${f.base()}/catalog/movie/discover-movies.json`,
    );
    assert.equal(catalogResponse.status, 200);
    assert.equal(catalogResponse.headers.get("cache-control"), "no-store");
    const catalog = await decode(catalogResponse, Catalog);
    assert.equal(catalog.metas[0]?.id, target);
    const streamResponse = await fetch(
      `${f.base()}/stream/movie/${encodeURIComponent(target)}.json`,
    );
    assert.equal(streamResponse.status, 200);
    const streamText = await streamResponse.text();
    assert.doesNotMatch(streamText, /fixture-release-secret|https:\/\/engine/);
    const stream = Schema.decodeUnknownSync(Streams)(JSON.parse(streamText));
    assert.equal(stream.streams[0]?.externalUrl, undefined);
    assert.equal(
      stream.streams[0]?.url,
      `${f.base()}/play/movie/${encodeURIComponent(target)}/fixture-release.m3u8`,
    );
    assert.equal(f.state.addCount, 0);
    assert.ok(f.calls.every(({ owner }) => owner === "101"));
    assert.equal(
      f.calls.some(({ method }) => method === "GetUserProfile"),
      false,
    );
    assert.equal(
      (await fetch(`${f.base()}/manifest.json`, { method: "POST" })).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("malformed credentials and removed routes never reach Engine", async () => {
  const f = await fixture();
  try {
    for (const path of [
      "/s/not-a-credential/manifest.json",
      "/s/v4.local.short/manifest.json",
      `/s/v4.public.${"a".repeat(64)}/manifest.json`,
      `/s/v4.local.${"a".repeat(1016)}/catalog/movie/library.json`,
      `/s/v4.local.${"a".repeat(64)}.footer.extra/manifest.json`,
      `/s/v4.local.${"a".repeat(64)}.${"b".repeat(87)}/manifest.json`,
      `/i/${"x".repeat(43)}/manifest.json`,
      "/api/installations",
    ])
      assert.equal((await fetch(`${f.origin}${path}`)).status, 404, path);
    assert.equal(
      (await fetch(`${f.base(`v4.local.${"a".repeat(1015)}`)}/manifest.json`))
        .status,
      200,
    );
    assert.equal(
      (
        await fetch(
          `${f.base(`v4.local.${"a".repeat(300)}.eyJraWQiOiJzMSJ9`)}/manifest.json`,
        )
      ).status,
      200,
    );
    const denied = await fetch(
      `${f.base(credential())}/catalog/movie/library.json`,
    );
    assert.equal(denied.status, 200);
    assert.deepEqual(
      (await decode(denied, Catalog)).metas.map(({ id }) => id),
      ["chill:reconnect"],
    );
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});

test("Engine credential rejection shows reconnect rows, sources and notices", async () => {
  const f = await fixture();
  try {
    const url = await releaseSelection(f);
    for (const rejection of [
      { status: 401, code: "unauthenticated" },
      { status: 403, code: "permission_denied" },
    ]) {
      f.state.rejection = rejection;
      for (const [type, catalog] of [
        ["movie", "library"],
        ["movie", "discover-movies"],
        ["series", "discover-series"],
      ] as const) {
        const response = await fetch(
          `${f.base()}/catalog/${type}/${catalog}.json`,
        );
        assert.equal(response.status, 200);
        const body = Schema.decodeUnknownSync(
          Schema.Struct({
            metas: Schema.Array(
              Schema.Struct({
                id: Schema.String,
                type: Schema.String,
                description: Schema.String,
              }),
            ),
          }),
        )(await response.json());
        assert.deepEqual(
          body.metas.map(({ id, type }) => ({ id, type })),
          [{ id: "chill:reconnect", type }],
        );
        assert.match(body.metas[0]?.description ?? "", /\/stremio/);
      }
      const reconnectSource = {
        streams: [{ externalUrl: `${webOrigin}/stremio` }],
      };
      for (const id of [
        target,
        "tt1234567",
        "chill:file:50",
        "chill:reconnect",
      ])
        assert.deepEqual(
          await decode(
            await fetch(
              `${f.base()}/stream/movie/${encodeURIComponent(id)}.json`,
            ),
            Streams,
          ),
          reconnectSource,
        );
      const meta = await fetch(`${f.base()}/meta/movie/chill%3Areconnect.json`);
      assert.equal(meta.status, 200);
      assert.match(await meta.text(), /Reconnect chill\.institute/);
      assert.deepEqual(
        await (
          await fetch(`${f.base()}/subtitles/movie/chill%3Afile%3A50.json`)
        ).json(),
        { subtitles: [] },
      );
      const hls = await fetch(url, { redirect: "manual" });
      assert.equal(hls.status, 409);
      assert.deepEqual(await hls.json(), { error: "reconnect" });
      const legacy = await fetch(url.replace(/\.m3u8$/, ".mp4"), {
        redirect: "manual",
      });
      assert.equal(legacy.status, 302);
      assert.equal(
        legacy.headers.get("location"),
        `${f.base()}/notice/reconnect.mp4`,
      );
      const status = await fetch(`${f.base()}/status/90.mp4`, {
        redirect: "manual",
      });
      assert.equal(
        status.headers.get("location"),
        `${f.base()}/notice/reconnect.mp4`,
      );
    }
    const clip = await fetch(`${f.base()}/notice/reconnect.mp4`);
    assert.equal(clip.status, 200);
    assert.equal(clip.headers.get("content-type"), "video/mp4");
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("hosted protocol configuration and malformed routes stay within their credential", async () => {
  const f = await fixture();
  try {
    const config = await fetch(`${f.base()}/configure`, { redirect: "manual" });
    assert.equal(config.status, 302);
    assert.equal(config.headers.get("location"), `${webOrigin}/stremio`);
    assert.equal(config.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await fetch(`${f.base()}/meta/movie/%ZZ.json`)).status, 400);
    assert.equal(
      (
        await fetch(
          `${f.base()}/catalog/movie/discover-movies/search=x&search=y.json`,
        )
      ).status,
      400,
    );
    for (const id of [
      "0",
      "abc",
      "-1",
      "01",
      "9223372036854775808",
      "99999999999999999999",
    ])
      assert.equal(
        (await fetch(`${f.base()}/status/${id}.m3u8`, { redirect: "manual" }))
          .status,
        404,
        id,
      );
    assert.equal((await fetch(`${f.base()}/notice/other.mp4`)).status, 404);
    assert.equal((await fetch(`${f.base()}/${"x".repeat(4096)}`)).status, 404);
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("a stalled protocol response times out once and the server remains usable", async () => {
  const f = await fixture();
  try {
    f.state.stallMovies = true;
    const response = await fetch(
      `${f.base()}/catalog/movie/discover-movies.json`,
      { signal: AbortSignal.timeout(12_000) },
    );
    assert.equal(response.status, 504);
    await response.arrayBuffer();
    f.state.stallMovies = false;
    assert.equal(
      (await fetch(`${f.base()}/catalog/movie/discover-movies.json`)).status,
      200,
    );
  } finally {
    await f.close();
  }
}, 15_000);

test("Stremio media selection waits for its download and plays without reselection", async () => {
  const f = await fixture();
  try {
    f.state.transferFinished = false;
    f.state.singleFile = true;
    const url = await releaseSelection(f);
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
    assert.equal(
      (await fetch(url, { headers: { "sec-purpose": "prefetch" } })).status,
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
    const repeated = fetch(url, { redirect: "manual" });
    await sleep(200);
    assert.equal(
      f.state.addCount,
      1,
      "Concurrent selections share one submission",
    );
    assert.equal(responded, false);
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
    const reopened = await fetch(url, { redirect: "manual" });
    assert.equal(reopened.status, 302);
    assert.equal(
      f.state.addCount,
      1,
      "A reopened selection reuses its submission",
    );
    await f.restart();
    for (const extension of ["m3u8", "mp4"]) {
      const resumed = await fetch(`${f.base()}/status/90.${extension}?wait=3`, {
        redirect: "manual",
      });
      assert.equal(resumed.status, 302);
      assert.equal(
        resumed.headers.get("location"),
        "https://media.fixture.test/video-21?token=fixture-playback-secret",
      );
    }
    assert.equal(f.state.addCount, 1, "Status reads never submit");
    assert.equal(
      (
        await fetch(`${f.origin}${new URL(url).pathname}`, {
          redirect: "manual",
        })
      ).status,
      302,
    );
    assert.equal(
      f.state.addCount,
      2,
      "Selecting again after a restart submits again",
    );
    const foreign = await fetch(`${f.base(otherCredential)}/status/91.m3u8`, {
      redirect: "manual",
    });
    assert.equal(foreign.status, 404);
  } finally {
    await f.close();
  }
});

test("invalid playback continuations never start a download", async () => {
  const f = await fixture();
  try {
    const url = await releaseSelection(f);
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
    const url = await releaseSelection(f);
    const selected = await fetch(url, { redirect: "manual" });
    assert.equal(selected.status, 409);
    assert.deepEqual(await selected.json(), { error: "select-file" });
    const legacy = await fetch(`${f.base()}/status/90.mp4`, {
      redirect: "manual",
    });
    assert.equal(legacy.status, 302);
    assert.equal(
      legacy.headers.get("location"),
      `${f.base()}/notice/select-file.mp4`,
    );
    assert.equal(f.state.addCount, 1);
    assert.equal(
      f.calls.some(({ method }) => method === "ResolvePlayback"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("a lost submission response is reported as unknown and never retried", async () => {
  const f = await fixture();
  try {
    const url = await releaseSelection(f);
    f.state.loseTransferResponse = true;
    const first = await fetch(url, { redirect: "manual" });
    assert.equal(first.status, 409);
    assert.deepEqual(await first.json(), { error: "unknown" });
    assert.equal(f.state.addCount, 1);
    const legacy = await fetch(url.replace(/\.m3u8$/, ".mp4"), {
      redirect: "manual",
    });
    assert.equal(
      legacy.headers.get("location"),
      `${f.base()}/notice/unknown.mp4`,
    );
    assert.equal(f.state.addCount, 1, "A reopened selection is not retried");
    assert.equal(
      f.calls.filter(({ method }) => method === "GetTransfer").length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("a disconnected first client does not duplicate a shared submission", async () => {
  const f = await fixture();
  try {
    f.state.singleFile = true;
    f.state.addDelayMs = 500;
    const url = await releaseSelection(f);
    const first = new AbortController();
    const abandoned = fetch(url, {
      redirect: "manual",
      signal: first.signal,
    }).catch(() => undefined);
    await sleep(150);
    first.abort();
    await abandoned;
    await sleep(700);
    const reopened = await fetch(url, { redirect: "manual" });
    assert.equal(reopened.status, 302);
    assert.equal(f.state.addCount, 1);
  } finally {
    await f.close();
  }
});

test("identical selections under different credentials submit separately", async () => {
  const f = await fixture();
  try {
    f.state.singleFile = true;
    const url = await releaseSelection(f);
    const path = new URL(url).pathname.replace(/^\/s\/[^/]+/, "");
    for (const value of [ownerCredential, otherCredential])
      assert.equal(
        (await fetch(`${f.base(value)}${path}`, { redirect: "manual" })).status,
        302,
      );
    assert.equal(f.state.addCount, 2);
    assert.deepEqual(f.state.addCredentials, [
      ownerCredential,
      otherCredential,
    ]);
  } finally {
    await f.close();
  }
});

test("the library lists nested videos from the account root without downloads", async () => {
  const f = await fixture();
  try {
    const library = () => fetch(`${f.base()}/catalog/movie/library.json`);
    const catalog = await decode(await library(), Catalog);
    assert.deepEqual(
      catalog.metas.map((file) => file.name),
      ["Existing video"],
    );
    await f.restart();
    assert.deepEqual(await decode(await library(), Catalog), catalog);
    const streams = await decode(
      await fetch(`${f.base()}/stream/movie/chill%3Afile%3A50.json`),
      Streams,
    );
    assert.match(streams.streams[0]?.url ?? "", /video-50/);
    for (const removed of ["downloads", "acquired"])
      assert.notEqual(
        (await fetch(`${f.base()}/catalog/movie/${removed}.json`)).status,
        200,
      );
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
    const Manifest = Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      catalogs: Schema.Array(Schema.Struct({ id: Schema.String })),
      behaviorHints: Schema.Struct({
        configurable: Schema.Boolean,
        configurationRequired: Schema.Boolean,
      }),
    });
    const publicManifest = await decode(response, Manifest);
    assert.equal(publicManifest.name, "chill.institute");
    assert.deepEqual(publicManifest.behaviorHints, {
      configurable: true,
      configurationRequired: true,
    });
    assert.deepEqual(
      publicManifest.catalogs.map(({ id }) => id),
      ["discover-releases", "library", "discover-movies", "discover-series"],
    );
    const redirected = await fetch(`${f.origin}/`, { redirect: "manual" });
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get("location"), `${webOrigin}/stremio`);
    assert.equal(redirected.headers.get("referrer-policy"), "no-referrer");
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
    ]) {
      assert.notEqual((await fetch(`${f.origin}${path}`)).status, 200);
    }
    assert.deepEqual(f.calls, []);
    const personal = await decode(
      await fetch(`${f.base()}/manifest.json`),
      Manifest,
    );
    assert.equal(personal.id, publicManifest.id);
    assert.equal(personal.behaviorHints.configurationRequired, false);
    assert.deepEqual(personal.catalogs, publicManifest.catalogs);
  } finally {
    await f.close();
  }
});

test("ordinary Stremio movie and episode cards offer read-only chill release search", async () => {
  const f = await fixture();
  try {
    const manifest: unknown = await (
      await fetch(`${f.base()}/manifest.json`)
    ).json();
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
    assert.equal(
      isSupported(manifest, "subtitles", "movie", "chill:file:50"),
      true,
    );
    assert.equal(
      isSupported(manifest, "subtitles", "movie", "tt1234567"),
      false,
    );
    for (const input of [
      { type: "movie", id: "tt1234567", canonical: target },
      {
        type: "series",
        id: "tt7654321:1:2",
        canonical: "chill:episode:tt7654321:1:2",
      },
    ]) {
      const response = await fetch(
        `${f.base()}/stream/${input.type}/${encodeURIComponent(input.id)}.json`,
      );
      assert.equal(response.status, 200);
      const stream = await decode(response, Streams);
      assert.equal(stream.streams.length, 1);
      assert.equal(
        stream.streams[0]?.url,
        `${f.base()}/play/${input.type}/${encodeURIComponent(input.canonical)}/fixture-release.m3u8`,
      );
    }
    assert.deepEqual(f.searches, [
      "Independent film 2024",
      "Independent series S01E02",
    ]);
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("library subtitle resources return the file's tracks without starting downloads", async () => {
  const f = await fixture();
  try {
    const response = await fetch(
      `${f.base()}/subtitles/movie/chill%3Afile%3A50.json`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      subtitles: [
        {
          id: "english-50",
          lang: "eng",
          url: "https://media.fixture.test/subtitles-50.vtt",
        },
      ],
    });
    assert.deepEqual(
      await (
        await fetch(
          `${f.base()}/subtitles/movie/tt1234567/${new URLSearchParams({ filename: "fixture-release.m3u8" })}.json`,
        )
      ).json(),
      { subtitles: [] },
    );
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("credential redaction removes every issued credential from text", () => {
  const text = `GET /s/${ownerCredential}/manifest.json and ${otherCredential}`;
  const redacted = redactCredentials(text);
  assert.equal(redacted, "GET /s/[credential]/manifest.json and [credential]");
  assert.doesNotMatch(redacted, /v4\.local\./);
});

test("a finished selection is reused only within its window", async () => {
  const f = await fixture({ selectionReuseMs: 200 });
  try {
    const url = await releaseSelection(f);
    f.state.loseTransferResponse = true;
    const select = async () => {
      const response = await fetch(url, { redirect: "manual" });
      assert.deepEqual(await response.json(), { error: "unknown" });
    };
    await select();
    await select();
    assert.equal(f.state.addCount, 1);
    await sleep(400);
    await select();
    assert.equal(f.state.addCount, 2);
  } finally {
    await f.close();
  }
});
