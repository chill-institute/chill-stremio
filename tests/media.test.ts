import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMedia } from "../harness/media.ts";

test("cancelled media generation preserves previous fixtures and removes staging", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chill-media-"));
  const target = join(directory, "media");
  try {
    await mkdir(target);
    await writeFile(join(target, "previous"), "complete");
    await assert.rejects(generateMedia(target, AbortSignal.abort()));
    assert.equal(await readFile(join(target, "previous"), "utf8"), "complete");
    assert.deepEqual(await readdir(directory), ["media"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
