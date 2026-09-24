import { lstat, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";
import { liveVersions } from "./versions.ts";

export class AllowanceFailure extends Error {
  readonly code = "allowance";
}

const Day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((day) => {
    const time = Date.parse(`${day}T00:00:00Z`);
    return (
      Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day
    );
  }),
);

const Count = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const ApprovedLimits = Schema.Struct({
  byteLimit: Count,
  reason: Schema.NonEmptyString,
});

export const allowanceLimits = (ledger: {
  approvedLimits?: typeof ApprovedLimits.Type;
}) => ledger.approvedLimits ?? liveVersions;

const LedgerSchema = Schema.Struct({
  day: Day,
  reservedTransfers: Count,
  reservedBytes: Count,
  approvedLimits: Schema.optional(ApprovedLimits),
}).check(
  Schema.makeFilter((ledger) => {
    const limits = allowanceLimits(ledger);
    return ledger.reservedBytes <= limits.byteLimit;
  }),
);
export type Ledger = typeof LedgerSchema.Type;

export const utcDay = (now = new Date()) => now.toISOString().slice(0, 10);

interface LockOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function withAllowanceLock<T>(
  directory: string,
  run: (path: string) => Promise<T>,
  options: LockOptions = {},
) {
  const lockPath = join(directory, "allowance.lock");
  const deadline = performance.now() + (options.timeoutMs ?? 5_000);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  while (!handle) {
    options.signal?.throwIfAborted();
    try {
      handle = await open(lockPath, "wx", 0o600);
    } catch (cause) {
      if (Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }))(cause)) {
        if (performance.now() >= deadline)
          throw new AllowanceFailure(
            "Live allowance lock is held; if no probe is running, remove allowance.lock after checking the ledger",
          );
        await setTimeout(
          Math.min(50, Math.max(1, deadline - performance.now())),
          undefined,
          { signal: options.signal },
        );
        continue;
      }
      throw new AllowanceFailure("Live allowance directory is unavailable", {
        cause,
      });
    }
  }
  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
    options.signal?.throwIfAborted();
    return await run(join(directory, "allowance.json"));
  } finally {
    await handle.close();
    await rm(lockPath);
  }
}

export async function readLedger(path: string, now = new Date()) {
  let parsed: Ledger;
  try {
    parsed = Schema.decodeUnknownSync(LedgerSchema)(
      JSON.parse(await readFile(path, "utf8")),
    );
  } catch (cause) {
    throw new AllowanceFailure(
      "Live allowance ledger is missing, unreadable or invalid; fix or restore allowance.json before running live probes",
      { cause },
    );
  }
  const day = utcDay(now);
  if (parsed.day > day)
    throw new AllowanceFailure(
      "Live allowance ledger is ahead of the UTC clock; stop rather than reset usage",
    );
  if (parsed.day < day) return { day, reservedTransfers: 0, reservedBytes: 0 };
  return parsed;
}

export async function reserve(
  directory: string,
  transfers: number,
  bytes: number,
  now: Date | (() => Date) = () => new Date(),
  options: LockOptions = {},
) {
  if (
    !Number.isSafeInteger(transfers) ||
    transfers < 1 ||
    !Number.isSafeInteger(bytes) ||
    bytes < 0
  )
    throw new AllowanceFailure(
      "Reservation must contain a positive transfer count and nonnegative safe byte count",
    );
  return withAllowanceLock(
    directory,
    async (path) => {
      const reservedAt = typeof now === "function" ? now() : now;
      const current = await readLedger(path, reservedAt);
      const next: Ledger = {
        ...current,
        day: current.day,
        reservedTransfers: current.reservedTransfers + transfers,
        reservedBytes: current.reservedBytes + bytes,
      };
      const limits = allowanceLimits(current);
      if (
        !Number.isSafeInteger(next.reservedTransfers) ||
        !Number.isSafeInteger(next.reservedBytes) ||
        next.reservedBytes > limits.byteLimit
      )
        throw new AllowanceFailure(
          `Reservation exceeds the ${limits.byteLimit}-byte budget for ${current.day} UTC or safe accounting range`,
        );
      await writeLedger(directory, path, next);
      return next;
    },
    options,
  );
}

export async function createMissingLedger(
  directory: string,
  now = new Date(),
  options: LockOptions = {},
) {
  return withAllowanceLock(
    directory,
    async (path) => {
      try {
        await lstat(path);
        return false;
      } catch (cause) {
        if (
          !Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(cause)
        )
          throw cause;
      }
      await writeLedger(directory, path, {
        day: utcDay(now),
        reservedTransfers: 0,
        reservedBytes: 0,
      });
      return true;
    },
    options,
  );
}

async function writeLedger(directory: string, path: string, ledger: Ledger) {
  const temporary = `${path}.next`;
  const output = await open(temporary, "wx", 0o600);
  try {
    await output.writeFile(`${JSON.stringify(ledger, null, 2)}\n`);
    await output.sync();
  } finally {
    await output.close();
  }
  await rename(temporary, path);
  const ownerDirectory = await open(directory, "r");
  try {
    await ownerDirectory.sync();
  } finally {
    await ownerDirectory.close();
  }
}
