import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

export const statusMessages = {
  pending: [
    "Downloading to put.io",
    "Select the release again",
    "to keep waiting.",
  ],
  preparing: [
    "Video not ready yet",
    "put.io is preparing it.",
    "Select it again soon.",
  ],
  unknown: [
    "Download status unknown",
    "Check put.io library in Stremio",
    "before selecting again.",
  ],
  failed: [
    "Download failed",
    "Check the transfer on put.io",
    "or choose another release.",
  ],
  "select-file": [
    "Download ready",
    "Open put.io library in Stremio",
    "to choose a file.",
  ],
  unavailable: [
    "Playback unavailable",
    "Open put.io library in Stremio",
    "to try the video again.",
  ],
  "release-unavailable": [
    "Release unavailable",
    "Choose another release",
    "or try again later.",
  ],
  reconnect: [
    "Reconnect chill.institute",
    "Open chill.institute/stremio",
    "and install the add-on again.",
  ],
} as const;
export type StatusMediaKind = keyof typeof statusMessages;
export const statusMediaKinds = Object.keys(
  statusMessages,
) as StatusMediaKind[];
/** Legacy `.mp4` clips, and HLS clips: a VOD playlist with one MPEG-TS segment. */
export type StatusMediaFormat = "mp4" | "m3u8" | "ts";
export type StatusMedia = ReadonlyMap<
  StatusMediaKind,
  Readonly<Record<StatusMediaFormat, Buffer>>
>;
/** Players return to the stream list when a clip ends, so HLS clips stay short. */
export const statusClipSeconds = 5;
export const statusPlaylist = (kind: StatusMediaKind) =>
  [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    `#EXT-X-TARGETDURATION:${statusClipSeconds}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    `#EXTINF:${statusClipSeconds.toFixed(3)},`,
    `${kind}.ts`,
    "#EXT-X-ENDLIST",
    "",
  ].join("\n");
const contentTypes = {
  mp4: "video/mp4",
  m3u8: "application/vnd.apple.mpegurl",
  ts: "video/mp2t",
} as const;
const maxBytes = { mp4: 2 * 1024 * 1024, m3u8: 4096, ts: 512 * 1024 };
const tsPacketBytes = 188;

const wellFormed = (
  kind: StatusMediaKind,
  format: StatusMediaFormat,
  bytes: Buffer,
) => {
  if (format === "mp4")
    return bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
  if (format === "m3u8") return bytes.toString("utf8") === statusPlaylist(kind);
  if (bytes.length === 0 || bytes.length % tsPacketBytes !== 0) return false;
  for (let offset = 0; offset < bytes.length; offset += tsPacketBytes)
    if (bytes[offset] !== 0x47) return false;
  return true;
};

async function readStatusFile(
  directory: string,
  kind: StatusMediaKind,
  format: StatusMediaFormat,
) {
  const file = await open(
    resolve(directory, `${kind}.${format}`),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxBytes[format])
      throw new Error(`Invalid status media: ${kind}.${format}`);
    const bytes = Buffer.alloc(info.size);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== bytes.length || !wellFormed(kind, format, bytes))
      throw new Error(`Invalid status media: ${kind}.${format}`);
    return bytes;
  } finally {
    await file.close();
  }
}

export async function loadStatusMedia(
  directory = resolve(".cache/status-media"),
): Promise<StatusMedia> {
  const media = new Map<
    StatusMediaKind,
    Readonly<Record<StatusMediaFormat, Buffer>>
  >();
  for (const kind of statusMediaKinds)
    media.set(kind, {
      mp4: await readStatusFile(directory, kind, "mp4"),
      m3u8: await readStatusFile(directory, kind, "m3u8"),
      ts: await readStatusFile(directory, kind, "ts"),
    });
  return media;
}

export function sendStatusMedia(
  request: IncomingMessage,
  response: ServerResponse,
  media: StatusMedia,
  status: StatusMediaKind,
  format: StatusMediaFormat,
): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }
  const bytes = media.get(status)?.[format];
  if (!bytes) {
    response.writeHead(503);
    response.end();
    return;
  }
  response.setHeader("Content-Type", contentTypes[format]);
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("X-Content-Type-Options", "nosniff");
  let start = 0;
  let end = bytes.length - 1;
  const range = request.method === "GET" ? request.headers.range : undefined;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    let valid = Boolean(match && (match[1] || match[2]));
    if (match && valid) {
      if (match[1]) {
        start = Number(match[1]);
        const requestedEnd = match[2] ? Number(match[2]) : end;
        valid =
          Number.isSafeInteger(start) &&
          Number.isSafeInteger(requestedEnd) &&
          start <= requestedEnd;
        end = Math.min(requestedEnd, end);
      } else {
        const suffix = Number(match[2]);
        valid = Number.isSafeInteger(suffix) && suffix > 0;
        start = Math.max(0, bytes.length - suffix);
      }
    }
    if (!valid || start >= bytes.length) {
      response.writeHead(416, { "Content-Range": `bytes */${bytes.length}` });
      response.end();
      return;
    }
    response.setHeader(
      "Content-Range",
      `bytes ${start}-${end}/${bytes.length}`,
    );
  }
  response.setHeader("Content-Length", end - start + 1);
  response.writeHead(range ? 206 : 200);
  response.end(
    request.method === "HEAD" ? undefined : bytes.subarray(start, end + 1),
  );
}
