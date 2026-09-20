import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import {
  GetFolderResponseSchema,
  PlaybackFormatSchema,
  UserFileSchema,
  ResolvePlaybackResponseSchema,
  type GetFolderResponse,
  type ResolvePlaybackResponse,
} from "@chill-institute/contracts/chill/v4/api_pb";
import { Effect, Layer } from "effect";
import { test } from "vite-plus/test";
import { Engine, EngineError } from "../src/engine.ts";
import { createLibrary, LibraryError } from "../src/library.ts";

const largeId = 9223372036854775807n;
const request = { type: "movie", id: `chill:file:${largeId}` };
function folder(): GetFolderResponse {
  return create(GetFolderResponseSchema, {
    parent: { id: 42n, fileType: "FOLDER" },
    files: [
      { id: largeId, name: "My own movie.mkv", fileType: "VIDEO" },
      { id: 2n, name: "Notes.txt", fileType: "FILE" },
      { id: 3n, name: "Subfolder", fileType: "FOLDER" },
    ],
  });
}
function ready(): ResolvePlaybackResponse {
  return create(ResolvePlaybackResponseSchema, {
    result: {
      case: "ready",
      value: {
        media: {
          url: "https://media.example/video?token=fixture-only",
          expiry: { case: "expiryUnknown", value: true },
        },
        format: { container: 1, videoCodec: 1, audioCodec: 1 },
      },
    },
  });
}
function fixture(playback = ready(), listing = folder()) {
  const calls: Array<{ method: string; id: bigint }> = [];
  const layer = Layer.succeed(
    Engine,
    Engine.of({
      getFolder: (id) =>
        Effect.sync(() => {
          calls.push({ method: "getFolder", id });
          return listing;
        }),
      resolvePlayback: (id) =>
        Effect.sync(() => {
          calls.push({ method: "resolvePlayback", id });
          return playback;
        }),
    }),
  );
  return { calls, layer, listing };
}

test("catalog preserves int64 IDs and filename metadata without external matching", async () => {
  const f = fixture();
  const library = createLibrary(42n);
  const catalog = await Effect.runPromise(
    library
      .catalog({ type: "movie", id: "library" })
      .pipe(Effect.provide(f.layer)),
  );
  assert.deepEqual(catalog, {
    metas: [
      {
        id: request.id,
        type: "movie",
        name: "My own movie.mkv",
        behaviorHints: { defaultVideoId: request.id },
      },
    ],
  });
  assert.deepEqual(
    await Effect.runPromise(
      library.meta(request).pipe(Effect.provide(f.layer)),
    ),
    { meta: catalog.metas[0] },
  );
  assert.deepEqual(f.calls, [
    { method: "getFolder", id: 42n },
    { method: "getFolder", id: 42n },
  ]);
});

test("catalog bounds pages, filters names and rejects oversized folders", async () => {
  const listing = folder();
  listing.files = Array.from({ length: 101 }, (_, index) =>
    create(UserFileSchema, {
      id: BigInt(index + 1),
      name: `Film ${index}`,
      fileType: "VIDEO",
    }),
  );
  const f = fixture(ready(), listing);
  const library = createLibrary(42n);
  const catalog = (extra = {}) =>
    Effect.runPromise(
      library
        .catalog({ type: "movie", id: "library", extra })
        .pipe(Effect.provide(f.layer)),
    );
  assert.equal((await catalog()).metas.length, 100);
  assert.equal((await catalog({ skip: "100" })).metas.length, 1);
  assert.equal((await catalog({ search: "FILM 100" })).metas.length, 1);
  listing.files = Array.from({ length: 5001 }, (_, index) =>
    create(UserFileSchema, {
      id: BigInt(index + 1),
      name: "Video",
      fileType: "VIDEO",
    }),
  );
  await assert.rejects(catalog(), { code: "library_too_large" });
});

test("invalid request IDs and folder configuration fail before Engine calls", async () => {
  const f = fixture();
  for (const id of [
    "chill:file:0",
    "chill:file:01",
    "chill:file:-1",
    "chill:file:9223372036854775808",
    "tt123",
    "chill:file:1?token=secret",
  ]) {
    await assert.rejects(
      Effect.runPromise(
        createLibrary(42n)
          .streams({ type: "movie", id })
          .pipe(Effect.provide(f.layer)),
      ),
      { code: "invalid_request" },
    );
  }
  for (const id of [-1n, largeId + 1n]) {
    await assert.rejects(
      Effect.runPromise(
        createLibrary(id).meta(request).pipe(Effect.provide(f.layer)),
      ),
      { code: "invalid_request" },
    );
  }
  await assert.rejects(
    Effect.runPromise(
      createLibrary(42n)
        .catalog({ type: "movie", id: "library", extra: { skip: "-1" } })
        .pipe(Effect.provide(f.layer)),
    ),
    { code: "invalid_request" },
  );
  assert.deepEqual(f.calls, []);
});

test("every meta and stream rechecks current selected folder membership", async () => {
  const f = fixture();
  const library = createLibrary(42n);
  await Effect.runPromise(library.meta(request).pipe(Effect.provide(f.layer)));
  f.listing.files = [];
  assert.deepEqual(
    await Effect.runPromise(
      library.streams(request).pipe(Effect.provide(f.layer)),
    ),
    { streams: [] },
  );
  assert.deepEqual(
    await Effect.runPromise(
      library.meta(request).pipe(Effect.provide(f.layer)),
    ),
    { meta: null },
  );
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls.every((call) => call.method === "getFolder"));
});

test("folder escape and nonvideo files never reach playback resolution", async () => {
  const f = fixture();
  for (const id of ["chill:file:2", "chill:file:3", "chill:file:999"]) {
    assert.deepEqual(
      await Effect.runPromise(
        createLibrary(42n)
          .streams({ type: "movie", id })
          .pipe(Effect.provide(f.layer)),
      ),
      { streams: [] },
    );
  }
  assert.ok(f.calls.every((call) => call.method === "getFolder"));
  const parent = f.listing.parent;
  assert.ok(parent);
  parent.id = 43n;
  await assert.rejects(
    Effect.runPromise(
      createLibrary(42n).streams(request).pipe(Effect.provide(f.layer)),
    ),
    { code: "invalid_response" },
  );
});

test("direct media uses exact ID, marks verified codecs Web ready, preserves opaque URL", async () => {
  const f = fixture();
  const result = await Effect.runPromise(
    createLibrary(42n).streams(request).pipe(Effect.provide(f.layer)),
  );
  assert.equal(
    result.streams[0]?.url,
    "https://media.example/video?token=fixture-only",
  );
  assert.equal(result.streams[0]?.behaviorHints?.notWebReady, false);
  assert.deepEqual(f.calls, [
    { method: "getFolder", id: 42n },
    { method: "resolvePlayback", id: largeId },
  ]);
});

test("unknown or future format is never advertised Web ready", async () => {
  for (const format of [
    undefined,
    { container: 0, videoCodec: 0, audioCodec: 0 },
    { container: 99, videoCodec: 1, audioCodec: 1 },
  ]) {
    const response = ready();
    assert.equal(response.result.case, "ready");
    if (response.result.case !== "ready") throw new Error("fixture");
    response.result.value.format =
      format === undefined ? undefined : create(PlaybackFormatSchema, format);
    const f = fixture(response);
    const result = await Effect.runPromise(
      createLibrary(42n).streams(request).pipe(Effect.provide(f.layer)),
    );
    assert.equal(result.streams[0]?.behaviorHints?.notWebReady, true);
  }
});

test("HLS sources reach the client's HLS player without inventing codec metadata", async () => {
  const response = ready();
  if (response.result.case !== "ready" || !response.result.value.media)
    throw new Error("fixture");
  response.result.value.media.url =
    "https://media.example/master.m3u8?oauth_token=playback-only";
  response.result.value.format = undefined;
  const f = fixture(response);
  const result = await Effect.runPromise(
    createLibrary(42n).streams(request).pipe(Effect.provide(f.layer)),
  );
  assert.equal(
    result.streams[0]?.url,
    "https://media.example/master.m3u8?oauth_token=playback-only",
  );
  assert.equal(result.streams[0]?.behaviorHints?.notWebReady, false);
});

test("pending and unavailable are empty but malformed states reject", async () => {
  for (const response of [
    create(ResolvePlaybackResponseSchema, {
      result: { case: "pending", value: { reason: 1 } },
    }),
    create(ResolvePlaybackResponseSchema, {
      result: { case: "unavailable", value: { reason: 1 } },
    }),
  ]) {
    const f = fixture(response);
    assert.deepEqual(
      await Effect.runPromise(
        createLibrary(42n).streams(request).pipe(Effect.provide(f.layer)),
      ),
      { streams: [] },
    );
  }
  for (const response of [
    create(ResolvePlaybackResponseSchema),
    create(ResolvePlaybackResponseSchema, {
      result: { case: "ready", value: {} },
    }),
    create(ResolvePlaybackResponseSchema, {
      result: { case: "pending", value: {} },
    }),
  ]) {
    const f = fixture(response);
    await assert.rejects(
      Effect.runPromise(
        createLibrary(42n).streams(request).pipe(Effect.provide(f.layer)),
      ),
      { code: "invalid_response" },
    );
  }
});

test("invalid or expired signed URLs reject without exposing them in errors", async () => {
  for (const media of [
    {
      url: "http://media.example/secret",
      expiry: { case: "expiryUnknown" as const, value: true },
    },
    {
      url: "https://user:secret@media.example/video",
      expiry: { case: "expiryUnknown" as const, value: true },
    },
    {
      url: "https://media.example/secret",
      expiry: { case: "expiryUnknown" as const, value: false },
    },
    {
      url: "https://media.example/secret",
      expiry: { case: "expiresAt" as const, value: { seconds: 1n, nanos: 0 } },
    },
  ]) {
    const f = fixture(
      create(ResolvePlaybackResponseSchema, {
        result: { case: "ready", value: { media } },
      }),
    );
    await assert.rejects(
      Effect.runPromise(
        createLibrary(42n).streams(request).pipe(Effect.provide(f.layer)),
      ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error instanceof LibraryError);
        assert.equal(error.code, "invalid_response");
        assert.doesNotMatch(error.message, /secret|media.example/);
        return true;
      },
    );
  }
});

test("subtitles require unique safe IDs and valid independent URLs", async () => {
  const subtitle = {
    id: "english",
    language: "eng",
    format: 1,
    source: {
      url: "https://media.example/sub.vtt",
      expiry: { case: "expiryUnknown" as const, value: true },
    },
  };
  const response = (subtitles: (typeof subtitle)[]) =>
    create(ResolvePlaybackResponseSchema, {
      result: {
        case: "ready",
        value: {
          media: {
            url: "https://media.example/video",
            expiry: { case: "expiryUnknown", value: true },
          },
          subtitles,
        },
      },
    });
  const f = fixture(response([subtitle]));
  const result = await Effect.runPromise(
    createLibrary(42n).streams(request).pipe(Effect.provide(f.layer)),
  );
  assert.deepEqual(result.streams[0]?.subtitles, [
    { id: "english", lang: "eng", url: "https://media.example/sub.vtt" },
  ]);
  for (const tracks of [
    [subtitle, subtitle],
    [{ ...subtitle, id: "https://secret" }],
    [{ ...subtitle, language: "english" }],
    Array.from({ length: 33 }, (_, i) => ({ ...subtitle, id: `track${i}` })),
  ]) {
    const bad = fixture(response(tracks));
    await assert.rejects(
      Effect.runPromise(
        createLibrary(42n).streams(request).pipe(Effect.provide(bad.layer)),
      ),
      { code: "invalid_response" },
    );
  }
});

test("Engine auth and provider failures propagate instead of becoming empty playback", async () => {
  for (const code of [
    "unauthenticated",
    "resource_exhausted",
    "unavailable",
  ] as const) {
    const layer = Layer.succeed(
      Engine,
      Engine.of({
        getFolder: () => Effect.succeed(folder()),
        resolvePlayback: () => Effect.fail(new EngineError({ code })),
      }),
    );
    await assert.rejects(
      Effect.runPromise(
        createLibrary(42n).streams(request).pipe(Effect.provide(layer)),
      ),
      { code },
    );
  }
});

function treeFixture() {
  const folders = new Map<bigint, GetFolderResponse>([
    [
      0n,
      create(GetFolderResponseSchema, {
        parent: { id: 0n, fileType: "FOLDER" },
        files: [
          { id: 1n, name: "Movie", fileType: "VIDEO" },
          { id: 2n, name: "Shows", fileType: "FOLDER" },
        ],
      }),
    ],
    [
      2n,
      create(GetFolderResponseSchema, {
        parent: { id: 2n, fileType: "FOLDER" },
        files: [{ id: 3n, name: "Season", fileType: "FOLDER" }],
      }),
    ],
    [
      3n,
      create(GetFolderResponseSchema, {
        parent: { id: 3n, fileType: "FOLDER" },
        files: [
          { id: largeId, name: "Nested episode", fileType: "VIDEO" },
          { id: 4n, name: "Notes", fileType: "FILE" },
        ],
      }),
    ],
  ]);
  const calls: bigint[] = [];
  const resolved: bigint[] = [];
  const layer = Layer.succeed(
    Engine,
    Engine.of({
      getFolder: (id) =>
        Effect.suspend(() => {
          calls.push(id);
          const listing = folders.get(id);
          return listing
            ? Effect.succeed(listing)
            : Effect.fail(new EngineError({ code: "not_found" }));
        }),
      resolvePlayback: (id) =>
        Effect.sync(() => {
          resolved.push(id);
          return ready();
        }),
    }),
  );
  const library = createLibrary(0n, true);
  const catalog = (extra = {}) =>
    Effect.runPromise(
      library
        .catalog({ type: "movie", id: "library", extra })
        .pipe(Effect.provide(layer)),
    );
  return { folders, calls, resolved, layer, library, catalog };
}

test("whole library lists and searches nested videos and rechecks membership before playing", async () => {
  const f = treeFixture();
  assert.deepEqual(
    (await f.catalog()).metas.map((file) => file.name),
    ["Movie", "Nested episode"],
  );
  assert.deepEqual(
    (await f.catalog({ search: "EPISODE" })).metas.map((file) => file.id),
    [request.id],
  );
  assert.equal(
    (
      await Effect.runPromise(
        f.library.streams(request).pipe(Effect.provide(f.layer)),
      )
    ).streams.length,
    1,
  );
  assert.deepEqual(f.resolved, [largeId]);
  const season = f.folders.get(3n);
  assert.ok(season);
  season.files = [];
  assert.deepEqual(
    await Effect.runPromise(
      f.library.streams(request).pipe(Effect.provide(f.layer)),
    ),
    { streams: [] },
  );
  assert.deepEqual(f.resolved, [largeId]);
});

test("whole library paginates across folders without crawling beyond a full page", async () => {
  const f = treeFixture();
  const root = f.folders.get(0n);
  assert.ok(root);
  root.files.push(
    ...Array.from({ length: 99 }, (_, i) =>
      create(UserFileSchema, {
        id: BigInt(100 + i),
        name: `Root ${i}`,
        fileType: "VIDEO",
      }),
    ),
  );
  assert.equal((await f.catalog()).metas.length, 100);
  assert.deepEqual(f.calls, [0n]);
  assert.deepEqual(
    (await f.catalog({ skip: "100" })).metas.map((file) => file.name),
    ["Nested episode"],
  );
});

test("legacy folder libraries do not expand to nested files", async () => {
  const f = treeFixture();
  const result = await Effect.runPromise(
    createLibrary(2n)
      .catalog({ type: "movie", id: "library" })
      .pipe(Effect.provide(f.layer)),
  );
  assert.deepEqual(result.metas, []);
  assert.deepEqual(f.calls, [2n]);
});

test("nested folder errors and mismatched parents fail rather than returning a partial library", async () => {
  const f = treeFixture();
  const season = f.folders.get(3n);
  assert.ok(season?.parent);
  season.parent.id = 999n;
  await assert.rejects(f.catalog(), { code: "invalid_response" });
  f.folders.delete(3n);
  await assert.rejects(f.catalog(), { code: "not_found" });
});

test("cyclic and duplicate folder entries fail without unbounded requests", async () => {
  const f = treeFixture();
  const season = f.folders.get(3n);
  assert.ok(season);
  season.files.push(
    create(UserFileSchema, { id: 2n, name: "Cycle", fileType: "FOLDER" }),
  );
  await assert.rejects(f.catalog(), { code: "invalid_response" });
  assert.deepEqual(f.calls, [0n, 2n, 3n]);
});

test("whole-library traversal bounds folder fanout and depth", async () => {
  const f = treeFixture();
  const root = f.folders.get(0n);
  assert.ok(root);
  root.files = Array.from({ length: 1000 }, (_, i) =>
    create(UserFileSchema, {
      id: BigInt(i + 1),
      name: "Folder",
      fileType: "FOLDER",
    }),
  );
  await assert.rejects(f.catalog(), { code: "library_too_large" });
  assert.deepEqual(f.calls, [0n]);
  f.folders.clear();
  for (let i = 0; i <= 64; i++)
    f.folders.set(
      BigInt(i),
      create(GetFolderResponseSchema, {
        parent: { id: BigInt(i), fileType: "FOLDER" },
        files: [{ id: BigInt(i + 1), name: "Folder", fileType: "FOLDER" }],
      }),
    );
  await assert.rejects(f.catalog(), { code: "library_too_large" });
});
