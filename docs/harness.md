# Playback harness

Credential-free Stremio Web lanes on generated media. Setup needs network
access for packages, Chromium and the upstream Web checkout.

## Prerequisites

- FFmpeg with `libx264`, `aac` and `lavfi`, plus DejaVu fonts. Ubuntu:
  `sudo apt-get install --no-install-recommends --yes ffmpeg fonts-dejavu-core`;
  macOS: `brew install ffmpeg`. Playwright's FFmpeg does not count.
- Linux: `pnpm exec playwright install-deps chromium` after installing
  dependencies, or use the browser image.

## Browser image

The Dockerfile's `browser` target bundles Playwright's Chromium, FFmpeg, fonts
and pnpm. Run it as your user with your home at the same path, because the
[live lanes](./live.md#setup) refuse any other `HOME`:

```sh
docker build --target browser -t chill-stremio:browser .
docker run --rm -it --init --ipc=host \
  -u "$(id -u):$(id -g)" -v /etc/passwd:/etc/passwd:ro \
  -e HOME="$HOME" -v "$HOME:$HOME" -w "$PWD" \
  chill-stremio:browser \
  sh -c 'pnpm install --frozen-lockfile && pnpm exec vp run setup'
```

The image has no mise; run lanes as `pnpm exec vp run <task>` and pass secrets
as bare `-e NAME` so values stay off the command line. Use `--shm-size=2g`
where `--ipc=host` is not allowed.

## Pinned client

[versions.ts](../harness/versions.ts) pins the upstream Web revision;
[setup.ts](../harness/setup.ts) builds it under `.cache/stremio-web` and records
hashes of the build and media in `.cache/setup.json`. Every smoke checks that
stamp; a changed build, encoder or fixture fails until setup runs again. A pin
upgrade needs fresh browser evidence; never substitute a mock player.

## Playback proof

The harness installs through the real client UI (no injected storage) and
allows network only to fixture origins. A pass requires decoded frame and AAC
counters, changing rendered time and marker pixels, a seek near 20 seconds,
subtitles on, off and switched, Next Video, recovery from 503/404/410 sources
and from a real connection cut through reselection. Fixtures prove explicit
reselection, not automatic continuation or URL refresh.

## Results and recovery

- Read `artifacts/<timestamp>/results.json` after every attempt; failures may
  add `failure.png`, redacted `page.txt` and `trace.zip`
  (`pnpm exec playwright show-trace <path>`).
- Cleanup errors appear in `cleanupErrors` beside the primary `error`.
- `mise run cleanup` removes generated media and setup stamps, keeps
  `artifacts/` and the Web checkout, and never kills processes by PID or port.
  Run setup again afterwards.
- A changed Web checkout: save any work, remove `.cache/stremio-web`, rerun
  setup.
- After a force kill, finalizers may not have run; inspect owned resources
  before retrying.

## Handoff

Use one writable checkout per task. Report the tested revision, local result
directory and CI run; a task is done only when its required assertions passed.
Report missing runners and unavailable native or live checks separately.

## HLS playback

`mise run hls:smoke` ([hls-smoke.ts](../harness/hls-smoke.ts)) checks decoded
English/Spanish audio switching, seeking and captions on generated HLS. The
default fixture bundles English audio in the video variant.

`mise run hls:smoke separate-fmp4` keeps the separate-track layout, which hits
a pinned-client worker defect (`ReferenceError: e is not defined`): the worker
fallback creates only the video buffer and fails when audio arrives. Bundling
audio avoids it without changing the client or assertions; it is not a fix to
Stremio. The
[checked Web revision](https://github.com/Stremio/stremio-web/commit/afbc05e3d99cb30779d889ee0b1c86b927af3a95)
still has the affected build.
