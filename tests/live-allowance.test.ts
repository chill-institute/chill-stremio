import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  AllowanceFailure,
  readLedger,
  reserve,
  withAllowanceLock,
} from "../harness/live/allowance.ts";
import {
  measureLivePayloads,
  registeredLiveRunner,
  runnerDirectory,
  type RunnerIdentity,
} from "../harness/live/runner.ts";
import { liveVersions } from "../harness/live/versions.ts";

const now = new Date("2026-09-13T12:00:00Z");
const day = "2026-09-13";
const seed = async (
  directory: string,
  transfers = 0,
  bytes = 0,
  date = day,
) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory, "allowance.json"),
    JSON.stringify({
      day: date,
      reservedTransfers: transfers,
      reservedBytes: bytes,
    }),
    { mode: 0o600 },
  );
};

const fixture = async () => {
  const home = await mkdtemp(join(tmpdir(), "live-owner-"));
  const identity: RunnerIdentity = {
    platform: "linux",
    username: "fixture-owner",
    account: "fixture-account",
    uid: userInfo().uid,
    home,
    machineIdSha256: "a".repeat(64),
  };
  const directory = runnerDirectory(home);
  await seed(directory);
  await writeFile(
    join(directory, "runner.json"),
    JSON.stringify({
      version: 2,
      account: identity.account,
      username: identity.username,
      machineIdSha256: identity.machineIdSha256,
      uid: identity.uid,
    }),
    { mode: 0o600 },
  );
  return { home, identity, directory };
};

test("independent checkout contexts resolve one owner and atomically compete for its last slot", async () => {
  const owner = await fixture();
  try {
    await seed(owner.directory, 9, liveVersions.byteLimit - 1);
    const first = await registeredLiveRunner({ ...owner.identity }, now);
    const second = await registeredLiveRunner({ ...owner.identity }, now);
    assert.equal(first, second);
    const results = await Promise.allSettled([
      reserve(first, 1, 1, now),
      reserve(second, 1, 1, now),
    ]);
    assert.equal(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter((result) => result.status === "rejected").length,
      1,
    );
    assert.deepEqual(await readLedger(join(first, "allowance.json"), now), {
      day,
      reservedTransfers: 10,
      reservedBytes: liveVersions.byteLimit,
    });
  } finally {
    await rm(owner.home, { recursive: true, force: true });
  }
});

test("missing or corrupt allowance never becomes a fresh budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-missing-"));
  try {
    const missing = join(root, "missing");
    await assert.rejects(() => reserve(missing, 1, 0, now), AllowanceFailure);
    await assert.rejects(() => stat(missing));
    await mkdir(missing);
    await assert.rejects(() => reserve(missing, 1, 0, now), AllowanceFailure);
    for (const contents of [
      "{",
      "{}",
      JSON.stringify({
        day: "2026-02-31",
        reservedTransfers: 0,
        reservedBytes: 0,
      }),
    ]) {
      await writeFile(join(missing, "allowance.json"), contents);
      await assert.rejects(() => reserve(missing, 1, 0, now), AllowanceFailure);
    }
    await seed(missing, 10, liveVersions.byteLimit);
    await assert.rejects(() => reserve(missing, 1, 1, now), AllowanceFailure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("UTC rollover retains today's usage and refuses a future ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-day-"));
  try {
    await seed(root, 10, liveVersions.byteLimit, "2026-09-12");
    assert.deepEqual(await reserve(root, 4, 123, now), {
      day,
      reservedTransfers: 4,
      reservedBytes: 123,
    });
    assert.deepEqual(await reserve(root, 4, 123, now), {
      day,
      reservedTransfers: 8,
      reservedBytes: 246,
    });
    await assert.rejects(
      () => reserve(root, 1, 0, new Date("2026-09-12T23:59:59Z")),
      AllowanceFailure,
    );
    assert.equal(
      (await readLedger(join(root, "allowance.json"), now)).reservedTransfers,
      8,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an old lock is not stolen and a cancelled waiter cannot remove it", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-lock-"));
  try {
    await seed(root);
    const lock = join(root, "allowance.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid }));
    await utimes(lock, new Date(0), new Date(0));
    await assert.rejects(
      () => reserve(root, 1, 0, now, { timeoutMs: 20 }),
      AllowanceFailure,
    );
    const controller = new AbortController();
    const waiting = withAllowanceLock(
      root,
      async () => {
        throw new Error("must not acquire");
      },
      { signal: controller.signal },
    );
    controller.abort();
    await assert.rejects(() => waiting);
    assert.equal(
      await readFile(lock, "utf8"),
      JSON.stringify({ pid: process.pid }),
    );
    assert.equal(
      (await readLedger(join(root, "allowance.json"), now)).reservedTransfers,
      0,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registration binds the host and user and requires private regular state", async () => {
  const owner = await fixture();
  try {
    for (const identity of [
      { ...owner.identity, machineIdSha256: "b".repeat(64) },
      { ...owner.identity, uid: owner.identity.uid + 1 },
      { ...owner.identity, platform: "darwin" },
      { ...owner.identity, username: "other" },
      { ...owner.identity, account: "other" },
      { ...owner.identity, account: "" },
    ])
      await assert.rejects(
        () => registeredLiveRunner(identity, now),
        AllowanceFailure,
      );
    const registration = join(owner.directory, "runner.json");
    await chmod(registration, 0o644);
    await assert.rejects(
      () => registeredLiveRunner(owner.identity, now),
      AllowanceFailure,
    );
    await chmod(registration, 0o600);
    const contents = await readFile(registration);
    await rm(registration);
    await assert.rejects(
      () => registeredLiveRunner(owner.identity, now),
      AllowanceFailure,
    );
    const target = join(owner.home, "copy.json");
    await writeFile(target, contents, { mode: 0o600 });
    await symlink(target, registration);
    await assert.rejects(
      () => registeredLiveRunner(owner.identity, now),
      AllowanceFailure,
    );
  } finally {
    await rm(owner.home, { recursive: true, force: true });
  }
});

test("payload accounting measures the prepared movie twice and both caption uploads", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-bytes-"));
  try {
    await writeFile(join(root, "source.mp4"), Buffer.alloc(7));
    const paths = {
      media: join(root, "muxed.mp4"),
      srt: join(root, "movie.srt"),
      vtt: join(root, "movie.vtt"),
    };
    await writeFile(paths.media, Buffer.alloc(13));
    await writeFile(paths.srt, Buffer.alloc(3));
    await writeFile(paths.vtt, Buffer.alloc(5));
    const payloads = await measureLivePayloads(paths);
    assert.deepEqual(payloads, { transfers: 4, bytes: 34 });
    await seed(root, 6, liveVersions.byteLimit - 34);
    assert.deepEqual(
      await reserve(root, payloads.transfers, payloads.bytes, now),
      { day, reservedTransfers: 10, reservedBytes: liveVersions.byteLimit },
    );
    await seed(root, 6, liveVersions.byteLimit - 33);
    await assert.rejects(
      () => reserve(root, payloads.transfers, payloads.bytes, now),
      AllowanceFailure,
    );
    await writeFile(paths.vtt, "");
    await assert.rejects(() => measureLivePayloads(paths), AllowanceFailure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated probes can cross midnight without a transfer quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-midnight-"));
  try {
    await seed(root, 10, 100);
    const before = await reserve(root, 4, 34, new Date("2026-09-13T23:59:59Z"));
    assert.deepEqual(before, {
      day,
      reservedTransfers: 14,
      reservedBytes: 134,
    });
    const after = await reserve(
      root,
      4,
      34,
      () => new Date("2026-09-14T00:00:00Z"),
    );
    assert.deepEqual(after, {
      day: "2026-09-14",
      reservedTransfers: 4,
      reservedBytes: 34,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy transfer ceilings no longer block reservations or erase usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-legacy-"));
  try {
    const path = join(root, "allowance.json");
    await writeFile(
      path,
      JSON.stringify({
        day,
        reservedTransfers: 14,
        reservedBytes: 100,
        approvedLimits: {
          transferLimit: 14,
          byteLimit: 200,
          reason: "Earlier approval",
        },
      }),
    );
    const reserved = await reserve(root, 20, 50, now);
    assert.equal(reserved.reservedTransfers, 34);
    assert.equal(reserved.reservedBytes, 150);
    await assert.rejects(() => reserve(root, 1, 51, now), AllowanceFailure);
    assert.equal((await readLedger(path, now)).reservedBytes, 150);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interrupted durable write blocks reservations until owner reconciliation", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-ledger-write-"));
  try {
    await seed(root, 6, 100);
    await writeFile(join(root, "allowance.json.next"), "partial");
    await assert.rejects(() => reserve(root, 4, 34, now));
    assert.deepEqual(await readLedger(join(root, "allowance.json"), now), {
      day,
      reservedTransfers: 6,
      reservedBytes: 100,
    });
    assert.equal(
      await readFile(join(root, "allowance.json.next"), "utf8"),
      "partial",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an owner-approved daily extension preserves usage, stays bounded and expires at rollover", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-approved-"));
  try {
    const path = join(root, "allowance.json");
    await seed(root, 10, liveVersions.byteLimit);
    const original = await readLedger(path, now);
    const approvedLimits = {
      byteLimit: liveVersions.byteLimit + 34,
      reason: "Owner approved one additional probe",
    };
    await writeFile(path, JSON.stringify({ ...original, approvedLimits }));
    const results = await Promise.allSettled([
      reserve(root, 4, 34, now),
      reserve(root, 4, 34, now),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.deepEqual(await readLedger(path, now), {
      ...original,
      reservedTransfers: 14,
      reservedBytes: liveVersions.byteLimit + 34,
      approvedLimits,
    });
    assert.deepEqual(
      await reserve(root, 4, 34, new Date("2026-09-14T12:00:00Z")),
      {
        day: "2026-09-14",
        reservedTransfers: 4,
        reservedBytes: 34,
      },
    );
    for (const invalid of [
      { ...approvedLimits, reason: "" },
      { ...approvedLimits, byteLimit: Number.MAX_SAFE_INTEGER + 1 },
      { ...approvedLimits, byteLimit: liveVersions.byteLimit - 1 },
    ]) {
      await writeFile(
        path,
        JSON.stringify({ ...original, approvedLimits: invalid }),
      );
      await assert.rejects(() => reserve(root, 4, 34, now), AllowanceFailure);
    }
    await seed(root, 14, liveVersions.byteLimit + 1);
    await assert.rejects(() => readLedger(path, now), AllowanceFailure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
