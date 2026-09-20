import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { inspectFrame } from "../harness/native/desktop-evidence.ts";
import { desktopTextTarget } from "../harness/native/desktop-ui.ts";

const target = (text: string, x = "884", confidence = "96") =>
  `5\t1\t3\t1\t1\t1\t${x}\t377\t66\t13\t${confidence}\t${text}`;

test("desktop source targeting requires one confident visible matching label", () => {
  const bounds = { left: 800, top: 90, right: 1260, bottom: 640 };
  assert.deepEqual(
    desktopTextTarget(target("Interrupted"), "Interrupted", bounds),
    { x: 917, y: 384 },
  );
  for (const tsv of [
    target("Expired"),
    target("Interrupted", "100"),
    target("Interrupted", "884", "20"),
    target("Interrupted", "NaN"),
    `${target("Interrupted")}\n${target("Interrupted", "1000")}`,
  ]) {
    assert.equal(desktopTextTarget(tsv, "Interrupted", bounds), undefined);
  }
});

test("desktop integrity rejects sparse and dense grid corruption even with fixture colors", async () => {
  const clean = `<rect width="1280" height="720" fill="#d02020"/><rect x="120" y="160" width="1040" height="380" fill="#111"/><rect x="232" y="580" width="24" height="60" fill="white"/>`;
  const png = (extra = "") =>
    sharp(
      Buffer.from(
        `<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg">${clean}${extra}</svg>`,
      ),
    )
      .png()
      .toBuffer();
  const frame = await inspectFrame(await png());
  assert.equal(frame.intact, true);
  assert.equal(frame.marker, 4);
  for (const spacing of [4, 70]) {
    const grid =
      Array.from(
        { length: Math.ceil(1280 / spacing) },
        (_, i) =>
          `<rect x="${i * spacing}" width="2" height="720" fill="black"/>`,
      ).join("") +
      Array.from(
        { length: Math.ceil(720 / spacing) },
        (_, i) =>
          `<rect y="${i * spacing}" width="1280" height="2" fill="black"/>`,
      ).join("");
    const corrupt = await inspectFrame(await png(grid));
    assert.equal(corrupt.kind, "movie");
    assert.equal(corrupt.intact, false);
  }
  const black = await inspectFrame(
    await png('<rect width="1280" height="720" fill="black"/>'),
  );
  assert.equal(black.intact, false);
});
