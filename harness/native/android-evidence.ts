import {
  seekMarkerMin,
  seekMarkerMax,
  type FrameEvidence,
} from "./desktop-evidence.ts";

export function inspectAndroidPcm(bytes: Buffer) {
  if (bytes.length < 48000 * 4 || bytes.length % 4 !== 0)
    throw new Error(
      "Expected at least one second of stereo 48 kHz signed 16-bit PCM",
    );
  let squares = 0;
  let crossings = 0;
  let previous = 0;
  const samples = bytes.length / 4;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    const sample = bytes.readInt16LE(offset) / 32768;
    squares += sample * sample;
    if (previous <= 0 && sample > 0) crossings++;
    previous = sample;
  }
  const rms = Math.sqrt(squares / samples);
  return {
    samples,
    durationMs: samples / 48,
    dbfs: rms > 0 ? 20 * Math.log10(rms) : null,
    frequencyHz: crossings / (samples / 48000),
  };
}

export function movieAudioPassed(
  audio: ReturnType<typeof inspectAndroidPcm>,
  silence: ReturnType<typeof inspectAndroidPcm>,
) {
  return (
    (silence.dbfs === null || silence.dbfs < -70) &&
    audio.dbfs !== null &&
    audio.dbfs > -40 &&
    audio.frequencyHz >= 430 &&
    audio.frequencyHz <= 450
  );
}

const sources = [
  "Direct fixture",
  "Pending fixture",
  "Unavailable fixture",
  "Expired fixture",
  "Interrupted fixture",
] as const;
export function focusedFixtureSource(xml: string) {
  const stack: boolean[] = [];
  for (const match of xml.matchAll(/<node\b[^>]*>|<\/node>/g)) {
    const node = match[0];
    if (node === "</node>") {
      stack.pop();
      continue;
    }
    const focused = node.includes('focused="true"') || stack.at(-1) === true;
    const text = node.match(/\btext="([^"]*)"/)?.[1];
    const source = sources.find((source) => source === text);
    if (focused && source) return source;
    if (!node.endsWith("/>")) stack.push(focused);
  }
  return undefined;
}

export function androidSeekPassed(
  before: FrameEvidence,
  after: FrameEvidence,
  elapsedMs: number,
) {
  return (
    before.kind === "movie" &&
    before.intact &&
    before.marker >= 0 &&
    after.kind === "movie" &&
    after.intact &&
    after.marker >= seekMarkerMin &&
    after.marker <= seekMarkerMax &&
    elapsedMs >= 0 &&
    after.marker - before.marker > elapsedMs / 1000 + 2
  );
}

export function androidPausePassed(
  first: FrameEvidence,
  second: FrameEvidence,
  resumed: FrameEvidence,
) {
  return (
    first.kind === "movie" &&
    first.intact &&
    second.kind === "movie" &&
    second.intact &&
    first.marker >= 0 &&
    first.marker === second.marker &&
    first.pixelsHash === second.pixelsHash &&
    resumed.kind === "movie" &&
    resumed.intact &&
    resumed.marker > second.marker &&
    resumed.pixelsHash !== second.pixelsHash
  );
}

export function fixtureSourceLayout(xml: string) {
  return [...xml.matchAll(/<node\b[^>]*>/g)].flatMap(([node]) => {
    const name = sources.find((source) => node.includes(`text="${source}"`));
    const bounds = node.match(
      /bounds="\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]"/,
    );
    if (!name || !bounds) return [];
    return [
      {
        name,
        left: Number(bounds[1]),
        top: Number(bounds[2]),
        right: Number(bounds[3]),
        bottom: Number(bounds[4]),
      },
    ];
  });
}

export function fixtureSourceAxis(
  layout: ReturnType<typeof fixtureSourceLayout>,
) {
  const direct = layout.find((item) => item.name === "Direct fixture");
  const next = layout.find((item) => item.name !== "Direct fixture");
  if (!direct || !next) return undefined;
  const dx = next.left + next.right - direct.left - direct.right;
  const dy = next.top + next.bottom - direct.top - direct.bottom;
  if (Math.abs(dx) > Math.abs(dy))
    return dx > 0
      ? { forward: "KEYCODE_DPAD_RIGHT", reverse: "KEYCODE_DPAD_LEFT" }
      : { forward: "KEYCODE_DPAD_LEFT", reverse: "KEYCODE_DPAD_RIGHT" };
  return dy > 0
    ? { forward: "KEYCODE_DPAD_DOWN", reverse: "KEYCODE_DPAD_UP" }
    : dy < 0
      ? { forward: "KEYCODE_DPAD_UP", reverse: "KEYCODE_DPAD_DOWN" }
      : undefined;
}
