import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Schema } from "effect";

const State = Schema.Struct({
  version: Schema.Literal(1),
  username: Schema.NonEmptyString,
  token: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8192),
      Schema.isPattern(/^[A-Za-z0-9._~+/-]+=*$/),
    ),
  ),
  nextLoginAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const missing = Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }));
const exists = Schema.is(Schema.Struct({ code: Schema.Literal("EEXIST") }));
export class AuthSessionFailure extends Error {
  readonly stage: "cache" | "cooldown" | "busy" | "account" | "validation";
  constructor(stage: "cache" | "cooldown" | "busy" | "account" | "validation") {
    super(`Dev authorization session: ${stage}`);
    this.stage = stage;
  }
}

export async function cachedAuthorization(options: {
  directory: string;
  username: string;
  validate: (token: string) => Promise<boolean>;
  login: () => Promise<string>;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<string> {
  const now = options.now ?? Date.now;
  const directory = await lstat(options.directory);
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new AuthSessionFailure("cache");
  const path = join(options.directory, "auth.json");
  const lockPath = join(options.directory, "auth.lock");
  const deadline = performance.now() + 130_000;
  let lock;
  while (!lock) {
    options.signal?.throwIfAborted();
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (!exists(error)) throw new AuthSessionFailure("cache");
      if (performance.now() >= deadline) throw new AuthSessionFailure("busy");
      await setTimeout(200, undefined, { signal: options.signal });
    }
  }
  const save = async (state: typeof State.Type) => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(state));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
      const parent = await open(options.directory, "r");
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    } catch {
      throw new AuthSessionFailure("cache");
    } finally {
      await rm(temporary, { force: true });
    }
  };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid }));
    options.signal?.throwIfAborted();
    let state: typeof State.Type | undefined;
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await file.stat();
        if (
          !info.isFile() ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o077) !== 0 ||
          info.size > 16384
        )
          throw new AuthSessionFailure("cache");
        state = Schema.decodeUnknownSync(State)(
          JSON.parse(await file.readFile("utf8")),
        );
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!missing(error)) throw new AuthSessionFailure("cache");
    }
    if (state && state.username !== options.username)
      throw new AuthSessionFailure("account");
    if (state?.token && (await options.validate(state.token)))
      return state.token;
    if (state && state.nextLoginAt > now())
      throw new AuthSessionFailure("cooldown");
    // Persist before OAuth so crashes and failed logins cannot cause a login loop.
    const pending = {
      version: 1 as const,
      username: options.username,
      nextLoginAt: now() + 60 * 60 * 1000,
    };
    await save(pending);
    const candidate = await options.login();
    let token: string | undefined;
    try {
      token = Schema.decodeUnknownSync(State.fields.token)(candidate);
    } catch {
      throw new AuthSessionFailure("validation");
    }
    if (!token) throw new AuthSessionFailure("validation");
    await save({ ...pending, token });
    if (!(await options.validate(token)))
      throw new AuthSessionFailure("validation");
    await save({ ...pending, token, nextLoginAt: 0 });
    return token;
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}
