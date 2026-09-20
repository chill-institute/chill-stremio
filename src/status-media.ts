import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";

export const statusMessages = {
  pending: [
    "Downloading to put.io",
    "Go back to Downloads in Stremio",
    "to check progress.",
  ],
  unknown: [
    "Download status unknown",
    "Do not submit again.",
    "Check Downloads in Stremio.",
  ],
  failed: [
    "Download failed",
    "Go back to Downloads in Stremio",
    "to check the download.",
  ],
  "select-file": [
    "Download ready",
    "Go back to Acquired videos in Stremio",
    "to choose a file.",
  ],
  unavailable: [
    "Playback unavailable",
    "Go back to Downloads in Stremio",
    "to check the download.",
  ],
} as const;
export type StatusMediaKind = keyof typeof statusMessages;
export type StatusMedia = ReadonlyMap<StatusMediaKind, Buffer>;
const maxFileBytes = 2 * 1024 * 1024;

export async function loadStatusMedia(
  directory = resolve(".cache/status-media"),
): Promise<StatusMedia> {
  const media = new Map<StatusMediaKind, Buffer>();
  for (const status of Object.keys(statusMessages) as StatusMediaKind[]) {
    const file = await open(
      resolve(directory, `${status}.mp4`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 12 || info.size > maxFileBytes) {
        throw new Error(`Invalid status media: ${status}`);
      }
      const bytes = Buffer.alloc(info.size);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (
        bytesRead !== bytes.length ||
        bytes.toString("ascii", 4, 8) !== "ftyp"
      ) {
        throw new Error(`Invalid status media: ${status}`);
      }
      media.set(status, bytes);
    } finally {
      await file.close();
    }
  }
  return media;
}

export function sendStatusMedia(
  request: IncomingMessage,
  response: ServerResponse,
  media: StatusMedia,
  status: StatusMediaKind,
): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }
  const bytes = media.get(status);
  if (!bytes) {
    response.writeHead(503);
    response.end();
    return;
  }
  response.setHeader("Content-Type", "video/mp4");
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
