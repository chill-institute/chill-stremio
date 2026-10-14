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

export const searchNonceBytes = 112;

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
    typo: `${a.slice(0, 3)}${shifted}${a.slice(4)}`,
  };
  if (new Set(Object.values(words)).size !== Object.keys(words).length)
    throw new Error("Synthetic search words collided");
  return words;
}

type Words = ReturnType<typeof searchWords>;

export function searchFixtures(words: Words) {
  const [a, b, c, d, e, long, f, g, h, i, j, k] = [
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
  ].map(titled);
  return [
    { label: "movie-dotted", name: `${a}.${b}.2001.1080p.WEB.H264.mkv` },
    { label: "movie-spaced", name: `${a} ${b} (2001).mkv` },
    { label: "movie-underscored", name: `${a}_${b}_2001.mkv` },
    { label: "decoy", name: `${a}.${c}.2001.mkv` },
    {
      label: "episode-nested",
      name: `${d}.${e}.S01E02.720p.mkv`,
      nested: true,
    },
    { label: "long-word", name: `${long} (2001).mkv` },
    { label: "apostrophe", name: `${f}'s.${g}.2003.mkv` },
    { label: "ampersand", name: `${h}.&.${i}.2004.mkv` },
    { label: "accent", name: `${j}${acute}.${k}.2005.mkv` },
  ];
}

/** Single-word queries polled until uploads appear in search. */
function searchPolls(words: Words) {
  return [words.a, words.d, words.long.slice(0, 20), words.g, words.i, words.k];
}

export function searchQueries(words: Words) {
  const scope = "from:me type:video";
  return [
    { form: "plain", query: `${words.a} ${words.b}` },
    { form: "plain-from-me-video", query: `${words.a} ${words.b} ${scope}` },
    { form: "quoted", query: `"${words.a} ${words.b}"` },
    { form: "dotted", query: `${words.a}.${words.b}` },
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

interface QueryObservation {
  form: string;
  outcome: "ok" | "refused";
  httpStatus?: number;
  errorType?: string;
  matched: string[];
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
  const proof: Record<string, unknown> = {
    source: "self-generated-fixture",
    fixtures: observed,
    indexing,
    queries: results,
  };
  let stage = "configuration";
  const fail = (at: string) => new SearchProbeFailure({ stage: at });
  const labelOf = (id: number) =>
    Object.entries(ids).find(([, owned]) => owned === id)?.[0];

  const inspected = new Set<string>();
  const observe = (item: typeof ResultItem.Type, label: string) => {
    const fixture = observed[label];
    if (!fixture || inspected.has(label)) return;
    inspected.add(label);
    if (item.file_type && enumValue.test(item.file_type))
      fixture.fileType = item.file_type;
    if (typeof item.is_shared === "boolean") fixture.isShared = item.is_shared;
    if (item.parent_id !== undefined)
      fixture.parentIdMatches = item.parent_id === parents.get(label);
  };

  const classify = (files: readonly Record<string, unknown>[]) => {
    const matched = new Set<string>();
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
      observe(item.value, label);
    }
    return { matched, unlabeled, fields };
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
    const bytes = fixtures.length * options.media.bytes;
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
    const season = yield* create("season-folder", "Season 01", folder.id);
    for (const fixture of fixtures) {
      const parent = fixture.nested ? season.id : folder.id;
      const file = yield* trackAcquisition(
        attempt,
        "file",
        provider.uploadFile(options.media.path, fixture.name, parent),
        checkpoint,
      );
      ids[fixture.label] = file.id;
      parents.set(fixture.label, parent);
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
    const pending = () =>
      fixtures.filter(
        (item) => observed[item.label]?.indexedAfterMs === undefined,
      );
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
      notSeen: pending().map((item) => item.label),
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
        unlabeled: seen.unlabeled,
        results: page.files.length,
        total: page.total,
        cursor: page.cursor,
        fields: [...seen.fields].sort(),
      });
    }
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
