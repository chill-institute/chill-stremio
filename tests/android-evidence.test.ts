import type { FrameEvidence } from "../harness/native/desktop-evidence.ts";
import { expect, test } from "vite-plus/test";
import {
  focusedFixtureSource,
  fixtureSourceLayout,
  fixtureSourceAxis,
  androidSeekPassed,
  androidPausePassed,
  inspectAndroidPcm,
  movieAudioPassed,
} from "../harness/native/android-evidence.ts";

const pcm = (frequency: number, amplitude = 0.1) => {
  const bytes = Buffer.alloc(48000 * 2 * 4);
  for (let frame = 0; frame < 96000; frame++) {
    const sample = Math.round(
      Math.sin((frame * frequency * 2 * Math.PI) / 48000) * amplitude * 32767,
    );
    bytes.writeInt16LE(sample, frame * 4);
    bytes.writeInt16LE(sample, frame * 4 + 2);
  }
  return bytes;
};

test("Android audio proof requires fixture tone and a silent negative capture", () => {
  const silence = inspectAndroidPcm(pcm(0));
  const movie = inspectAndroidPcm(pcm(440));
  expect(movieAudioPassed(movie, silence)).toBe(true);
  expect(movie.durationMs).toBe(2000);
  expect(movie.frequencyHz).toBeCloseTo(440, 0);
  expect(movieAudioPassed(silence, silence)).toBe(false);
  expect(movieAudioPassed(inspectAndroidPcm(pcm(554)), silence)).toBe(false);
  expect(movieAudioPassed(movie, movie)).toBe(false);
  expect(movieAudioPassed(inspectAndroidPcm(pcm(440, 0.001)), silence)).toBe(
    false,
  );
  expect(() => inspectAndroidPcm(Buffer.alloc(5))).toThrow();
});

test("D-pad focus recognizes source labels within a focused card only", () => {
  expect(
    focusedFixtureSource('<node focused="false" text="Direct fixture" />'),
  ).toBeUndefined();
  expect(
    focusedFixtureSource(
      '<node focused="true" text=""><node focused="false" text="Direct fixture" /></node>',
    ),
  ).toBe("Direct fixture");
  expect(
    focusedFixtureSource(
      '<node focused="true" text=""><node text="private@example.com" /></node><node text="Direct fixture" />',
    ),
  ).toBeUndefined();
  expect(
    focusedFixtureSource(
      '<node focused="false"><node focused="true" text="Pending fixture" /></node>',
    ),
  ).toBe("Pending fixture");
});

const frame = (
  marker: number,
  intact = true,
  pixelsHash = String(marker),
): FrameEvidence => ({
  width: 1280,
  height: 720,
  kind: "movie",
  identityPixels: 30000,
  intact,
  borderCoverage: intact ? 1 : 0.5,
  marker,
  pixelsHash,
  subtitlePixels: 0,
  subtitleSpan: 0,
});

test("seek proof rejects natural playback and damaged destinations", () => {
  expect(androidSeekPassed(frame(10), frame(21), 2000)).toBe(true);
  expect(androidSeekPassed(frame(10), frame(21), 11000)).toBe(false);
  expect(androidSeekPassed(frame(10), frame(21, false), 2000)).toBe(false);
  expect(androidSeekPassed(frame(10, false), frame(21), 2000)).toBe(false);
  expect(androidSeekPassed(frame(-1), frame(21), 2000)).toBe(false);
  expect(androidSeekPassed(frame(10), frame(16), 2000)).toBe(false);
});

test("pause proof requires intact frozen pixels followed by decoded advancement", () => {
  expect(androidPausePassed(frame(21), frame(21), frame(24))).toBe(true);
  expect(androidPausePassed(frame(21, false), frame(21), frame(24))).toBe(
    false,
  );
  expect(androidPausePassed(frame(21), frame(21, false), frame(24))).toBe(
    false,
  );
  expect(
    androidPausePassed(frame(21), frame(21, true, "changed"), frame(24)),
  ).toBe(false);
  expect(androidPausePassed(frame(21), frame(21), frame(21))).toBe(false);
  expect(androidPausePassed(frame(21), frame(21), frame(24, false))).toBe(
    false,
  );
});

test("D-pad axis follows observed fixture card geometry without retaining unrelated labels", () => {
  const direct = '<node text="Direct fixture" bounds="[10,10][100,40]" />';
  expect(
    fixtureSourceAxis(
      fixtureSourceLayout(
        direct + '<node text="Pending fixture" bounds="[110,10][200,40]" />',
      ),
    ),
  ).toEqual({ forward: "KEYCODE_DPAD_RIGHT", reverse: "KEYCODE_DPAD_LEFT" });
  expect(
    fixtureSourceAxis(
      fixtureSourceLayout(
        direct + '<node text="Pending fixture" bounds="[10,50][100,80]" />',
      ),
    ),
  ).toEqual({ forward: "KEYCODE_DPAD_DOWN", reverse: "KEYCODE_DPAD_UP" });
  expect(fixtureSourceAxis(fixtureSourceLayout(direct))).toBeUndefined();
  expect(
    fixtureSourceLayout(
      '<node text="private@example.com" bounds="[10,10][100,40]" />',
    ),
  ).toEqual([]);
});
