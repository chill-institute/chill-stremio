import { chromium } from "@playwright/test";
import {
  authorizeChill,
  ChillAuthorizationFailure,
  totp,
} from "../harness/live/auth.ts";
import { afterEach, test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { accountInfo, hlsCueText, uploadFile } from "../harness/live/putio.ts";
import { liveVersions } from "../harness/live/versions.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const playlist = (uri: string) =>
  `#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,URI="${uri}"`;

for (const failure of ["http", "network", "empty"] as const) {
  test(`untrusted subtitle ${failure} never triggers authenticated retry`, async () => {
    vi.stubEnv(liveVersions.putioTokenEnv, "synthetic-test-token");
    const calls: { url: string; authorization: string | null }[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      calls.push({ url, authorization });
      if (calls.length === 1)
        return new Response(playlist("https://captions.example.test/en.vtt"));
      assert.equal(authorization, null);
      if (failure === "network") throw new Error("Network unavailable");
      return new Response("", { status: failure === "http" ? 401 : 200 });
    });
    await assert.rejects(Effect.runPromise(hlsCueText(1)), /untrusted origin/);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.authorization, "token synthetic-test-token");
    assert.equal(calls[1]?.authorization, null);
  });
}

test("anonymous subtitle success does not request authentication", async () => {
  vi.stubEnv(liveVersions.putioTokenEnv, "synthetic-test-token");
  let calls = 0;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    calls++;
    if (calls === 1)
      return new Response(playlist("https://captions.example.test/en.vtt"));
    assert.equal(new Headers(init?.headers).has("authorization"), false);
    return new Response("WEBVTT\nfixture caption");
  });
  assert.match(await Effect.runPromise(hlsCueText(1)), /fixture caption/);
  assert.equal(calls, 2);
});

test("trusted subtitle fallback authenticates only the canonical origin", async () => {
  vi.stubEnv(liveVersions.putioTokenEnv, "synthetic-test-token");
  const headers: (string | null)[] = [];
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    headers.push(new Headers(init?.headers).get("authorization"));
    if (headers.length === 1)
      return new Response(playlist(`${liveVersions.apiBase}/captions.vtt`));
    if (headers.length === 2) return new Response("", { status: 401 });
    return new Response("WEBVTT\nfixture caption");
  });
  assert.match(await Effect.runPromise(hlsCueText(1)), /fixture caption/);
  assert.deepEqual(headers, [
    "token synthetic-test-token",
    null,
    "token synthetic-test-token",
  ]);
});

test("authenticated API redirects fail without following the destination", async () => {
  vi.stubEnv(liveVersions.putioTokenEnv, "synthetic-test-token");
  let calls = 0;
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    calls++;
    assert.equal(init?.redirect, "manual");
    return new Response(null, {
      status: 302,
      headers: { location: "https://other.example.test/" },
    });
  });
  await assert.rejects(Effect.runPromise(accountInfo()), /HTTP 302/);
  assert.equal(calls, 1);
});

test("canonical API and upload calls retain provider authentication", async () => {
  vi.stubEnv(liveVersions.putioTokenEnv, "synthetic-test-token");
  const directory = await mkdtemp(join(tmpdir(), "live-auth-"));
  try {
    const path = join(directory, "fixture.txt");
    await writeFile(path, "fixture");
    const origins: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      origins.push(new URL(url).origin);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "token synthetic-test-token",
      );
      if (origins.length === 1)
        return Response.json({
          status: "OK",
          info: { username: "fixture", account_status: "active" },
        });
      assert.ok(init?.body instanceof FormData);
      assert.equal(init.body.get("parent_id"), "1");
      return Response.json({ status: "OK", file: { id: 2, name: "fixture" } });
    });
    assert.equal((await Effect.runPromise(accountInfo())).username, "fixture");
    assert.equal(
      (await Effect.runPromise(uploadFile(path, "fixture", 1))).id,
      2,
    );
    assert.deepEqual(origins, [liveVersions.apiBase, liveVersions.uploadBase]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
for (const [seconds, expected] of [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
] as const) {
  test(`RFC 6238 SHA1 vector at ${seconds}`, () => {
    assert.equal(
      totp(rfcSecret, { timeMs: seconds * 1000, digits: 8 }),
      expected,
    );
  });
}

test("grouped base32 accepts hyphens, spaces and lowercase", () => {
  assert.equal(
    totp("gezd-gnbv gy3t-qojq gezd-gnbv gy3t-qojq", { timeMs: 59000 }),
    "287082",
  );
});

for (const secret of [
  "",
  "---",
  "ABC!",
  "ABC0",
  "A",
  "MZ======",
  "MY====",
  "MY=AAAAA",
]) {
  test(`invalid OTP configuration rejects without including input (${secret.length})`, () => {
    assert.throws(
      () => totp(secret),
      (error) =>
        error instanceof ChillAuthorizationFailure &&
        error.stage === "configuration" &&
        error.message === "Chill authorization failed: configuration",
    );
  });
}

test("invalid OTP clock rejects", () => {
  for (const timeMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0.5])
    assert.throws(() => totp(rfcSecret, { timeMs }), ChillAuthorizationFailure);
});

for (const missing of [
  liveVersions.usernameEnv,
  liveVersions.passwordEnv,
  liveVersions.otpEnv,
]) {
  test(`missing ${missing} fails before browser launch`, async () => {
    vi.stubEnv(liveVersions.usernameEnv, "fixture-user");
    vi.stubEnv(liveVersions.passwordEnv, "fixture-password");
    vi.stubEnv(liveVersions.otpEnv, rfcSecret);
    vi.stubEnv(missing, "");
    const launch = vi
      .spyOn(chromium, "launch")
      .mockRejectedValue(new Error("Browser must not launch"));
    try {
      await assert.rejects(
        authorizeChill(),
        (error) =>
          error instanceof ChillAuthorizationFailure &&
          error.stage === "configuration",
      );
      assert.equal(launch.mock.calls.length, 0);
    } finally {
      launch.mockRestore();
    }
  });
}

for (const scenario of ["valid", "wrong-account", "unavailable"] as const) {
  test(`cached authorization ${scenario} does not launch OAuth`, async () => {
    const runner = await import("../harness/live/runner.ts");
    const directory = await mkdtemp(join(tmpdir(), "auth-reuse-"));
    const runnerState = vi
      .spyOn(runner, "liveRunnerDirectory")
      .mockResolvedValue(directory);
    const launch = vi
      .spyOn(chromium, "launch")
      .mockRejectedValue(new Error("OAuth must not launch"));
    vi.stubEnv(liveVersions.usernameEnv, "fixture-user");
    vi.stubEnv(liveVersions.passwordEnv, "fixture-password");
    vi.stubEnv(liveVersions.otpEnv, rfcSecret);
    let validations = 0;
    vi.stubGlobal(
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(
          input instanceof Request ? input.url : input.toString(),
          "https://api.chill.institute/v4/chill.v4.UserService/GetUserProfile",
        );
        assert.equal(
          new Headers(
            init?.headers ??
              (input instanceof Request ? input.headers : undefined),
          ).get("authorization"),
          "Bearer fixture-token",
        );
        assert.equal(init?.redirect, "manual");
        validations++;
        return scenario === "unavailable"
          ? Response.json(
              { code: "unavailable", message: "temporary" },
              { status: 503 },
            )
          : Response.json({
              userId: "123",
              username:
                scenario === "wrong-account" ? "another-user" : "fixture-user",
            });
      },
    );
    try {
      await writeFile(
        join(directory, "auth.json"),
        JSON.stringify({
          version: 1,
          username: "fixture-user",
          token: "fixture-token",
          nextLoginAt: 0,
        }),
        { mode: 0o600 },
      );
      if (scenario === "valid") {
        assert.equal(await authorizeChill(), "fixture-token");
        assert.equal(await authorizeChill(), "fixture-token");
        assert.equal(validations, 2);
      } else
        await assert.rejects(
          authorizeChill(),
          (error) =>
            error instanceof ChillAuthorizationFailure &&
            error.stage === "validation",
        );
      assert.equal(launch.mock.calls.length, 0);
    } finally {
      runnerState.mockRestore();
      launch.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
