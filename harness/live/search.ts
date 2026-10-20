import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Clock, Effect, Exit, Option, Schema } from "effect";
import { reserve } from "./allowance.ts";
import {
  createLiveAttempt,
  trackAcquisition,
  withLiveLifecycle,
  writeRecoveryJournal,
} from "./lifecycle.ts";
import * as putio from "./putio.ts";
import { liveRunnerDirectory } from "./runner.ts";
import { ensureLiveSource } from "./source.ts";
import { liveVersions } from "./versions.ts";

class SearchProbeFailure extends Schema.TaggedError<SearchProbeFailure>()(
  "SearchProbeFailure",
  { stage: Schema.String },
) {}

export interface SearchProvider {
  accountInfo: () => Effect.Effect<{ username: string }, unknown>;
  createFolder: (
    name: string,
    parentId: number,
  ) => Effect.Effect<{ id: number }, unknown>;
  uploadFile: (
    path: string,
    name: string,
    parentId: number,
  ) => Effect.Effect<{ id: number }, unknown>;
  searchFiles: (query: string) => Effect.Effect<putio.SearchPage, unknown>;
  deleteFiles: (ids: readonly number[]) => Effect.Effect<void, unknown>;
  fileExists: (id: number) => Effect.Effect<boolean, unknown>;
  /** `GET /v2/files/<id>`; `undefined` once put.io answers 404. */
  getFile: (
    id: number,
  ) => Effect.Effect<{ fileType?: string | undefined } | undefined, unknown>;
}

export interface SearchTiming {
  pollIntervalMs: number;
  /** How long to wait for the first upload to appear in search. */
  indexDeadlineMs: number;
  /** How long to keep polling for the rest once one upload appeared. */
  settleMs: number;
  verifyAttempts: number;
  verifyIntervalMs: number;
}

export interface SearchOptions {
  username: string | undefined;
  ledgerDirectory: () => Promise<string>;
  provider: SearchProvider;
  media: { path: string; bytes: number };
  artifact: string;
  journal: string;
  folderName: string;
  /** `searchNonceBytes` random bytes; every synthetic word is derived from them. */
  nonce: Uint8Array;
  timing?: Partial<SearchTiming>;
}

const defaultTiming: SearchTiming = {
  pollIntervalMs: 10_000,
  indexDeadlineMs: 180_000,
  settleMs: 60_000,
  verifyAttempts: 3,
  verifyIntervalMs: 3_000,
};

const letters = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => String.fromCodePoint(97 + (byte % 26))).join("");

const titled = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

const acute = "\u00e9";

export const searchNonceBytes = 144;

export function searchWords(nonce: Uint8Array) {
  if (nonce.length !== searchNonceBytes)
    throw new Error(`Search nonce must be ${searchNonceBytes} bytes`);
  const word = (start: number, length: number) =>
    letters(nonce.subarray(start, start + length));
  const a = word(0, 8);
  const shifted = String.fromCodePoint(
    97 + (((a.codePointAt(3) ?? 97) - 97 + 1) % 26),
  );
  const words = {
    a,
    b: word(8, 8),
    c: word(16, 8),
    d: word(24, 8),
    e: word(32, 8),
    long: word(40, 24),
    f: word(64, 8),
    g: word(72, 8),
    h: word(80, 8),
    i: word(88, 8),
    j: word(96, 8),
    k: word(104, 8),
    l: word(112, 8),
    m: word(120, 8),
    n: word(128, 8),
    o: word(136, 8),
    typo: `${a.slice(0, 3)}${shifted}${a.slice(4)}`,
  };
  if (new Set(Object.values(words)).size !== Object.keys(words).length)
    throw new Error("Synthetic search words collided");
  return words;
}

type Words = ReturnType<typeof searchWords>;

export interface SearchFixture {
  label: string;
  name: string;
  /** Label of the folder it is created in; the run folder when omitted. */
  parent?: string;
  folder?: true;
  /** No synthetic word in the name, so no poll can match it by name. */
  generic?: true;
}

export function searchFixtures(words: Words): readonly SearchFixture[] {
  const [a, b, c, d, e, long, f, g, h, i, j, k, l, m, n, o] = [
    words.a,
    words.b,
    words.c,
    words.d,
    words.e,
    words.long,
    words.f,
    words.g,
    words.h,
    words.i,
    words.j,
    words.k,
    words.l,
    words.m,
    words.n,
    words.o,
  ].map(titled);
  return [
    { label: "movie-dotted", name: `${a}.${b}.2001.1080p.WEB.H264.mkv` },
    { label: "movie-spaced", name: `${a} ${b} (2001).mkv` },
    { label: "movie-underscored", name: `${a}_${b}_2001.mkv` },
    { label: "decoy", name: `${a}.${c}.2001.mkv` },
    {
      label: "episode-nested",
      name: `${d}.${e}.S01E02.720p.mkv`,
      parent: "season-folder",
    },
    { label: "long-word", name: `${long} (2001).mkv` },
    { label: "apostrophe", name: `${f}'s.${g}.2003.mkv` },
    { label: "ampersand", name: `${h}.&.${i}.2004.mkv` },
    { label: "accent", name: `${j}${acute}.${k}.2005.mkv` },
    { label: "movie-folder", name: `${n} ${o} (2001)`, folder: true },
    {
      label: "movie-folder-file",
      name: "movie.mkv",
      parent: "movie-folder",
      generic: true,
    },
    { label: "show-folder", name: `${l} ${m}`, folder: true },
    {
      label: "show-folder-season",
      name: "Season 01",
      parent: "show-folder",
      folder: true,
      generic: true,
    },
    {
      label: "show-folder-episode",
      name: "S01E02.mkv",
      parent: "show-folder-season",
      generic: true,
    },
  ];
}

/** Single-word queries polled until uploads appear in search. */
function searchPolls(words: Words) {
  return [
    words.a,
    words.d,
    words.long.slice(0, 20),
    words.g,
    words.i,
    words.k,
    words.l,
    words.n,
  ];
}

export function searchQueries(words: Words) {
  const scope = "from:me type:video";
  return [
    { form: "plain", query: `${words.a} ${words.b}` },
    { form: "plain-from-me-video", query: `${words.a} ${words.b} ${scope}` },
    { form: "quoted", query: `"${words.a} ${words.b}"` },
    { form: "dotted", query: `${words.a}.${words.b}` },
    { form: "underscored", query: `${words.a}_${words.b}` },
    { form: "single-word", query: words.a },
    { form: "episode", query: `${words.d} ${words.e}` },
    { form: "episode-from-me-video", query: `${words.d} ${words.e} ${scope}` },
    { form: "long-prefix-20", query: words.long.slice(0, 20) },
    { form: "long-full-24", query: words.long },
    { form: "typo", query: `${words.typo} ${words.b}` },
    { form: "apostrophe-dropped", query: `${words.f}s ${words.g}` },
    { form: "apostrophe-kept", query: `${words.f}'s ${words.g}` },
    { form: "ampersand-and", query: `${words.h} and ${words.i}` },
    { form: "ampersand-omitted", query: `${words.h} ${words.i}` },
    { form: "accent-folded", query: `${words.j}e ${words.k}` },
    { form: "accent-kept", query: `${words.j}${acute} ${words.k}` },
    { form: "movie-folder", query: `${words.n} ${words.o}` },
    { form: "show-folder", query: `${words.l} ${words.m}` },
  ];
}

/**
 * Every folder name, file name, query and query fragment the run sends that
 * carries a synthetic word, longest first so whole strings are replaced
 * before their parts.
 */
function searchSecrets(words: Words, folderName: string) {
  const roots = [...Object.values(words), words.long.slice(0, 20)];
  const sent = [
    ...searchFixtures(words).map((item) => item.name),
    ...searchPolls(words),
    ...searchQueries(words).map((item) => item.query),
  ];
  const fragments = sent
    .flatMap((text) => text.split(" "))
    .filter((fragment) =>
      roots.some((root) => fragment.toLowerCase().includes(root)),
    );
  return [...new Set([folderName, ...sent, ...fragments, ...roots])].sort(
    (left, right) => right.length - left.length,
  );
}

const escapeRegExp = (text: string) =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ResultItem = Schema.Struct({
  id: Schema.Number,
  file_type: Schema.optional(Schema.NullOr(Schema.String)),
  is_shared: Schema.optional(Schema.NullOr(Schema.Boolean)),
  parent_id: Schema.optional(Schema.NullOr(Schema.Number)),
});
const decodeItem = Schema.decodeUnknownOption(ResultItem);
const fieldName = /^[a-z][a-z0-9_]{0,63}$/;
const enumValue = /^[A-Z_]{1,32}$/;
const errorTypeOf = (refusal: { errorType?: string }) =>
  refusal.errorType && enumValue.test(refusal.errorType)
    ? refusal.errorType
    : undefined;

interface FixtureObservation {
  indexedAfterMs?: number;
  fileType?: string;
  isShared?: boolean;
  parentIdMatches?: boolean;
}

/** One owned search result; `parent` is the label `parent_id` names, or `other`. */
interface ResultObservation {
  label: string;
  fileType?: string;
  parent?: string;
}

interface RereadObservation {
  /** `GET /v2/files/<id>` still found the item. */
  found: boolean;
  fileType?: string;
  /** The repeated poll pass returned the item. */
  searchSeen: boolean;
  searchFileType?: string;
}

interface QueryObservation {
  form: string;
  outcome: "ok" | "refused";
  httpStatus?: number;
  errorType?: string;
  matched: string[];
  items: ResultObservation[];
  unlabeled: number;
  results: number;
  total?: number;
  cursor: boolean;
  fields: string[];
}

type Verification = {
  status: "not-needed" | "verified" | "present" | "unverified";
  checked: number;
  present?: number;
};

export const runFileSearch = Effect.fn("live.runFileSearch")(function* (
  options: SearchOptions,
) {
  const { provider } = options;
  const timing = { ...defaultTiming, ...options.timing };
  const words = searchWords(options.nonce);
  const fixtures = searchFixtures(words);
  const queries = searchQueries(words);
  const attempt = createLiveAttempt();
  const ids: Record<string, number> = {};
  attempt.recovery = {
    folder: options.folderName,
    names: Object.fromEntries(fixtures.map((item) => [item.label, item.name])),
    ids,
  };
  const checkpoint = writeRecoveryJournal(attempt, options.journal);
  const parents = new Map<string, number>();
  const observed: Record<string, FixtureObservation> = Object.fromEntries(
    fixtures.map((item) => [item.label, {}]),
  );
  const indexing: Record<string, unknown> = {};
  const results: QueryObservation[] = [];
  const reread: Record<string, unknown> = {};
  const proof: Record<string, unknown> = {
    source: "self-generated-fixture",
    fixtures: observed,
    indexing,
    queries: results,
    reread,
  };
  let stage = "configuration";
  const fail = (at: string) => new SearchProbeFailure({ stage: at });
  const labelOf = (id: number) =>
    Object.entries(ids).find(([, owned]) => owned === id)?.[0];
  const typeOf = (value: string | null | undefined) =>
    value && enumValue.test(value) ? value : undefined;

  const inspected = new Set<string>();
  const observe = (item: typeof ResultItem.Type, label: string) => {
    const fixture = observed[label];
    if (!fixture || inspected.has(label)) return;
    inspected.add(label);
    const fileType = typeOf(item.file_type);
    if (fileType) fixture.fileType = fileType;
    if (typeof item.is_shared === "boolean") fixture.isShared = item.is_shared;
    if (item.parent_id !== undefined)
      fixture.parentIdMatches = item.parent_id === parents.get(label);
  };

  /** `first` records first sightings; the re-read pass leaves them alone. */
  const classify = (
    files: readonly Record<string, unknown>[],
    first = true,
  ) => {
    const matched = new Set<string>();
    const items: ResultObservation[] = [];
    let unlabeled = 0;
    const fields = new Set<string>();
    for (const file of files) {
      for (const key of Object.keys(file))
        if (fieldName.test(key)) fields.add(key);
      const item = decodeItem(file);
      const label = Option.isSome(item) ? labelOf(item.value.id) : undefined;
      if (Option.isNone(item) || label === undefined) {
        unlabeled++;
        continue;
      }
      matched.add(label);
      if (first) observe(item.value, label);
      const { file_type, parent_id } = item.value;
      const fileType = typeOf(file_type);
      items.push({
        label,
        ...(fileType ? { fileType } : {}),
        ...(typeof parent_id === "number"
          ? { parent: labelOf(parent_id) ?? "other" }
          : {}),
      });
    }
    return { matched, items, unlabeled, fields };
  };

  const work = Effect.gen(function* () {
    stage = "allowance";
    const ledgerDirectory = yield* Effect.tryPromise(options.ledgerDirectory);
    stage = "account";
    const account = yield* provider.accountInfo();
    if (!options.username || account.username !== options.username)
      return yield* fail(stage);
    stage = "reservation";
    const creations = 2 + fixtures.length;
    const bytes =
      fixtures.filter((item) => !item.folder).length * options.media.bytes;
    yield* Effect.tryPromise((signal) =>
      reserve(ledgerDirectory, creations, bytes, undefined, { signal }),
    );
    proof.reservation = { creations, bytes };

    stage = "upload";
    const create = (label: string, name: string, parentId: number) =>
      trackAcquisition(
        attempt,
        "file",
        provider.createFolder(name, parentId),
        checkpoint,
      ).pipe(
        Effect.tap((folder) => Effect.sync(() => (ids[label] = folder.id))),
      );
    const folder = yield* create("run-folder", options.folderName, 0);
    yield* create("season-folder", "Season 01", folder.id);
    for (const fixture of fixtures) {
      const parent = ids[fixture.parent ?? "run-folder"];
      if (parent === undefined) return yield* fail(stage);
      parents.set(fixture.label, parent);
      if (fixture.folder) {
        yield* create(fixture.label, fixture.name, parent);
        continue;
      }
      const file = yield* trackAcquisition(
        attempt,
        "file",
        provider.uploadFile(options.media.path, fixture.name, parent),
        checkpoint,
      );
      ids[fixture.label] = file.id;
      yield* checkpoint;
    }

    stage = "indexing";
    const started = yield* Clock.currentTimeMillis;
    const pollQueries = searchPolls(words);
    let polls = 0;
    let refused = 0;
    const refusedStatuses = new Set<number>();
    const refusedTypes = new Set<string>();
    let firstAt: number | undefined;
    const unseen = () =>
      fixtures.filter(
        (item) => observed[item.label]?.indexedAfterMs === undefined,
      );
    const pending = () => unseen().filter((item) => !item.generic);
    while (true) {
      for (const query of pollQueries) {
        const page = yield* provider.searchFiles(query);
        polls++;
        if (!page.ok) {
          refused++;
          refusedStatuses.add(page.httpStatus);
          const errorType = errorTypeOf(page);
          if (errorType) refusedTypes.add(errorType);
          continue;
        }
        const now = (yield* Clock.currentTimeMillis) - started;
        for (const label of classify(page.files).matched) {
          const fixture = observed[label];
          if (fixture && fixture.indexedAfterMs === undefined) {
            fixture.indexedAfterMs = now;
            firstAt ??= now;
          }
        }
      }
      const elapsed = (yield* Clock.currentTimeMillis) - started;
      if (pending().length === 0) break;
      if (
        firstAt === undefined
          ? elapsed >= timing.indexDeadlineMs
          : elapsed - firstAt >= timing.settleMs
      )
        break;
      yield* Effect.sleep(timing.pollIntervalMs);
    }
    Object.assign(indexing, {
      polls,
      refused: {
        count: refused,
        httpStatuses: [...refusedStatuses].sort((left, right) => left - right),
        errorTypes: [...refusedTypes].sort(),
      },
      firstIndexedMs: firstAt,
      allIndexed: pending().length === 0,
      notSeen: unseen().map((item) => item.label),
    });
    if (firstAt === undefined)
      return yield* fail(refused === polls ? "search-refused" : stage);

    stage = "queries";
    for (const { form, query } of queries) {
      const page = yield* provider.searchFiles(query);
      if (!page.ok) {
        results.push({
          form,
          outcome: "refused",
          httpStatus: page.httpStatus,
          errorType: errorTypeOf(page),
          matched: [],
          items: [],
          unlabeled: 0,
          results: 0,
          cursor: false,
          fields: [],
        });
        continue;
      }
      const seen = classify(page.files);
      results.push({
        form,
        outcome: "ok",
        matched: Object.keys(ids).filter((label) => seen.matched.has(label)),
        items: seen.items,
        unlabeled: seen.unlabeled,
        results: page.files.length,
        total: page.total,
        cursor: page.cursor,
        fields: [...seen.fields].sort(),
      });
    }

    stage = "reread";
    const settled = firstAt + timing.settleMs;
    let rereadAt = (yield* Clock.currentTimeMillis) - started;
    while (rereadAt < settled) {
      yield* Effect.sleep(settled - rereadAt);
      rereadAt = (yield* Clock.currentTimeMillis) - started;
    }
    const reads: Record<string, RereadObservation> = {};
    for (const fixture of fixtures) {
      const id = ids[fixture.label];
      if (id === undefined) return yield* fail(stage);
      const file = yield* provider.getFile(id);
      const fileType = typeOf(file?.fileType);
      reads[fixture.label] = {
        found: file !== undefined,
        ...(fileType ? { fileType } : {}),
        searchSeen: false,
      };
    }
    let rereadRefused = 0;
    for (const query of pollQueries) {
      const page = yield* provider.searchFiles(query);
      if (!page.ok) {
        rereadRefused++;
        continue;
      }
      for (const item of classify(page.files, false).items) {
        const read = reads[item.label];
        if (!read || read.searchSeen) continue;
        read.searchSeen = true;
        if (item.fileType) read.searchFileType = item.fileType;
      }
    }
    Object.assign(reread, {
      afterMs: rereadAt,
      searches: pollQueries.length,
      refused: rereadRefused,
      fixtures: reads,
    });
  }).pipe(
    Effect.timeout("8 minutes"),
    Effect.catchCause((cause) => {
      const error = Cause.findErrorOption(cause);
      proof.failureStage =
        Option.isSome(error) && error.value instanceof SearchProbeFailure
          ? error.value.stage
          : stage;
      return Effect.failCause(cause);
    }),
  );

  const verify = Effect.gen(function* () {
    const owned = attempt.files;
    if (owned.length === 0)
      return {
        status: attempt.pending.length > 0 ? "unverified" : "not-needed",
        checked: 0,
      } satisfies Verification;
    let present = owned.length;
    for (let round = 1; round <= timing.verifyAttempts; round++) {
      const exists = yield* Effect.forEach(owned, provider.fileExists);
      present = exists.filter(Boolean).length;
      if (present === 0) break;
      if (round < timing.verifyAttempts)
        yield* Effect.sleep(timing.verifyIntervalMs);
    }
    return {
      status: present === 0 ? "verified" : "present",
      checked: owned.length,
      present,
    } satisfies Verification;
  }).pipe(
    Effect.interruptible,
    Effect.timeout("1 minute"),
    Effect.catchCause(() =>
      Effect.succeed({
        status: "unverified",
        checked: attempt.files.length,
      } satisfies Verification),
    ),
  );

  // Provider errors never carry the run's words, but receipts are shared.
  const secrets = searchSecrets(words, options.folderName).map(
    (secret) => new RegExp(escapeRegExp(secret), "gi"),
  );
  const scrub = (text: string) =>
    secrets.reduce(
      (current, secret) => current.replaceAll(secret, "[redacted]"),
      text,
    );

  const result: { status: "passed" | "failed" } = { status: "failed" };
  yield* withLiveLifecycle(attempt, work, {
    cancelTransfers: () => Effect.void,
    deleteFiles: provider.deleteFiles,
    checkpoint,
    publish: (outcome) =>
      Effect.gen(function* () {
        const verification = yield* verify;
        attempt.recovery = { ...attempt.recovery, verification };
        const saved = yield* Effect.exit(checkpoint);
        result.status =
          outcome.status === "passed" &&
          verification.status === "verified" &&
          Exit.isSuccess(saved)
            ? "passed"
            : "failed";
        yield* Effect.tryPromise(async () => {
          await mkdir(options.artifact, { recursive: true, mode: 0o700 });
          await writeFile(
            `${options.artifact}/results.json`,
            scrub(
              `${JSON.stringify(
                {
                  status: result.status,
                  lane: "put.io file search",
                  proof,
                  primary: outcome.primary,
                  cleanup: {
                    ...outcome.cleanup,
                    verification,
                    ...(Exit.isFailure(saved)
                      ? { recoveryError: "journal write failed" }
                      : {}),
                  },
                },
                null,
                2,
              )}\n`,
            ),
            { mode: 0o600 },
          );
          console.log(`${options.artifact}/results.json`);
        });
      }),
  });
  return result;
});

if (import.meta.main) {
  const stamp = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  NodeRuntime.runMain(
    Effect.gen(function* () {
      const source = yield* ensureLiveSource();
      return yield* runFileSearch({
        username: process.env[liveVersions.usernameEnv]?.trim(),
        ledgerDirectory: () => liveRunnerDirectory(),
        provider: putio,
        media: { path: source.path, bytes: source.bytes },
        artifact: `artifacts/live-search-${stamp}`,
        journal: `.cache/live/recovery/search-${stamp}.json`,
        folderName: `${liveVersions.folderPrefix}-search-${stamp}`,
        nonce: randomBytes(searchNonceBytes),
      });
    }).pipe(
      Effect.tap((outcome) =>
        Effect.sync(() => {
          if (outcome.status !== "passed") process.exitCode = 1;
        }),
      ),
      Effect.catchCause(() =>
        Effect.sync(() => {
          process.exitCode = 1;
          console.log('{"status":"failed","code":"search_probe_failed"}');
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
    { disableErrorReporting: true },
  );
}
