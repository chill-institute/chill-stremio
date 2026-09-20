import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  loadStatusMedia,
  sendStatusMedia,
  statusMessages,
} from "../src/status-media.ts";

const sample = Buffer.from("0000ftyp0123456789abcdef");

test("status media supports player byte requests and HEAD without side effects", async () => {
  const media = new Map([["pending" as const, sample]]);
  const server = createServer((request, response) =>
    sendStatusMedia(request, response, media, "pending"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/status`;
    for (const [range, start, end] of [
      ["bytes=4-7", 4, 8],
      ["bytes=-4", sample.length - 4, sample.length],
      ["bytes=4-", 4, sample.length],
      ["bytes=4-999", 4, sample.length],
    ] as const) {
      const response = await fetch(url, { headers: { Range: range } });
      assert.equal(response.status, 206);
      assert.equal(
        response.headers.get("content-range"),
        `bytes ${start}-${end - 1}/${sample.length}`,
      );
      assert.deepEqual(
        Buffer.from(await response.arrayBuffer()),
        sample.subarray(start, end),
      );
    }
    for (const range of [
      "bytes=99-",
      "bytes=9-2",
      "bytes=-0",
      "bytes=0-1,4-5",
      "bytes=-",
      "bytes=9007199254740992-",
    ]) {
      const response = await fetch(url, { headers: { Range: range } });
      assert.equal(response.status, 416);
      assert.equal(
        response.headers.get("content-range"),
        `bytes */${sample.length}`,
      );
      await response.arrayBuffer();
    }
    const head = await fetch(url, {
      method: "HEAD",
      headers: { Range: "bytes=4-7" },
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(sample.length));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
    const full = await fetch(url);
    assert.equal(full.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), sample);
    const post = await fetch(url, { method: "POST" });
    assert.equal(post.status, 405);
    await post.arrayBuffer();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("status assets must all exist, be bounded regular MP4 files and not symlinks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "status-media-test-"));
  try {
    await assert.rejects(loadStatusMedia(directory));
    for (const status of Object.keys(statusMessages)) {
      await writeFile(join(directory, `${status}.mp4`), sample);
    }
    assert.equal((await loadStatusMedia(directory)).size, 5);
    const pending = join(directory, "pending.mp4");
    await writeFile(pending, "not an mp4 file");
    await assert.rejects(loadStatusMedia(directory), /Invalid status media/);
    await writeFile(pending, Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(loadStatusMedia(directory), /Invalid status media/);
    await rm(pending);
    await symlink(join(directory, "failed.mp4"), pending);
    await assert.rejects(loadStatusMedia(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
