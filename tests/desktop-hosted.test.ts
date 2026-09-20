import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  hostedRequired,
  hostedRunPassed,
  type HostedRunProof,
} from "../harness/native/desktop-hosted-contract.ts";
import {
  desktopTextMatches,
  desktopTextTarget,
} from "../harness/native/desktop-ui.ts";

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
    engineCalls: { transfer: 4, rejected: 0 },
    proxy: { manifest: 1, stream: 6, deniedAfterRevocation: 3 },
    media: { cuts: 1 },
    adapterRestarts: 2,
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
    { ...hosted, engineCalls: { transfer: 5, rejected: 0 } },
    { ...hosted, engineCalls: { transfer: 4, rejected: 1 } },
    { ...hosted, proxy: { ...hosted.proxy, deniedAfterRevocation: 0 } },
    { ...hosted, proxy: { ...hosted.proxy, stream: 0 } },
    { ...hosted, media: { cuts: 0 } },
    { ...hosted, adapterRestarts: 1 },
  ])
    assert.equal(hostedRunPassed({ ...passing, hosted: broken }), false);
  assert.equal(
    hostedRunPassed({ ...passing, remaining: ["revocation-denied"] }),
    false,
  );
  assert.ok(hostedRequired.includes("exact-file-playback"));
  assert.ok(hostedRequired.includes("durable-claims"));
});
