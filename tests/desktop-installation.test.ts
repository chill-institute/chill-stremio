import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import {
  desktopInstallationPassed,
  desktopInstallStage,
} from "../harness/native/desktop-ui.ts";

test("native mouse success and an empty add dialog do not prove installation", () => {
  assert.equal(
    desktopInstallationPassed({
      guestPassed: true,
      manifestStage: "add-url",
      installedStage: "addons",
      streamRequests: 0,
    }),
    false,
  );
});

test("native installation needs a confirmed manifest, completed UI and fixture routing", () => {
  const installed = {
    guestPassed: true,
    manifestStage: "manifest" as const,
    installedStage: "addons" as const,
    streamRequests: 1,
  };
  assert.equal(desktopInstallationPassed(installed), true);
  assert.equal(
    desktopInstallationPassed({ ...installed, guestPassed: false }),
    false,
  );
  assert.equal(
    desktopInstallationPassed({ ...installed, manifestStage: undefined }),
    false,
  );
  assert.equal(
    desktopInstallationPassed({ ...installed, installedStage: "manifest" }),
    false,
  );
  assert.equal(
    desktopInstallationPassed({ ...installed, streamRequests: 0 }),
    false,
  );
});

test("native installation rejects absent or unsupported display pixels", () => {
  assert.equal(desktopInstallStage(new Uint8Array(), 1280, 720), undefined);
  assert.equal(
    desktopInstallStage(new Uint8Array(640 * 360 * 3), 640, 360),
    undefined,
  );
  assert.equal(
    desktopInstallStage(new Uint8Array(1280 * 720 * 3), 1280, 720),
    undefined,
  );
});

test("recorded native screens distinguish empty URL, manifest and addon states", async () => {
  for (const [name, expected] of [
    ["addons", "addons"],
    ["add-url", "add-url"],
    ["manifest", "manifest"],
    ["hosted-manifest", "manifest"],
    ["not-installed", undefined],
  ] as const) {
    const file = new URL(
      `./fixtures/desktop-installation/${name}.png`,
      import.meta.url,
    );
    const { data, info } = await sharp(await readFile(file))
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(
      desktopInstallStage(data, info.width, info.height),
      expected,
      name,
    );
  }
});
