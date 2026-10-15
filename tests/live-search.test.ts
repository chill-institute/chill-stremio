import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Schema } from "effect";
import { test, vi } from "vite-plus/test";
import { readLedger, utcDay } from "../harness/live/allowance.ts";
import { getFile, type SearchPage } from "../harness/live/putio.ts";
import {
  runFileSearch,
  searchFixtures,
  searchNonceBytes,
  searchWords,
  type SearchProvider,
} from "../harness/live/search.ts";
import { liveVersions } from "../harness/live/versions.ts";

const nonce = new Uint8Array(
  createHash("shake256", { outputLength: searchNonceBytes })
    .update("live-search-fixture")
    .digest(),
);
const words = searchWords(nonce);
const fixtures = searchFixtures(words);
const folderName = "chill-stremio-live-search-fixture";
const foreign = { id: 5, name: "Neutral Sample.mkv", parent: 0, folder: false };
const mediaBytes = 13;

// Literal tokens: no accent folding, and punctuation only separates.
const terms = (text: string) =>
  text
    .replaceAll(/from:me|type:video/g, " ")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const indexedTerms = (name: string) =>
  terms(name).map((word) => word.slice(0, 20));

interface FakeOptions {
  indexAfterSearches?: number;
  failUpload?: number;
  failSearchAfter?: number;
  failGet?: boolean;
  refuseSearches?: boolean;
  /** Uploads report `FILE` until this many searches have run, then `VIDEO`. */
  typeSettlesAfterSearches?: number;
  /** After this many searches, folder names also match the items inside them. */
  pathsAfterSearches?: number;
  deletion?: "removes" | "ignored" | "rejected";
  onMutation?: () => Promise<void>;
}

function fakePutio(options: FakeOptions = {}) {
  const files = new Map([[foreign.id, foreign]]);
  const calls: string[] = [];
  const names: string[] = [];
  const queries: string[] = [];
  const deleted: number[][] = [];
  let next = 910_001;
  let uploads = 0;
  let searches = 0;
  const mutate = (name: string, parent: number, folder: boolean) =>
    Effect.promise(async () => {
      await options.onMutation?.();
      const id = next++;
      names.push(name);
      files.set(id, { id, name, parent, folder });
      return { id };
    });
  const fileType = (file: typeof foreign) =>
    file.folder
      ? "FOLDER"
      : searches > (options.typeSettlesAfterSearches ?? 0)
        ? "VIDEO"
        : "FILE";
  const searchable = (file: typeof foreign) => {
    const own = indexedTerms(file.name);
    if (searches <= (options.pathsAfterSearches ?? Number.POSITIVE_INFINITY))
      return own;
    for (let at = files.get(file.parent); at; at = files.get(at.parent))
      own.push(...indexedTerms(at.name));
    return own;
  };
  const provider: SearchProvider = {
    accountInfo: () =>
      Effect.sync(() => {
        calls.push("account");
        return { username: "fixture" };
      }),
    createFolder: (name, parent) => {
      calls.push("create-folder");
      return mutate(name, parent, true);
    },
    uploadFile: (_path, name, parent) => {
      calls.push("upload");
      if (++uploads === options.failUpload)
        return Effect.fail(new Error("put.io HTTP 500"));
      return mutate(name, parent, false);
    },
    searchFiles: (query) =>
      Effect.suspend(() => {
        calls.push("search");
        queries.push(query);
        searches++;
        if (
          options.failSearchAfter !== undefined &&
          searches > options.failSearchAfter
        )
          return Effect.fail(new Error("put.io search HTTP 503"));
        if (options.refuseSearches)
          return Effect.succeed<SearchPage>({
            ok: false,
            httpStatus: 400,
            errorType:
              searches % 2 ? "SEARCH_UNAVAILABLE" : `invalid query ${query}`,
          });
        const wanted = terms(query);
        if (wanted.some((word) => word.length > 20))
          return Effect.succeed<SearchPage>({
            ok: false,
            httpStatus: 400,
            errorType: "SEARCH_TOO_LONG_QUERY",
          });
        const indexed = searches > (options.indexAfterSearches ?? 0);
        const matches = [...files.values()].filter(
          (file) =>
            (indexed || file.id === foreign.id) &&
            wanted.every((word) => searchable(file).includes(word)),
        );
        return Effect.succeed<SearchPage>({
          ok: true,
          files: matches.map((file) => ({
            id: file.id,
            name: file.name,
            parent_id: file.parent,
            file_type: fileType(file),
            is_shared: false,
          })),
          cursor: false,
          total: matches.length,
        });
      }),
    deleteFiles: (ids) =>
      Effect.suspend(() => {
        calls.push("delete");
        deleted.push([...ids]);
        // Echoes everything the run sent, so the receipt scrub is exercised.
        if (options.deletion === "rejected")
          return Effect.fail(
            new Error(
              `put.io HTTP 500 for ${[...names, ...queries].join(" | ")}`,
            ),
          );
        if (options.deletion === "ignored") return Effect.void;
        const doomed = new Set(ids);
        let grew = true;
        while (grew) {
          grew = false;
          for (const file of files.values())
            if (doomed.has(file.parent) && !doomed.has(file.id)) {
              doomed.add(file.id);
              grew = true;
            }
        }
        for (const id of doomed) files.delete(id);
        return Effect.void;
      }),
    fileExists: (id) => Effect.sync(() => files.has(id)),
    getFile: (id) =>
      Effect.suspend(() => {
        calls.push("get");
        if (options.failGet) return Effect.fail(new Error("put.io HTTP 502"));
        const file = files.get(id);
        return Effect.succeed(file && { fileType: fileType(file) });
      }),
  };
  return { provider, files, calls, queries, deleted };
}

const Receipt = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    proof: Schema.Struct({
      failureStage: Schema.optional(Schema.String),
      reservation: Schema.optional(
        Schema.Struct({ creations: Schema.Number, bytes: Schema.Number }),
      ),
      fixtures: Schema.Record(
        Schema.String,
        Schema.Struct({
          indexedAfterMs: Schema.optional(Schema.Number),
          fileType: Schema.optional(Schema.String),
          isShared: Schema.optional(Schema.Boolean),
          parentIdMatches: Schema.optional(Schema.Boolean),
        }),
      ),
      indexing: Schema.Struct({
        polls: Schema.optional(Schema.Number),
        refused: Schema.optional(
          Schema.Struct({
            count: Schema.Number,
            httpStatuses: Schema.Array(Schema.Number),
            errorTypes: Schema.Array(Schema.String),
          }),
        ),
        allIndexed: Schema.optional(Schema.Boolean),
        notSeen: Schema.optional(Schema.Array(Schema.String)),
      }),
      queries: Schema.Array(
        Schema.Struct({
          form: Schema.String,
          outcome: Schema.String,
          errorType: Schema.optional(Schema.String),
          matched: Schema.Array(Schema.String),
          items: Schema.Array(
            Schema.Struct({
              label: Schema.String,
              fileType: Schema.optional(Schema.String),
              parent: Schema.optional(Schema.String),
            }),
          ),
          unlabeled: Schema.Number,
          results: Schema.Number,
          total: Schema.optional(Schema.Number),
          cursor: Schema.Boolean,
          fields: Schema.Array(Schema.String),
        }),
      ),
      reread: Schema.Struct({
        afterMs: Schema.optional(Schema.Number),
        searches: Schema.optional(Schema.Number),
        refused: Schema.optional(Schema.Number),
        fixtures: Schema.optional(
          Schema.Record(
            Schema.String,
            Schema.Struct({
              found: Schema.Boolean,
              fileType: Schema.optional(Schema.String),
              searchSeen: Schema.Boolean,
              searchFileType: Schema.optional(Schema.String),
            }),
          ),
        ),
      }),
    }),
    cleanup: Schema.Struct({
      status: Schema.String,
      verification: Schema.Struct({
        status: Schema.String,
        checked: Schema.Number,
        present: Schema.optional(Schema.Number),
      }),
    }),
  }),
);

async function runLane(
  options: FakeOptions & { reservedBytes?: number; username?: string } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "live-search-"));
  const ledger = join(directory, "allowance.json");
  const reservedAtMutation: number[] = [];
  const putio = fakePutio({
    ...options,
    onMutation: async () => {
      reservedAtMutation.push((await readLedger(ledger)).reservedTransfers);
    },
  });
  try {
    await writeFile(
      ledger,
      JSON.stringify({
        day: utcDay(),
        reservedTransfers: 2,
        reservedBytes: options.reservedBytes ?? 100,
      }),
      { mode: 0o600 },
    );
    const media = join(directory, "movie.mp4");
    await writeFile(media, Buffer.alloc(mediaBytes));
    const journalPath = join(directory, "recovery", "search.json");
    const exit = await Effect.runPromiseExit(
      runFileSearch({
        username: options.username ?? "fixture",
        ledgerDirectory: async () => directory,
        provider: putio.provider,
        media: { path: media, bytes: mediaBytes },
        artifact: join(directory, "artifact"),
        journal: journalPath,
        folderName,
        nonce,
        timing: {
          pollIntervalMs: 1,
          indexDeadlineMs: 40,
          settleMs: 20,
          verifyAttempts: 2,
          verifyIntervalMs: 1,
        },
      }),
    );
    const receiptText = await readFile(
      join(directory, "artifact", "results.json"),
      "utf8",
    );
    const journal = await readFile(journalPath, "utf8").catch(() => "");
    return {
      exit,
      putio,
      reservedAtMutation,
      receiptText,
      receipt: Schema.decodeUnknownSync(Receipt)(receiptText),
      journal,
      journalMode: journal ? (await stat(journalPath)).mode & 0o777 : 0,
      ledger: await readLedger(ledger),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const publicTerms = new Set(["from:me", "type:video", "and"]);

const assertPrivateReceipt = (
  text: string,
  ids: Iterable<number>,
  queries: readonly string[],
) => {
  const lower = text.toLowerCase();
  const fragments = [
    ...Object.values(words),
    words.long.slice(0, 20),
    ...queries.flatMap((query) => [query, ...query.split(" ")]),
  ].filter((fragment) => !publicTerms.has(fragment));
  for (const fragment of fragments)
    assert.ok(!lower.includes(fragment.toLowerCase()), fragment);
  for (const fixture of fixtures) assert.ok(!text.includes(fixture.name));
  assert.ok(!text.includes(folderName));
  assert.ok(!text.includes(foreign.name));
  for (const id of ids) assert.ok(!text.includes(String(id)));
};

test("search forms are measured by label and the run folder is verified gone", async () => {
  const run = await runLane({ indexAfterSearches: 2 });
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(run.receipt.status, "passed");
  assert.deepEqual(
    run.receipt.proof.queries.map((query) => query.form),
    [
      "plain",
      "plain-from-me-video",
      "quoted",
      "dotted",
      "underscored",
      "single-word",
      "episode",
      "episode-from-me-video",
      "long-prefix-20",
      "long-full-24",
      "typo",
      "apostrophe-dropped",
      "apostrophe-kept",
      "ampersand-and",
      "ampersand-omitted",
      "accent-folded",
      "accent-kept",
      "movie-folder",
      "show-folder",
    ],
  );
  const forms = Object.fromEntries(
    run.receipt.proof.queries.map((query) => [query.form, query]),
  );
  assert.deepEqual(forms.plain?.matched, [
    "movie-dotted",
    "movie-spaced",
    "movie-underscored",
  ]);
  assert.deepEqual(forms.underscored?.matched, forms.plain?.matched);
  assert.deepEqual(forms["single-word"]?.matched, [
    "movie-dotted",
    "movie-spaced",
    "movie-underscored",
    "decoy",
  ]);
  assert.deepEqual(forms["episode-from-me-video"]?.matched, ["episode-nested"]);
  assert.deepEqual(forms["long-prefix-20"]?.matched, ["long-word"]);
  assert.equal(forms["long-full-24"]?.outcome, "refused");
  assert.equal(forms["long-full-24"]?.errorType, "SEARCH_TOO_LONG_QUERY");
  assert.deepEqual(forms.typo?.matched, []);
  assert.deepEqual(forms["apostrophe-dropped"]?.matched, []);
  assert.deepEqual(forms["apostrophe-kept"]?.matched, ["apostrophe"]);
  assert.deepEqual(forms["ampersand-and"]?.matched, []);
  assert.deepEqual(forms["ampersand-omitted"]?.matched, ["ampersand"]);
  assert.deepEqual(forms["accent-folded"]?.matched, []);
  assert.deepEqual(forms["accent-kept"]?.matched, ["accent"]);
  assert.deepEqual(forms["movie-folder"]?.items, [
    { label: "movie-folder", fileType: "FOLDER", parent: "run-folder" },
  ]);
  assert.deepEqual(forms["show-folder"]?.items, [
    { label: "show-folder", fileType: "FOLDER", parent: "run-folder" },
  ]);
  assert.deepEqual(forms["episode-from-me-video"]?.items, [
    { label: "episode-nested", fileType: "VIDEO", parent: "season-folder" },
  ]);
  assert.equal(forms.plain?.total, 3);
  assert.equal(forms.plain?.cursor, false);
  assert.deepEqual(forms.plain?.fields, [
    "file_type",
    "id",
    "is_shared",
    "name",
    "parent_id",
  ]);
  const episode = run.receipt.proof.fixtures["episode-nested"];
  assert.ok((episode?.indexedAfterMs ?? -1) >= 0);
  assert.equal(episode?.fileType, "VIDEO");
  assert.equal(episode?.isShared, false);
  assert.equal(episode?.parentIdMatches, true);
  // Generic names carry no poll word, so the wait does not hold for them.
  assert.equal(run.receipt.proof.indexing.allIndexed, true);
  assert.deepEqual(run.receipt.proof.indexing.notSeen, [
    "movie-folder-file",
    "show-folder-season",
    "show-folder-episode",
  ]);
  const reread = run.receipt.proof.reread;
  assert.equal(reread.searches, 8);
  assert.equal(reread.refused, 0);
  assert.deepEqual(
    Object.keys(reread.fixtures ?? {}),
    fixtures.map((item) => item.label),
  );
  for (const fixture of fixtures)
    assert.deepEqual(reread.fixtures?.[fixture.label], {
      found: true,
      fileType: fixture.folder ? "FOLDER" : "VIDEO",
      searchSeen: !fixture.generic,
      ...(fixture.generic
        ? {}
        : { searchFileType: fixture.folder ? "FOLDER" : "VIDEO" }),
    });
  assert.deepEqual(run.receipt.proof.indexing.refused, {
    count: 0,
    httpStatuses: [],
    errorTypes: [],
  });
  assert.deepEqual(run.receipt.proof.reservation, {
    creations: 16,
    bytes: 11 * mediaBytes,
  });
  assert.equal(run.receipt.cleanup.status, "acknowledged");
  assert.deepEqual(run.receipt.cleanup.verification, {
    status: "verified",
    checked: 16,
    present: 0,
  });
  assert.deepEqual([...run.putio.files.keys()], [foreign.id]);
  assert.equal(run.putio.deleted.length, 1);
  assert.ok(!run.putio.deleted[0]?.includes(foreign.id));
  assertPrivateReceipt(
    run.receiptText,
    run.putio.deleted[0] ?? [],
    run.putio.queries,
  );
  assert.equal(run.journalMode, 0o600);
  for (const fixture of fixtures) assert.ok(run.journal.includes(fixture.name));
});

test("the allowance is reserved before the first provider mutation", async () => {
  const run = await runLane();
  assert.equal(run.receipt.status, "passed");
  assert.equal(run.reservedAtMutation.length, 16);
  assert.ok(run.reservedAtMutation.every((reserved) => reserved === 18));
  assert.equal(run.ledger.reservedBytes, 100 + 11 * mediaBytes);
});

test("folder hits record their type and parent, and path matches list the files inside", async () => {
  const run = await runLane({ pathsAfterSearches: 0 });
  assert.equal(run.receipt.status, "passed");
  const forms = Object.fromEntries(
    run.receipt.proof.queries.map((query) => [query.form, query]),
  );
  assert.deepEqual(forms["movie-folder"]?.items, [
    { label: "movie-folder", fileType: "FOLDER", parent: "run-folder" },
    { label: "movie-folder-file", fileType: "VIDEO", parent: "movie-folder" },
  ]);
  assert.deepEqual(forms["show-folder"]?.items, [
    { label: "show-folder", fileType: "FOLDER", parent: "run-folder" },
    {
      label: "show-folder-season",
      fileType: "FOLDER",
      parent: "show-folder",
    },
    {
      label: "show-folder-episode",
      fileType: "VIDEO",
      parent: "show-folder-season",
    },
  ]);
  assert.deepEqual(run.receipt.proof.indexing.notSeen, []);
  assert.equal(
    run.receipt.proof.fixtures["show-folder-episode"]?.parentIdMatches,
    true,
  );
  assert.equal(
    run.receipt.proof.reread.fixtures?.["show-folder-episode"]?.searchSeen,
    true,
  );
});

test("the re-read records file types after settling apart from the first sighting", async () => {
  // Types settle after the first poll round; paths match only in the re-read.
  const run = await runLane({
    typeSettlesAfterSearches: 8,
    pathsAfterSearches: 27,
  });
  assert.equal(run.receipt.status, "passed");
  const { fixtures: first, reread } = run.receipt.proof;
  assert.equal(first["episode-nested"]?.fileType, "FILE");
  assert.deepEqual(reread.fixtures?.["episode-nested"], {
    found: true,
    fileType: "VIDEO",
    searchSeen: true,
    searchFileType: "VIDEO",
  });
  assert.deepEqual(first["movie-folder-file"], {});
  assert.deepEqual(reread.fixtures?.["movie-folder-file"], {
    found: true,
    fileType: "VIDEO",
    searchSeen: true,
    searchFileType: "VIDEO",
  });
  assert.ok((reread.afterMs ?? -1) >= 0);
});

for (const refusal of [
  { name: "an exhausted allowance", stage: "reservation", reserved: true },
  { name: "a token for another account", stage: "account", reserved: false },
] as const)
  test(`${refusal.name} stops before any mutation`, async () => {
    const run = await runLane(
      refusal.reserved
        ? { reservedBytes: liveVersions.byteLimit }
        : { username: "someone-else" },
    );
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, refusal.stage);
    assert.deepEqual(run.putio.calls, ["account"]);
    assert.equal(run.ledger.reservedTransfers, 2);
    assert.equal(run.receipt.cleanup.verification.status, "not-needed");
  });

for (const failure of [
  {
    name: "a failed upload",
    options: { failUpload: 3 },
    stage: "upload",
    // The lost response may still have created a file inside the run folder.
    cleanup: "uncertain",
  },
  {
    name: "uploads that never appear in search",
    options: { indexAfterSearches: 1_000_000 },
    stage: "indexing",
    cleanup: "acknowledged",
  },
  {
    name: "a search failure",
    options: { failSearchAfter: 10 },
    stage: "queries",
    cleanup: "acknowledged",
  },
  {
    name: "a failed re-read",
    options: { failGet: true },
    stage: "reread",
    cleanup: "acknowledged",
  },
] as const)
  test(`${failure.name} still deletes and verifies only what the run created`, async () => {
    const run = await runLane(failure.options);
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.status, "failed");
    assert.equal(run.receipt.proof.failureStage, failure.stage);
    assert.equal(run.putio.deleted.length, 1);
    assert.ok(!run.putio.deleted[0]?.includes(foreign.id));
    assert.deepEqual([...run.putio.files.keys()], [foreign.id]);
    assert.equal(run.receipt.cleanup.status, failure.cleanup);
    assert.equal(run.receipt.cleanup.verification.status, "verified");
    assertPrivateReceipt(
      run.receiptText,
      run.putio.deleted[0] ?? [],
      run.putio.queries,
    );
  });

test("search that refuses every poll fails at its own stage", async () => {
  const run = await runLane({ refuseSearches: true });
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.status, "failed");
  assert.equal(run.receipt.proof.failureStage, "search-refused");
  const { polls, refused } = run.receipt.proof.indexing;
  assert.ok((polls ?? 0) > 1);
  assert.deepEqual(refused, {
    count: polls,
    httpStatuses: [400],
    errorTypes: ["SEARCH_UNAVAILABLE"],
  });
  assert.deepEqual(run.receipt.proof.queries, []);
  assert.equal(run.receipt.cleanup.verification.status, "verified");
  assertPrivateReceipt(
    run.receiptText,
    run.putio.deleted[0] ?? [],
    run.putio.queries,
  );
});

for (const deletion of ["ignored", "rejected"] as const)
  test(`a deletion that is ${deletion} leaves the run failed with files present`, async () => {
    const run = await runLane({ deletion });
    assert.equal(run.receipt.status, "failed");
    assert.equal(
      run.receipt.cleanup.status,
      deletion === "ignored" ? "acknowledged" : "uncertain",
    );
    assert.deepEqual(run.receipt.cleanup.verification, {
      status: "present",
      checked: 16,
      present: 16,
    });
    assert.ok(run.journal.includes('"present"'));
    assertPrivateReceipt(
      run.receiptText,
      run.putio.deleted[0] ?? [],
      run.putio.queries,
    );
  });

test("the file read returns put.io's file type", async () => {
  vi.stubEnv(liveVersions.putioTokenEnv, "fixture-token");
  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    fetchMock.mockResolvedValueOnce(
      Response.json({
        status: "OK",
        file: { id: 7, parent_id: 3, file_type: "VIDEO" },
      }),
    );
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    assert.deepEqual(await Effect.runPromise(getFile(7)), {
      id: 7,
      parentId: 3,
      createdAt: undefined,
      fileType: "VIDEO",
    });
    assert.equal(
      fetchMock.mock.calls[0]?.[0],
      `${liveVersions.apiBase}/v2/files/7`,
    );
    assert.equal(await Effect.runPromise(getFile(7)), undefined);
  } finally {
    fetchMock.mockRestore();
    vi.unstubAllEnvs();
  }
});
