import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vite-plus/test";
import {
  loadStatusMedia,
  sendStatusMedia,
  statusClipSeconds,
  statusMediaKinds,
  statusPlaylist,
} from "../src/status-media.ts";

const sample = Buffer.from("0000ftyp0123456789abcdef");
const segment = Buffer.alloc(188 * 3, 0x47);

test("status media supports player byte requests and HEAD without side effects", async () => {
  const media = new Map([
    [
      "pending" as const,
      {
        mp4: sample,
        m3u8: Buffer.from(statusPlaylist("pending")),
        ts: segment,
      },
    ],
  ]);
  const server = createServer((request, response) => {
    const format = request.url?.endsWith(".ts")
      ? "ts"
      : request.url?.endsWith(".m3u8")
        ? "m3u8"
        : "mp4";
    sendStatusMedia(request, response, media, "pending", format);
  });
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
    assert.equal(full.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), sample);
    const playlist = await fetch(`${url}.m3u8`);
    assert.equal(
      playlist.headers.get("content-type"),
      "application/vnd.apple.mpegurl",
    );
    assert.equal(await playlist.text(), statusPlaylist("pending"));
    const ts = await fetch(`${url}.ts`, { headers: { Range: "bytes=188-" } });
    assert.equal(ts.status, 206);
    assert.equal(ts.headers.get("content-type"), "video/mp2t");
    assert.deepEqual(
      Buffer.from(await ts.arrayBuffer()),
      segment.subarray(188),
    );
    const post = await fetch(url, { method: "POST" });
    assert.equal(post.status, 405);
    await post.arrayBuffer();
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("status playlists are single-segment VOD clips relative to their own URL", () => {
  for (const kind of statusMediaKinds) {
    const lines = statusPlaylist(kind).trim().split("\n");
    assert.equal(lines[0], "#EXTM3U");
    assert.ok(lines.includes("#EXT-X-PLAYLIST-TYPE:VOD"));
    assert.equal(lines.at(-1), "#EXT-X-ENDLIST");
    assert.deepEqual(
      lines.filter((line) => !line.startsWith("#")),
      [`${kind}.ts`],
    );
    assert.ok(
      lines.includes(`#EXTINF:${statusClipSeconds.toFixed(3)},`) &&
        lines.includes(`#EXT-X-TARGETDURATION:${statusClipSeconds}`),
    );
  }
});

test("status assets must all exist as bounded, well-formed regular files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "status-media-test-"));
  try {
    await assert.rejects(loadStatusMedia(directory));
    for (const kind of statusMediaKinds) {
      await writeFile(join(directory, `${kind}.mp4`), sample);
      await writeFile(join(directory, `${kind}.m3u8`), statusPlaylist(kind));
      await writeFile(join(directory, `${kind}.ts`), segment);
    }
    const loaded = await loadStatusMedia(directory);
    assert.equal(loaded.size, statusMediaKinds.length);
    assert.deepEqual(loaded.get("failed")?.ts, segment);
    const invalid = async (file: string, content: string | Buffer) => {
      const path = join(directory, file);
      await writeFile(path, content);
      await assert.rejects(loadStatusMedia(directory), /Invalid status media/);
    };
    await invalid("pending.mp4", "not an mp4 file");
    await invalid("pending.mp4", Buffer.alloc(2 * 1024 * 1024 + 1));
    await writeFile(join(directory, "pending.mp4"), sample);
    await invalid("failed.ts", Buffer.alloc(188 * 3 - 1, 0x47));
    const unsynced = Buffer.from(segment);
    unsynced[188] = 0;
    await invalid("failed.ts", unsynced);
    await invalid("failed.ts", Buffer.alloc(188 * 2789, 0x47));
    await invalid("failed.ts", Buffer.alloc(0));
    await writeFile(join(directory, "failed.ts"), segment);
    await invalid(
      "failed.m3u8",
      statusPlaylist("failed").replace(
        "failed.ts",
        "https://fixture.invalid/x.ts",
      ),
    );
    await invalid("failed.m3u8", statusPlaylist("unknown"));
    await writeFile(join(directory, "failed.m3u8"), statusPlaylist("failed"));
    assert.equal(
      (await loadStatusMedia(directory)).size,
      statusMediaKinds.length,
    );
    for (const [format, content] of [
      ["mp4", sample],
      ["m3u8", statusPlaylist("pending")],
      ["ts", segment],
    ] as const) {
      const path = join(directory, `pending.${format}`);
      await rm(path);
      await assert.rejects(loadStatusMedia(directory));
      const copy = join(directory, `copy.${format}`);
      await writeFile(copy, content);
      await symlink(copy, path);
      await assert.rejects(loadStatusMedia(directory));
      await rm(path);
      await writeFile(path, content);
    }
    assert.equal(
      (await loadStatusMedia(directory)).size,
      statusMediaKinds.length,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
