import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { Effect, Schema } from "effect";
import { hostedFixture, movieTarget } from "../harness/hosted-fixture.ts";
import {
  hostedRequired,
  hostedRunPassed,
  type HostedRunProof,
} from "../harness/native/desktop-hosted-contract.ts";
import { startHostedDesktop } from "../harness/native/desktop-hosted.ts";
import {
  desktopTextMatches,
  desktopTextTarget,
} from "../harness/native/desktop-ui.ts";
import { statusMessages, type StatusMediaKind } from "../src/status-media.ts";

const Streams = Schema.Struct({
  streams: Schema.Array(Schema.Struct({ url: Schema.String })),
});
const StageReply = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
});

const word = (text: string, x: string, confidence = "96") =>
  `5\t1\t3\t1\t1\t1\t${x}\t377\t66\t13\t${confidence}\t${text}`;

test("visible-text checks accept duplicate titles that click targeting rejects", () => {
  const tsv = `${word("Hosted", "300")}\n${word("Hosted", "1000")}`;
  assert.equal(desktopTextMatches(tsv, "hosted").length, 2);
  assert.equal(desktopTextTarget(tsv, "Hosted"), undefined);
  assert.equal(
    desktopTextMatches(word("Hosted", "300", "40"), "Hosted").length,
    0,
  );
  assert.equal(
    desktopTextMatches(tsv, "Hosted", {
      left: 800,
      top: 90,
      right: 1260,
      bottom: 640,
    }).length,
    1,
  );
});

test("hosted desktop trials need every scenario plus adapter-side proof", () => {
  const hosted = {
    engineCalls: { transfer: 4, rejected: 0, unauthenticated: 3 },
    proxy: { manifest: 1, stream: 6 },
    media: { cuts: 1 },
    adapterRestarts: 1,
  };
  const passing: HostedRunProof = {
    status: "passed",
    remaining: [],
    freshState: true,
    cleanup: true,
    servicesClosed: true,
    hosted,
  };
  assert.equal(hostedRunPassed(passing), true);
  assert.equal(hostedRunPassed({ ...passing, hosted: undefined }), false);
  for (const broken of [
    { ...hosted, engineCalls: { ...hosted.engineCalls, transfer: 5 } },
    { ...hosted, engineCalls: { ...hosted.engineCalls, rejected: 1 } },
    { ...hosted, engineCalls: { ...hosted.engineCalls, unauthenticated: 0 } },
    { ...hosted, proxy: { ...hosted.proxy, stream: 0 } },
    { ...hosted, media: { cuts: 0 } },
    { ...hosted, adapterRestarts: 2 },
  ])
    assert.equal(hostedRunPassed({ ...passing, hosted: broken }), false);
  assert.equal(
    hostedRunPassed({ ...passing, remaining: ["reconnect-notice"] }),
    false,
  );
  assert.ok(hostedRequired.includes("exact-file-playback"));
  assert.ok(hostedRequired.includes("one-transfer-per-selection"));
});

test("hosted desktop terminal stages accept the adapter's HLS 409 contract", async () => {
  const statusMedia = new Map(
    (Object.keys(statusMessages) as StatusMediaKind[]).map((kind) => [
      kind,
      Buffer.from("fixture-status-video"),
    ]),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const hosted = yield* startHostedDesktop(
        "http://127.0.0.1:9",
        "http://127.0.0.1:3000",
        false,
        statusMedia,
      );
      const base = hosted.manifestUrl.replace(/\/manifest\.json$/, "");
      const stage = async (name: string, kind: string) => {
        const response = await fetch(`${hosted.controlUrl}/stage`, {
          method: "POST",
          body: JSON.stringify({ stage: name, kind }),
        });
        return Schema.decodeUnknownSync(StageReply)(await response.json());
      };
      yield* Effect.promise(async () => {
        for (const { kind } of hostedFixture.recoveryCases) {
          assert.deepEqual(await stage("recovery-detail", kind), { ok: true });
          const listing = await fetch(
            `${base}/stream/movie/${encodeURIComponent(movieTarget(`fixture-${kind}`))}.json`,
          );
          const [row] = Schema.decodeUnknownSync(Streams)(
            await listing.json(),
          ).streams;
          assert.ok(row);
          const selected = await fetch(row.url);
          assert.equal(selected.status, 409);
          assert.deepEqual(await selected.json(), { error: kind });
          assert.deepEqual(await stage("recovery-selected", kind), {
            ok: true,
          });
          assert.deepEqual(await stage("recovery-rendered", kind), {
            ok: true,
          });
        }
        await (await fetch(`${base}/notice/failed.mp4`)).arrayBuffer();
        const clip = await stage("recovery-rendered", "failed");
        assert.equal(clip.ok, false);
        assert.match(clip.error ?? "", /^Client requested a status clip/);
      });
    }).pipe(Effect.scoped),
  );
}, 60_000);
