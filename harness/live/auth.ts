import { createHmac } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { chromium, type Browser } from "@playwright/test";
import { Effect, Schema } from "effect";
import { createEngineRpc, EngineError } from "../../src/engine.ts";
import { cachedAuthorization } from "./auth-session.ts";
import { liveRunnerDirectory } from "./runner.ts";
import { liveVersions } from "./versions.ts";

const Base32 = Schema.String.check(
  Schema.isPattern(/^[A-Z2-7]+={0,6}$/),
  Schema.makeFilter((value) => {
    const bare = value.replace(/=+$/, "");
    const remainder = bare.length % 8;
    return (
      [0, 2, 4, 5, 7].includes(remainder) &&
      (!value.includes("=") || value.length % 8 === 0)
    );
  }),
);
const TotpOptions = Schema.Struct({
  timeMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  digits: Schema.Literals([6, 8]),
});
const Configuration = Schema.Struct({
  username: Schema.String.check(Schema.isMinLength(1)),
  password: Schema.String.check(Schema.isMinLength(1)),
  otpSecret: Schema.String.check(Schema.isMinLength(1)),
});
const Token = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8192),
  Schema.isPattern(/^[A-Za-z0-9._~+/-]+=*$/),
);

type Stage =
  | "configuration"
  | "start"
  | "login"
  | "otp"
  | "oauth"
  | "cleanup"
  | "rate_limit"
  | "validation";
export class ChillAuthorizationFailure extends Error {
  readonly code = "authorization_failed";
  readonly stage: Stage;
  constructor(stage: Stage) {
    super(`Chill authorization failed: ${stage}`);
    this.name = "ChillAuthorizationFailure";
    this.stage = stage;
  }
}

export function totp(
  secret: string,
  options: { timeMs?: number; digits?: 6 | 8 } = {},
) {
  try {
    const normalized = Schema.decodeUnknownSync(Base32)(
      secret.toUpperCase().replace(/[\s-]/g, ""),
    );
    const { timeMs, digits } = Schema.decodeUnknownSync(TotpOptions)({
      timeMs: options.timeMs ?? Date.now(),
      digits: options.digits ?? 6,
    });
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";
    for (const character of normalized.replace(/=+$/, ""))
      bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
    const bytes: number[] = [];
    for (let index = 0; index + 8 <= bits.length; index += 8)
      bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
    if (bytes.length === 0 || /1/.test(bits.slice(bytes.length * 8)))
      throw new Error("Invalid base32 padding");
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30000)));
    const digest = createHmac("sha1", Buffer.from(bytes))
      .update(counter)
      .digest();
    const offset = (digest.at(-1) ?? 0) & 15;
    return String(
      (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits,
    ).padStart(digits, "0");
  } catch {
    throw new ChillAuthorizationFailure("configuration");
  }
}

async function closeBrowser(browser: Browser) {
  const deadline = new AbortController();
  try {
    await Promise.race([
      browser.close(),
      setTimeout(10000, undefined, { signal: deadline.signal }).then(() => {
        throw new ChillAuthorizationFailure("cleanup");
      }),
    ]);
  } catch {
    throw new ChillAuthorizationFailure("cleanup");
  } finally {
    deadline.abort();
  }
}

async function authorizeWithBrowser(
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  let configuration: Schema.Schema.Type<typeof Configuration>;
  try {
    configuration = Schema.decodeUnknownSync(Configuration)({
      username: process.env[liveVersions.usernameEnv]?.trim(),
      password: process.env[liveVersions.passwordEnv],
      otpSecret: process.env[liveVersions.otpEnv],
    });
    totp(configuration.otpSecret);
    options.signal?.throwIfAborted();
  } catch {
    throw new ChillAuthorizationFailure("configuration");
  }
  const signal = AbortSignal.any([
    AbortSignal.timeout(120000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let browser: Browser | undefined;
  let stage: Stage = "start";
  const stop = () => {
    void browser?.close().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    browser = await chromium.launch({
      channel: "chromium",
      headless: true,
      timeout: 20000,
    });
    signal.throwIfAborted();
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    let capturedToken: string | undefined;
    // Engine's state cookie remains in this fresh browser throughout normal OAuth.
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      try {
        const url = new URL(frame.url());
        if (url.origin !== "https://chill.institute") return;
        const value = new URLSearchParams(url.hash.slice(1)).get("auth_token");
        if (value) capturedToken = Schema.decodeUnknownSync(Token)(value);
      } catch {
        /* Ignore unrelated navigation and malformed callback values. */
      }
    });
    await page.goto("https://api.chill.institute/auth/putio/start", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await page.locator('input[name="username"]').waitFor();
    if (new URL(page.url()).origin !== "https://app.put.io")
      throw new ChillAuthorizationFailure("login");
    stage = "login";
    await page.locator('input[name="username"]').fill(configuration.username);
    await page.locator('input[name="password"]').fill(configuration.password);
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    try {
      await page.locator('input[name="code"]').waitFor();
    } catch {
      const rateLimited = await page.evaluate(() =>
        /too many|rate limit|try again later|temporarily blocked/i.test(
          document.body.innerText,
        ),
      );
      if (rateLimited) stage = "rate_limit";
      throw new ChillAuthorizationFailure(stage);
    }
    if (new URL(page.url()).origin !== "https://app.put.io")
      throw new ChillAuthorizationFailure("otp");
    stage = "otp";
    await page
      .locator('input[name="code"]')
      .fill(totp(configuration.otpSecret));
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    stage = "oauth";
    for (let attempt = 0; attempt < 30; attempt++) {
      signal.throwIfAborted();
      if (capturedToken) return capturedToken;
      const url = new URL(page.url());
      if (["https://app.put.io", "https://api.put.io"].includes(url.origin)) {
        const authorize = page.getByRole("button", {
          name:
            url.pathname === "/oauth/authenticate"
              ? /^(Confirm|Authorize|Allow|Approve)$/i
              : /^(Authorize|Allow|Approve)$/i,
        });
        if ((await authorize.count()) === 1 && (await authorize.isVisible()))
          await authorize.click();
      }
      await setTimeout(1000, undefined, { signal });
    }
    throw new ChillAuthorizationFailure("oauth");
  } catch {
    throw new ChillAuthorizationFailure(stage);
  } finally {
    signal.removeEventListener("abort", stop);
    if (browser) await closeBrowser(browser);
  }
}

export async function authorizeChill(
  options: { signal?: AbortSignal } = {},
): Promise<string> {
  let username: string;
  try {
    const configuration = Schema.decodeUnknownSync(Configuration)({
      username: process.env[liveVersions.usernameEnv]?.trim(),
      password: process.env[liveVersions.passwordEnv],
      otpSecret: process.env[liveVersions.otpEnv],
    });
    totp(configuration.otpSecret);
    username = configuration.username;
  } catch {
    throw new ChillAuthorizationFailure("configuration");
  }
  const directory = await liveRunnerDirectory();
  return cachedAuthorization({
    directory,
    username,
    signal: options.signal,
    login: () => authorizeWithBrowser(options),
    validate: async (token) => {
      options.signal?.throwIfAborted();
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const rpc = yield* createEngineRpc({
            baseUrl: "https://api.chill.institute/v4",
            token,
          });
          return yield* rpc.call((request) =>
            rpc.client.getUserProfile({}, request),
          );
        }).pipe(
          Effect.catch((error) => {
            if (
              error instanceof EngineError &&
              error.code === "unauthenticated"
            )
              return Effect.succeed(undefined);
            return Effect.fail(new ChillAuthorizationFailure("validation"));
          }),
        ),
        { signal: options.signal },
      );
      if (!result) return false;
      if (result.username !== username)
        throw new ChillAuthorizationFailure("validation");
      return true;
    },
  });
}
