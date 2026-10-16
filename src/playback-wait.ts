import { setTimeout as sleep } from "node:timers/promises";
import type { StatusMediaKind } from "./status-media.ts";

export type PlaybackResult = { url: string } | { status: StatusMediaKind };

// Stay below mpv's 60s network timeout and FFmpeg's eight-redirect limit.
export const playbackWait = {
  windowMs: 45_000,
  hlsWindowMs: 25_000,
  pollMs: 2_000,
  // put.io takes minutes to convert a video, and each read while it queues
  // the conversion asks for it again.
  ownedPollMs: 5_000,
  continuations: 5,
};

export async function waitForPlayback(
  initial: PlaybackResult,
  inspect: () => Promise<PlaybackResult>,
  signal: AbortSignal,
  timing: { windowMs: number; pollMs: number } = playbackWait,
) {
  const deadline = performance.now() + timing.windowMs;
  let result = initial;
  while ("status" in result && result.status === "pending") {
    signal.throwIfAborted();
    const remaining = deadline - performance.now();
    if (remaining <= 0) break;
    await sleep(Math.min(timing.pollMs, remaining), undefined, { signal });
    result = await inspect();
  }
  return result;
}
