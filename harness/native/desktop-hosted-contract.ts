import { desktopRunPassed, type DesktopRunProof } from "./desktop-contract.ts";

/** Scenarios every hosted desktop trial must pass; the guest and harness both contribute. */
export const hostedRequired = [
  "software-decoding",
  "ui-installation",
  "movie-discovery",
  "release-detail",
  "episode-context",
  "selected-download",
  "download-subtitles",
  "downloads-progress",
  "acquired-playback",
  "audio-pcm",
  "interrupted-playback-recovery",
  "recovery-failed",
  "recovery-unknown",
  "recovery-select-file",
  "exact-file-playback",
  "revocation-denied",
  "durable-claims",
] as const;

export interface HostedRunProof extends DesktopRunProof {
  hosted?: {
    engineCalls: { transfer: number; rejected: number };
    proxy: { manifest: number; stream: number; deniedAfterRevocation: number };
    media: { cuts: number };
    adapterRestarts: number;
  };
}

export function hostedRunPassed(run: HostedRunProof) {
  return (
    desktopRunPassed(run) &&
    run.hosted !== undefined &&
    run.hosted.engineCalls.transfer === 4 &&
    run.hosted.engineCalls.rejected === 0 &&
    run.hosted.proxy.manifest >= 1 &&
    run.hosted.proxy.stream >= 1 &&
    run.hosted.proxy.deniedAfterRevocation >= 1 &&
    run.hosted.media.cuts >= 1 &&
    run.hosted.adapterRestarts === 2
  );
}

/** Focused HLS trial does not establish interruption or terminal recovery support. */
export const hostedHlsRequired = hostedRequired.filter(
  (name) =>
    ![
      "interrupted-playback-recovery",
      "recovery-failed",
      "recovery-unknown",
      "recovery-select-file",
      "exact-file-playback",
    ].includes(name),
);

export function hostedHlsRunPassed(run: HostedRunProof) {
  return (
    desktopRunPassed(run) &&
    run.hosted !== undefined &&
    run.hosted.engineCalls.transfer === 1 &&
    run.hosted.engineCalls.rejected === 0 &&
    run.hosted.proxy.manifest >= 1 &&
    run.hosted.proxy.stream >= 1 &&
    run.hosted.proxy.deniedAfterRevocation >= 1 &&
    run.hosted.adapterRestarts === 1
  );
}
