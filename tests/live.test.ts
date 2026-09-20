import { test, vi } from "vite-plus/test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AllowanceFailure,
  readLedger,
  reserve,
  utcDay,
} from "../harness/live/allowance.ts";
import {
  designatedAccountPresent,
  designatedPutioTokenPresent,
  redactLive,
} from "../harness/live/redact.ts";
import { classifyEgress } from "../harness/live/egress.ts";
import { liveVersions } from "../harness/live/versions.ts";
import {
  AccountEnvelope,
  DownloadUrlEnvelope,
  TransferEnvelope,
  UploadEnvelope,
} from "../harness/live/putio.ts";
import {
  firstHttpsUri,
  hlsAdvertisesSubtitles,
  proveUrlRenewal,
  rangeSupported,
  signedUrlExpiryUnix,
} from "../harness/live/playback.ts";
import {
  liveFolderName,
  liveSubtitleName,
  liveUploadName,
} from "../harness/live/source.ts";
import { Effect, Schema } from "effect";

test("live budget and designated env names", () => {
  assert.equal(liveVersions.accountNameEnv, "PUTIO_ACCOUNT_NAME");
  assert.equal(liveVersions.usernameEnv, "PUTIO_USERNAME");
  assert.equal(liveVersions.passwordEnv, "PUTIO_PASSWORD");
  assert.equal(liveVersions.otpEnv, "PUTIO_OTP_SECRET");
  assert.equal(liveVersions.putioTokenEnv, "PUTIO_TEST_TOKEN");
  assert.equal(liveVersions.byteLimit, 10 * 1024 * 1024 * 1024);
  assert.equal(liveVersions.subtitleFile, "english.vtt");
  assert.equal(liveVersions.fixtureSubtitle, "FIXTURE SUBTITLE ENGLISH");
  assert.equal(liveVersions.folderPrefix, "chill-stremio-live");
  assert.equal(liveVersions.apiBase, "https://api.put.io");
  assert.equal(liveVersions.egressProxyEnv, "LIVE_EGRESS_PROXY");
});

test("live redaction strips tokens, magnets, URLs and local paths", () => {
  assert.equal(redactLive("token=abc"), "[redacted]");
  assert.equal(redactLive("magnet:?xt=urn:btih:abcd"), "[redacted]");
  assert.equal(redactLive("fetch http://127.0.0.1:9/file"), "fetch [url]");
  assert.ok(!redactLive(`cwd ${process.cwd()}`).includes(process.cwd()));
});

test("generic PUTIO_OAUTH_TOKEN does not count as the designated account", () => {
  const previous = {
    account: process.env.PUTIO_ACCOUNT_NAME,
    username: process.env.PUTIO_USERNAME,
    password: process.env.PUTIO_PASSWORD,
    otp: process.env.PUTIO_OTP_SECRET,
    putio: process.env.PUTIO_TEST_TOKEN,
    generic: process.env.PUTIO_OAUTH_TOKEN,
  };
  delete process.env.PUTIO_ACCOUNT_NAME;
  delete process.env.PUTIO_USERNAME;
  delete process.env.PUTIO_PASSWORD;
  delete process.env.PUTIO_OTP_SECRET;
  delete process.env.PUTIO_TEST_TOKEN;
  process.env.PUTIO_OAUTH_TOKEN = "generic";
  try {
    assert.equal(designatedAccountPresent(), false);
    assert.equal(designatedPutioTokenPresent(), false);
  } finally {
    restore("PUTIO_ACCOUNT_NAME", previous.account);
    restore("PUTIO_USERNAME", previous.username);
    restore("PUTIO_PASSWORD", previous.password);
    restore("PUTIO_OTP_SECRET", previous.otp);
    restore("PUTIO_TEST_TOKEN", previous.putio);
    restore("PUTIO_OAUTH_TOKEN", previous.generic);
  }
});

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("allowance reserves conservatively and stops on invalid or exhausted ledgers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chill-live-"));
  try {
    await writeFile(
      join(directory, "allowance.json"),
      JSON.stringify({ day: utcDay(), reservedTransfers: 0, reservedBytes: 0 }),
    );
    const first = await reserve(directory, 2, 100);
    assert.equal(first.day, utcDay());
    assert.equal(first.reservedTransfers, 2);
    await reserve(directory, Number.MAX_SAFE_INTEGER - 2, 0);
    await assert.rejects(
      () => reserve(directory, 1, 0),
      (cause: unknown) => cause instanceof AllowanceFailure,
    );
    const bytesDirectory = await mkdtemp(join(tmpdir(), "chill-live-bytes-"));
    try {
      await writeFile(
        join(bytesDirectory, "allowance.json"),
        JSON.stringify({
          day: utcDay(),
          reservedTransfers: 0,
          reservedBytes: 0,
        }),
      );
      await reserve(bytesDirectory, 1, liveVersions.byteLimit);
      await assert.rejects(
        () => reserve(bytesDirectory, 1, 1),
        (cause: unknown) => cause instanceof AllowanceFailure,
      );
    } finally {
      await rm(bytesDirectory, { recursive: true, force: true });
    }
    await writeFile(join(directory, "allowance.json"), "{");
    await assert.rejects(
      () => readLedger(join(directory, "allowance.json")),
      (cause: unknown) => cause instanceof AllowanceFailure,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live artifact names stay on the designated prefix", () => {
  assert.equal(liveFolderName("stamp"), "chill-stremio-live-stamp");
  assert.equal(liveUploadName("stamp"), "chill-stremio-live-stamp-movie.mp4");
  assert.equal(
    liveSubtitleName("stamp"),
    "chill-stremio-live-stamp-movie.en.srt",
  );
});

test("put.io envelopes accept file responses and require HTTPS download URLs", () => {
  const account = Schema.decodeUnknownSync(AccountEnvelope)({
    status: "OK",
    info: { username: "user", account_status: "active" },
  });
  assert.equal(account.info.account_status, "active");
  const uploaded = Schema.decodeUnknownSync(UploadEnvelope)({
    status: "OK",
    file: { id: 12, name: "movie.mp4", size: 2048 },
  });
  assert.equal(uploaded.file?.id, 12);
  const download = Schema.decodeUnknownSync(DownloadUrlEnvelope)({
    status: "OK",
    url: "https://example.test/file",
  });
  assert.equal(download.url.startsWith("https://"), true);
  assert.throws(() =>
    Schema.decodeUnknownSync(AccountEnvelope)({ status: "ERROR" }),
  );
});

test("HTTP Range proof requires 206", () => {
  assert.equal(rangeSupported(206), true);
  assert.equal(rangeSupported(200), false);
  assert.equal(rangeSupported(416), false);
});

test("URL renewal accepts reused URLs and checks the resolved URL without credentials", async () => {
  const previous = "https://example.test/media?token=fixture-only";
  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    for (const resolved of [previous, `${previous}-renewed`]) {
      fetchMock.mockResolvedValueOnce(new Response("bytes", { status: 206 }));
      const evidence = await Effect.runPromise(
        proveUrlRenewal(previous, resolved),
      );
      assert.deepEqual(evidence, {
        distinct: previous !== resolved,
        secondRange: 206,
      });
      const request = fetchMock.mock.lastCall;
      assert.equal(request?.[0], resolved);
      assert.deepEqual(request?.[1]?.headers, { range: "bytes=0-1023" });
      assert.ok(!JSON.stringify(evidence).includes("fixture-only"));
    }
  } finally {
    fetchMock.mockRestore();
  }
});

test("URL renewal fails on broken or limited URLs without retrying", async () => {
  const url = "https://example.test/media?token=fixture-only";
  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    for (const status of [200, 403, 429]) {
      fetchMock.mockResolvedValueOnce(new Response("bytes", { status }));
      await assert.rejects(
        Effect.runPromise(proveUrlRenewal(url, url)),
        (cause: unknown) => {
          assert.ok(String(cause).includes(`HTTP Range (${status})`));
          assert.ok(!String(cause).includes("fixture-only"));
          return true;
        },
      );
    }
    assert.equal(fetchMock.mock.calls.length, 3);
  } finally {
    fetchMock.mockRestore();
  }
});

test("HLS subtitle advertisement is detected without keeping playlist URLs", () => {
  assert.equal(
    hlsAdvertisesSubtitles(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",URI="https://example.test/a.vtt"',
    ),
    true,
  );
  assert.equal(
    hlsAdvertisesSubtitles("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1"),
    false,
  );
  assert.equal(
    firstHttpsUri(
      '#EXT-X-MEDIA:TYPE=SUBTITLES,URI="https://example.test/a.vtt"',
    ),
    "https://example.test/a.vtt",
  );
});

test("signed URL expiry is parsed without keeping the URL", () => {
  assert.equal(
    signedUrlExpiryUnix("https://example.test/file?expires=1700000000"),
    1700000000,
  );
  assert.equal(signedUrlExpiryUnix("https://example.test/file"), undefined);
  assert.equal(
    signedUrlExpiryUnix("http://example.test/file?expires=1"),
    undefined,
  );
});

test("put.io transfer envelopes accept COMPLETED URL transfers", () => {
  const row = Schema.decodeUnknownSync(TransferEnvelope)({
    status: "OK",
    transfer: {
      id: 9,
      status: "COMPLETED",
      file_id: 44,
      type: "URL",
      percent_done: 100,
    },
  });
  assert.equal(row.transfer?.status, "COMPLETED");
  assert.equal(row.transfer?.file_id, 44);
});

test("put.io transfer envelopes accept rejects and null progress fields", () => {
  const rejected = Schema.decodeUnknownSync(TransferEnvelope)({
    status: "ERROR",
    error_type: "BadRequest",
    error_message: "not allowed",
  });
  assert.equal(rejected.transfer, undefined);
  assert.equal(rejected.error_type, "BadRequest");
  const queued = Schema.decodeUnknownSync(TransferEnvelope)({
    status: "OK",
    transfer: {
      id: 1,
      status: "IN_QUEUE",
      percent_done: null,
      type: null,
    },
  });
  assert.equal(queued.transfer?.id, 1);
});

test("distinct egress requires a second public path with HTTP 206", () => {
  assert.deepEqual(
    classifyEgress({ defaultRange: 206, proxyConfigured: false }),
    { status: "blocked", reason: "single-public-egress" },
  );
  assert.deepEqual(
    classifyEgress({
      defaultRange: 206,
      proxyConfigured: true,
      proxyRange: 206,
    }),
    { status: "passed" },
  );
  assert.deepEqual(
    classifyEgress({
      defaultRange: 206,
      proxyConfigured: true,
      proxyRange: 403,
    }),
    { status: "blocked", reason: "second-path-range-failed" },
  );
});
