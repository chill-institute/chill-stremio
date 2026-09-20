import { test } from "vite-plus/test";
import { Effect } from "effect";
import { NodeServices } from "@effect/platform-node";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  AndroidFailure,
  diagnostic,
  invoke,
  packageManagerFailure,
  emulatorAudioDiagnostic,
} from "../harness/native/android-process.ts";
import {
  classifyTvHierarchy,
  keepTvLabel,
} from "../harness/native/android-ui.ts";
import { androidVersions } from "../harness/native/android-versions.ts";
import {
  inspectFrame,
  parseNativeLog,
  pcmDbfs,
  seekMarkerMax,
  seekMarkerMin,
  subtitleOnMin,
  subtitleSpanMin,
} from "../harness/native/desktop-evidence.ts";

test("Android diagnostics redact secrets, URLs and local paths", () => {
  assert.equal(diagnostic("token=abc"), "[redacted]");
  assert.equal(
    diagnostic("fetch http://127.0.0.1:9/manifest.json"),
    "fetch [url]",
  );
  assert.ok(!diagnostic(`cwd ${process.cwd()}`).includes(process.cwd()));
});

test("Android APK pin is a 64-character SHA256", () => {
  assert.match(androidVersions.apkSha256, /^[0-9a-f]{64}$/);
  assert.equal(androidVersions.package, "com.stremio.one");
});

test("TV UI classifier keeps pairing labels and drops codes", () => {
  assert.equal(keepTvLabel("Link Account"), true);
  assert.equal(keepTvLabel("ABCD1234"), false);
  assert.equal(keepTvLabel("https://www.stremio.com/login"), false);
  const xml = `<hierarchy><node package="com.stremio.one" text="Link Account"/><node text="Scan QR Code above or go to https://www.stremio.com/tv"/><node text="WXYZ9876"/><node text="Expires in"/><node text="user@example.com"/></hierarchy>`;
  const ui = classifyTvHierarchy(xml, androidVersions.package);
  assert.equal(ui.clientWindow, true);
  assert.equal(ui.loginWall, true);
  assert.equal(ui.pairingChallenge, true);
  assert.equal(ui.guest, false);
  assert.deepEqual(ui.uiText, ["Link Account", "Expires in"]);
  assert.equal(ui.uiText.includes("WXYZ9876"), false);
});

test("native log parser requires libmpv VO and Pulse AO lines", () => {
  assert.deepEqual(
    parseNativeLog("VO: [libmpv] 640x360 yuv420p\nAO: [pulse] 48000Hz mono"),
    { vo: true, ao: true, noticeVo: false },
  );
  assert.deepEqual(parseNativeLog("VO: [gpu] 640x360"), {
    vo: false,
    ao: false,
    noticeVo: false,
  });
  assert.equal(parseNativeLog("VO: [libmpv] 1280x720 yuv420p").noticeVo, true);
});

test("PCM dBFS distinguishes a sine from silence", () => {
  const silent = wav(Array.from({ length: 4800 }, () => 0));
  const tone = wav(
    Array.from({ length: 4800 }, (_, index) =>
      Math.sin((2 * Math.PI * 440 * index) / 48000),
    ),
  );
  assert.ok(pcmDbfs(silent) < -80);
  assert.ok(pcmDbfs(tone) > -6 && pcmDbfs(tone) < 0);
});

test(
  "desktop frame inspector reads fixture identity, marker and subtitle pixels",
  { timeout: 10_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "chill-native-"));
    try {
      const movie = join(directory, "movie.png");
      const seek = join(directory, "seek.png");
      const dark = join(directory, "dark.png");
      await writeFile(movie, await fixturePng(4));
      await writeFile(seek, await fixturePng(21));
      await writeFile(
        dark,
        await sharp({
          create: {
            width: 1280,
            height: 720,
            channels: 3,
            background: "#000000",
          },
        })
          .png()
          .toBuffer(),
      );
      const playing = await inspectFrame(movie);
      const sought = await inspectFrame(seek);
      const blank = await inspectFrame(dark);
      assert.equal(playing.kind, "movie");
      assert.equal(playing.marker, 4);
      assert.ok(playing.subtitlePixels >= subtitleOnMin);
      assert.ok(playing.subtitleSpan >= subtitleSpanMin);
      assert.equal(sought.marker, 21);
      assert.ok(
        sought.marker >= seekMarkerMin && sought.marker <= seekMarkerMax,
      );
      assert.notEqual(playing.pixelsHash, sought.pixelsHash);
      assert.equal(blank.kind, undefined);
      assert.equal(blank.marker, -1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

function wav(samples: number[]) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    data.writeInt16LE(Math.round(sample * 32767), index * 2);
  });
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(96000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function fixturePng(second: number) {
  const x = 120 + second * 28;
  const svg = `<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><rect width="1280" height="720" fill="#d02020"/><rect x="120" y="160" width="1040" height="380" fill="#111"/><text x="180" y="360" fill="white" font-size="48">TIME 00:${String(second).padStart(2, "0")}</text><rect x="${x}" y="612" width="24" height="52" fill="white"/><text x="420" y="540" fill="white" font-size="32">FIXTURE SUBTITLE ENGLISH</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

test("Android install diagnostics retain only recognized failure codes", () => {
  assert.equal(
    packageManagerFailure(
      "adb: failed to install /private/account.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE: token=secret https://private.example]",
    ),
    "INSTALL_FAILED_INSUFFICIENT_STORAGE",
  );
  assert.equal(
    packageManagerFailure(
      "Failure [UNRECOGNIZED_PRIVATE_CODE: email@example.com]",
    ),
    "unclassified-install-failure",
  );
  assert.equal(
    packageManagerFailure("password=private pairing=AB12"),
    "unclassified-install-failure",
  );
  for (const [output, expected] of [
    ["adb: error: device offline", "install-transport-disconnected"],
    ["failed to read response: EOF", "install-transport-eof"],
    ["Can't find service: package", "install-package-service-unavailable"],
    ["User 0 is locked", "install-user-locked"],
    [
      "Exception occurred while executing 'install'",
      "install-package-manager-exception",
    ],
    ["", "install-empty-output"],
    [
      "Performing Streamed Install\nadb: failed to install /private/account.apk: ",
      "install-empty-failure-detail",
    ],
  ])
    assert.equal(packageManagerFailure(output ?? ""), expected);
});

test("Android audio log evidence retains static backend categories only", () => {
  assert.equal(
    emulatorAudioDiagnostic("pa: Failed to connect to private/socket"),
    "pulse-backend-error",
  );
  assert.equal(
    emulatorAudioDiagnostic("audio: could not initialize backend /private"),
    "audio-backend-error",
  );
  assert.equal(emulatorAudioDiagnostic("audio disabled"), "audio-disabled");
  assert.equal(
    emulatorAudioDiagnostic("password=private pairing=AB12"),
    undefined,
  );
  assert.equal(emulatorAudioDiagnostic("audio initialized"), undefined);
});

test("Android command failure retains exit status and safe package classification", async () => {
  const error = await Effect.runPromise(
    invoke(
      process.execPath,
      [
        "-e",
        'process.stdout.write("Failure [INSTALL_FAILED_INVALID_APK: token=private]"); process.exit(7)',
        "install",
      ],
      {},
    ).pipe(Effect.flip, Effect.provide(NodeServices.layer)),
  );
  assert.ok(error instanceof AndroidFailure);
  assert.equal(error.exitCode, 7);
  assert.equal(error.code, "INSTALL_FAILED_INVALID_APK");
  assert.equal(error.message, "[redacted]");
});
