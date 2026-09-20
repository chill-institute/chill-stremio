import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  AuthSessionFailure,
  cachedAuthorization,
} from "../harness/live/auth-session.ts";

const username = "fixture-user";
const token = "fixture-token";
const fixture = async (run: (directory: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "auth-session-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
const saved = (directory: string, overrides = {}) =>
  writeFile(
    join(directory, "auth.json"),
    JSON.stringify({
      version: 1,
      username,
      token,
      nextLoginAt: 0,
      ...overrides,
    }),
    { mode: 0o600 },
  );

test("sequential and concurrent probes reuse one private validated login", () =>
  fixture(async (directory) => {
    let logins = 0;
    let validations = 0;
    const options = {
      directory,
      username,
      login: async () => {
        logins++;
        return token;
      },
      validate: async (value: string) => {
        assert.equal(value, token);
        validations++;
        return true;
      },
    };
    assert.deepEqual(
      await Promise.all([
        cachedAuthorization(options),
        cachedAuthorization(options),
      ]),
      [token, token],
    );
    assert.equal(await cachedAuthorization(options), token);
    assert.equal(logins, 1);
    assert.equal(validations, 3);
    assert.equal(
      (await stat(join(directory, "auth.json"))).mode & 0o777,
      0o600,
    );
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  }));

test("server-rejected cached authorization refreshes once", () =>
  fixture(async (directory) => {
    await saved(directory);
    let logins = 0;
    const value = await cachedAuthorization({
      directory,
      username,
      validate: async (value) => value === "replacement",
      login: async () => {
        logins++;
        return "replacement";
      },
    });
    assert.equal(value, "replacement");
    assert.equal(logins, 1);
  }));

test("transient validation failure preserves the token without logging in", () =>
  fixture(async (directory) => {
    await saved(directory);
    const before = await readFile(join(directory, "auth.json"), "utf8");
    let logins = 0;
    await assert.rejects(
      cachedAuthorization({
        directory,
        username,
        validate: async () => {
          throw new Error("network unavailable");
        },
        login: async () => {
          logins++;
          return token;
        },
      }),
      /network unavailable/,
    );
    assert.equal(logins, 0);
    assert.equal(await readFile(join(directory, "auth.json"), "utf8"), before);
  }));

test("failed OAuth persists a cooldown across subsequent runs", () =>
  fixture(async (directory) => {
    let logins = 0;
    const options = {
      directory,
      username,
      now: () => 1000,
      validate: async () => true,
      login: async () => {
        logins++;
        throw new Error("rate limited");
      },
    };
    await assert.rejects(cachedAuthorization(options), /rate limited/);
    await assert.rejects(
      cachedAuthorization(options),
      (error) =>
        error instanceof AuthSessionFailure && error.stage === "cooldown",
    );
    assert.equal(logins, 1);
    assert.equal(
      await cachedAuthorization({
        ...options,
        now: () => 3601001,
        login: async () => token,
      }),
      token,
    );
  }));

test("an account mismatch never reuses or overwrites the cached token", () =>
  fixture(async (directory) => {
    await saved(directory);
    let called = false;
    await assert.rejects(
      cachedAuthorization({
        directory,
        username: "another-user",
        validate: async () => {
          called = true;
          return true;
        },
        login: async () => {
          called = true;
          return token;
        },
      }),
      (error) =>
        error instanceof AuthSessionFailure && error.stage === "account",
    );
    assert.equal(called, false);
  }));

for (const kind of ["permissions", "symlink", "malformed"] as const) {
  test(`unsafe ${kind} cache fails before login`, () =>
    fixture(async (directory) => {
      const path = join(directory, "auth.json");
      if (kind === "permissions") await writeFile(path, "{}", { mode: 0o644 });
      if (kind === "malformed")
        await writeFile(path, "secret fixture malformed", { mode: 0o600 });
      if (kind === "symlink") {
        await writeFile(join(directory, "other"), "{}", { mode: 0o600 });
        await symlink(join(directory, "other"), path);
      }
      let called = false;
      await assert.rejects(
        cachedAuthorization({
          directory,
          username,
          validate: async () => {
            called = true;
            return true;
          },
          login: async () => {
            called = true;
            return token;
          },
        }),
        (error) =>
          error instanceof AuthSessionFailure &&
          error.stage === "cache" &&
          !error.message.includes("secret"),
      );
      assert.equal(called, false);
    }));
}

test("waiting for another login is cancellable and never steals its lock", () =>
  fixture(async (directory) => {
    await writeFile(join(directory, "auth.lock"), "owner", { mode: 0o600 });
    let called = false;
    await assert.rejects(
      cachedAuthorization({
        directory,
        username,
        signal: AbortSignal.timeout(20),
        validate: async () => true,
        login: async () => {
          called = true;
          return token;
        },
      }),
    );
    assert.equal(called, false);
    assert.equal(await readFile(join(directory, "auth.lock"), "utf8"), "owner");
  }));

test("a post-login validation outage retains the new token for the next run", () =>
  fixture(async (directory) => {
    let logins = 0;
    const login = async () => {
      logins++;
      return token;
    };
    await assert.rejects(
      cachedAuthorization({
        directory,
        username,
        login,
        validate: async () => {
          throw new Error("temporary");
        },
      }),
      /temporary/,
    );
    assert.equal(
      await cachedAuthorization({
        directory,
        username,
        login,
        validate: async () => true,
      }),
      token,
    );
    assert.equal(logins, 1);
  }));
