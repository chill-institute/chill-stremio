import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";

export type FixtureKind = "movie" | "episode1" | "episode2";
export const identityPixelsMin = 20_000;
export const seekMarkerMin = 18;
export const seekMarkerMax = 23;
export const subtitleOnMin = 400;
export const subtitleSpanMin = 200;
export const pcmDbfsMin = -40;

export interface FrameEvidence {
  width: number;
  height: number;
  kind?: FixtureKind;
  identityPixels: number;
  intact: boolean;
  borderCoverage: number;
  marker: number;
  pixelsHash: string;
  subtitlePixels: number;
  subtitleSpan: number;
}

const kinds: FixtureKind[] = ["movie", "episode1", "episode2"];
const channel = (kind: FixtureKind) =>
  kind === "movie" ? 0 : kind === "episode1" ? 1 : 2;

const identity = (r: number, g: number, b: number, kind: FixtureKind) => {
  const values = [r, g, b];
  const selected = channel(kind);
  return (
    (values[selected] ?? 0) > 140 &&
    values.every((value, index) => index === selected || value < 100)
  );
};
const white = (r: number, g: number, b: number) =>
  r > 200 && g > 200 && b > 200;

export async function inspectFrame(
  path: string | Buffer,
): Promise<FrameEvidence> {
  const { data, info } = await sharp(path)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = info.width ?? 0;
  const height = info.height ?? 0;
  const pixel = (x: number, y: number) => {
    const index = (y * width + x) * info.channels;
    return [
      data[index] ?? 0,
      data[index + 1] ?? 0,
      data[index + 2] ?? 0,
    ] as const;
  };
  const counts: Record<FixtureKind, number> = {
    movie: 0,
    episode1: 0,
    episode2: 0,
  };
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      for (const kind of kinds) {
        if (!identity(r, g, b, kind)) continue;
        counts[kind]++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  const kind = kinds.find((item) => counts[item] >= identityPixelsMin);
  // These fixture borders are solid color; UI overlays and broken composition
  // must not be mistaken for decoded video from a surviving color or marker.
  const borderCoverage = kind
    ? Math.min(
        ...[
          [0.02, 0.06, 0.02, 0.68],
          [0.94, 0.98, 0.02, 0.68],
          [0.02, 0.98, 0.03, 0.18],
        ].map(([left = 0, right = 0, top = 0, bottom = 0]) => {
          let matching = 0;
          let total = 0;
          const boxWidth = maxX - minX + 1;
          const boxHeight = maxY - minY + 1;
          for (
            let y = minY + Math.ceil(top * boxHeight);
            y < minY + Math.floor(bottom * boxHeight);
            y++
          ) {
            for (
              let x = minX + Math.ceil(left * boxWidth);
              x < minX + Math.floor(right * boxWidth);
              x++
            ) {
              total++;
              if (identity(...pixel(x, y), kind)) matching++;
            }
          }
          return total ? matching / total : 0;
        }),
      )
    : 0;
  const hashRegion = await sharp(path)
    .extract({
      left: Math.round(width * 0.2),
      top: Math.round(height * 0.35),
      width: Math.round(width * 0.6),
      height: Math.round(height * 0.25),
    })
    .removeAlpha()
    .raw()
    .toBuffer();
  const subX0 = Math.round(width * 0.15);
  const subX1 = Math.round(width * 0.85);
  const subY0 = Math.round(height * 0.7);
  const subY1 = Math.round(height * 0.95);
  let subtitlePixels = 0;
  let subMinX = width;
  let subMaxX = 0;
  for (let y = subY0; y < subY1; y++) {
    for (let x = subX0; x < subX1; x++) {
      const [r, g, b] = pixel(x, y);
      if (!white(r, g, b)) continue;
      subtitlePixels++;
      if (x < subMinX) subMinX = x;
      if (x > subMaxX) subMaxX = x;
    }
  }
  const subtitleSpan = subtitlePixels > 0 ? subMaxX - subMinX : 0;
  let marker = -1;
  if (kind) {
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    const y0 = minY + Math.round(boxH * 0.84);
    const y1 = minY + Math.round(boxH * 0.91);
    const scores = Array.from({ length: width }, () => 0);
    for (let y = y0; y <= y1; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (white(...pixel(x, y))) scores[x] = (scores[x] ?? 0) + 1;
      }
    }
    const peak = Math.max(...scores);
    if (peak >= 8) {
      const threshold = peak * 0.5;
      let bestLeft = -1;
      let bestPeak = 0;
      let run = -1;
      for (let x = minX; x <= maxX + 1; x++) {
        const on = x <= maxX && (scores[x] ?? 0) >= threshold;
        if (on && run < 0) run = x;
        if (on || run < 0) continue;
        const runWidth = x - run;
        const runPeak = Math.max(...scores.slice(run, x));
        if (runWidth >= 8 && runWidth <= 60 && runPeak >= bestPeak) {
          bestLeft = run;
          bestPeak = runPeak;
        }
        run = -1;
      }
      if (bestLeft >= 0 && boxW > 0)
        marker = Math.round(((bestLeft - minX) * 640) / boxW / 14 - 60 / 14);
    }
  }
  return {
    width,
    height,
    kind,
    identityPixels: kind ? counts[kind] : 0,
    intact: borderCoverage >= 0.995,
    borderCoverage,
    marker,
    pixelsHash: createHash("sha256").update(hashRegion).digest("hex"),
    subtitlePixels,
    subtitleSpan,
  };
}

export function parseNativeLog(log: string) {
  return {
    vo: /VO: \[libmpv\] 640x360 yuv420p/.test(log),
    ao: /AO: \[pulse\] 48000Hz/.test(log),
    noticeVo: /VO: \[libmpv\] 1280x720 yuv420p/.test(log),
  };
}

export function pcmDbfs(wav: Uint8Array) {
  const buffer = Buffer.from(wav);
  const dataAt = buffer.indexOf(Buffer.from("data"));
  const fmtAt = buffer.indexOf(Buffer.from("fmt "));
  if (dataAt < 0 || fmtAt < 0) return Number.NEGATIVE_INFINITY;
  const format = buffer.readUInt16LE(fmtAt + 8);
  const bits = buffer.readUInt16LE(fmtAt + 22);
  const size = buffer.readUInt32LE(dataAt + 4);
  const start = dataAt + 8;
  let sum = 0;
  let count = 0;
  if (format === 3 || bits === 32) {
    for (let index = start; index + 4 <= start + size; index += 4) {
      const sample = buffer.readFloatLE(index);
      sum += sample * sample;
      count++;
    }
  } else {
    for (let index = start; index + 2 <= start + size; index += 2) {
      const sample = buffer.readInt16LE(index) / 32768;
      sum += sample * sample;
      count++;
    }
  }
  if (count === 0) return Number.NEGATIVE_INFINITY;
  const rms = Math.sqrt(sum / count);
  return rms > 0 ? 20 * Math.log10(rms) : Number.NEGATIVE_INFINITY;
}

export async function inspectAudio(path: string) {
  return pcmDbfs(await readFile(path));
}
