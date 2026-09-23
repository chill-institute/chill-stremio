# Fixture playback harness

Run from the repository root with the pinned toolchain in
[mise.toml](../mise.toml). Setup needs network access to fetch the locked package
graph, Chromium and the upstream Web checkout. Playback uses generated lawful
media and no account credentials.

## Prerequisites

Install a full FFmpeg encoder before setup. On Ubuntu:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends --yes ffmpeg fonts-dejavu-core
```

On macOS with Homebrew, use `brew install ffmpeg`. Playwright's bundled FFmpeg
is only a recording helper and does not satisfy this prerequisite.

On Linux, install Chromium system libraries with
`pnpm exec playwright install-deps chromium` after installing repository
dependencies. This may require administrator access; the Ubuntu CI runner
performs this step explicitly. macOS runs headless without a GUI or keychain.

## Setup and run

Follow the [local workflow](../CONTRIBUTING.md#local-workflow). With the pinned
toolchain already installed, run individual package scripts with
`pnpm exec vp run <task>`. Mise setup also installs frozen dependencies; mise
verify also runs `actionlint` and `zizmor .github/workflows`.
Use `pnpm exec vp toolchain --json` to inspect the installed Vite+ toolchain.

`fixture:smoke` runs twice with new Chromium processes, empty browser storage,
and separate fixture and Web listeners on OS-assigned loopback ports.
`verify` checks formatting, lint, types, unit/protocol behavior and workflows;
use `fixture:smoke` for decoded-playback proof.

## Pinned client

[versions.ts](../harness/versions.ts) owns the exact upstream Web revision and
reported library versions. [setup.ts](../harness/setup.ts) fetches that revision,
rejects a changed checkout, installs its frozen lockfile and builds it locally.
The Web checkout remains ignored under `.cache/stremio-web`. A pin upgrade
requires new browser evidence; do not substitute a mock player for the real
client.

Setup records the actual ffmpeg version, exact clean Web revision and SHA256
manifests of built client assets and generated media/subtitles in
`.cache/setup.json`. Every smoke run validates that stamp against the current
files before opening a browser and includes the provenance in its aggregate
result. A changed build, encoder or fixture fails until setup succeeds again.

## Playback proof

The generated 36-second H.264/AAC fixtures are a red movie, green episode 1
and blue episode 2, each with a visible title, time, frame number and moving
one-second marker. English and Spanish WebVTT tracks are selectable. FFmpeg
with `libx264`, `aac` and `lavfi` is required; the harness records the installed
encoder version and hashes rather than assuming cross-platform identical
encodes. Media generation stages complete files before replacing the cache.

The harness clicks Addons → Add addon → URL → Add → Install in the real
client. It injects no local storage or installation state. Stremio's default
anonymous mode needs no account. The pinned client's optional streaming-server
prompt is dismissed through its UI. Network requests are allowed only to the
two fixture origins; default external catalogs can show fetch errors.

Playback proof combines increasing decoded-frame counters, AAC decoded bytes,
the expected direct HTTP origin, distinct screenshot colors, changing rendered
time/frame pixels and the moving marker. The real client omits video
`crossorigin`, so canvas reads are tainted; the harness samples screenshots
without modifying its player. Seeking clicks the real timeline at 55% and
requires a rendered marker near 20 seconds. Subtitles must appear, disappear
when disabled and change language. Next Video must decode the distinct second
episode. Audio decoding does not certify physical speakers or passthrough.

Pending source discovery returns no streams once; the harness observes that
state and reloads once. HTTP 503, 404 and 410 sources exercise client errors,
then recover through selection of the working source. Interrupted media sends
valid initial bytes while the browser establishes decoded video and advancing
AAC evidence, then the harness arms a real connection cut through the fixture
interface. A 35-second fixture deadline bounds failed decoding; standalone
protocol requests still cut after four seconds. Cancellation, reset and fixture
shutdown close pending responses and clear timers. Metrics retain active
response, cut and deadline counts. This scenario runs before
the movie seek test, starting from an unwatched movie. It requires
decoded frames before the cut, then an error or buffer stall and successful
source reselection. Interpret these results as explicit retry and reselection;
fixtures do not exercise automatic continuation or URL refresh. Each run is
bounded to five minutes, with an eleven-minute outer deadline, finite assertion
timeouts and no whole-run automatic retries.

## Results and recovery

Inspect `artifacts/<run timestamp>/results.json` after each smoke attempt.
It records scenario status, actual browser/Node/FFmpeg versions, pinned package versions,
client/media SHA256 manifests, decoded frame evidence and verified resource
cleanup. Runs that reach playback also write `result.json`, `metrics.json`
and scenario screenshots under `run-1/` and `run-2/`. Browser failures attempt
to retain `failure.png`, redacted `page.txt` and a Playwright `trace.zip`. Open
the trace with `pnpm exec playwright show-trace <path-to-trace.zip>`. A failed assertion,
missing prerequisite or failed cleanup produces a nonzero exit code. Cleanup
failures appear in `cleanupErrors`, preserving the primary `error`. Preflight
or browser-startup failures may have only structured results; start with the
aggregate `error` and per-run diagnostics. CI uploads artifacts with seven-day
retention; archive needed evidence before it expires.

```sh
mise run fixture:serve
# Ctrl-C stops the foreground service; smoke scopes close their own resources.
mise run cleanup
```

Cleanup removes generated media and setup stamps. It preserves `artifacts/`
for diagnosis and handoff, and retains the downloaded Web checkout for reuse.
Delete a specific old artifact directory only after its evidence has been
reviewed or archived. Cleanup does not kill arbitrary processes by PID or port.
Smoke also verifies that its listener ports refuse connections and its browser
has closed. Ctrl-C/SIGTERM interrupts scoped work and writes failed structured
results; force-killing the OS process cannot guarantee finalizers or artifacts.
Run setup again after cleanup to regenerate media. Setup subprocesses have
15-minute deadlines and the complete setup has a 25-minute deadline. Failed
commands report their executable and exit code; wrong client revisions report
expected and actual hashes. Resolve a changed client cache by preserving any
needed work, removing `.cache/stremio-web`, and rerunning setup.

## Autonomous handoff

Use one writable checkout per task. Setup and cleanup mutate checkout-local
state; never run either alongside playback or a foreground fixture server in
the same checkout. The runner owns allocating separate workspaces for concurrent
tasks. CI jobs use separate checkouts; browser contexts and loopback listeners
are isolated per run. After a forced process kill, inspect owned resources
before retrying; finalizers and artifact writes may not have completed.

For implementation, start with the requested issue's acceptance criteria, run
the affected verification gate, and run playback when client, media, protocol
or runtime behavior changes. For QA without implementation, report the existing
revision and results without manufacturing a commit. Delivery evidence links
the tested revision, local result directory and corresponding CI run. An issue
is complete only when its required assertions passed; report missing runner
capabilities and unavailable native or live checks separately.

| Failed boundary                                         | Owner and next action                                                                                                   |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Missing Node, pnpm, FFmpeg or Chromium system libraries | Runner: install the pinned toolchain and prerequisites above, then rerun setup.                                         |
| Missing setup stamp or changed media/build hashes       | Checkout: preserve results, rerun setup, then retry smoke once.                                                         |
| Changed pinned Web checkout                             | Checkout: preserve its changes before replacing the cache as described above.                                           |
| Browser assertion or decoded-frame failure              | Adapter harness: inspect the failed scenario, screenshot, page text and trace before a targeted fix.                    |
| Cancellation or cleanup failure                         | Attempt owner: inspect structured cleanup status, stop only its foreground process and retain evidence before retrying. |
| GitHub authentication or artifact submission denied     | Runner/operator: restore the declared delivery access; fixture checks still run without credentials.                    |

## Native and live validation

Never run the Web fixture screenshot capture against authenticated URLs or
private media. Maintainer-only live validation uses the designated test
account, the self-generated fixture movie, and a capture policy that excludes
credentials and sensitive playback URLs. See [LIVE.md](./LIVE.md).

Native desktop and Android TV require separately pinned client builds, an
automatable device or emulator, installation/reset commands and decoded-video,
audio, subtitle and remote-navigation evidence. A Web pass does not establish
native support. Run `mise run native:android:probe` and
`mise run native:desktop:probe` on a compatible Linux runner, and
`mise run native:desktop:probe hosted` for the actual hosted adapter; interpret
those results with [Android TV](./NATIVE-ANDROID.md) and
[desktop](./NATIVE-DESKTOP.md). The
[authenticated Android lane](./NATIVE-ANDROID.md#authenticated-emulator-lane)
owns pairing with the separate Stremio test login. The put.io login is not a
Stremio login and must not be typed into TV. The runner classifies the
pairing/QR wall from allowlisted labels only: no login codes, QR images, UI
XML, or account-linking screenshots.

Live put.io validation is a separate lane: `mise run live:setup` and
`mise run live:probe`. Follow the
[sole-executor allowance contract](./LIVE.md#credential-and-budget)
before running it. With the designated token loaded it uploads the
self-generated fixture movie and captions, decodes playback, checks Range
pause/resume and URL reissue, requires put.io-delivered English cue text when
the account exposes it, and adds a URL transfer of that file. Generic Engine
put.io hooks do not identify that account.

## HLS playback

`mise exec -- node harness/hls-smoke.ts` exercises the pinned Stremio Web UI
with generated HLS media. It measures decoded English/Spanish audio frequencies,
returns to the first track, seeks to a rendered frame and switches captions.
Its files are fake-only and may retain screenshots and recordings.

The default fixture uses MPEG-TS segments with English audio in the video
variant and a separate Spanish rendition. This follows the in-band audio layout
used by the [hls.js public sample](https://test-streams.mux.dev/), while retaining
our generated frames, tones and captions for exact assertions. CI needs no
external media host.

The focused audio/seek/caption run passed on 2026-09-20 in
`artifacts/hls-1789908737717/results.json` and cleaned up fully. The hosted
smoke's current flow is described in [HOSTED.md](./HOSTED.md#verification-and-release).
Native clients need separate proof.

The original separate-track fMP4 fixture remains available:

```sh
mise exec -- node harness/hls-smoke.ts separate-fmp4
```

That valid layout exposes a pinned-client worker defect: `ReferenceError: e is
not defined`. Worker fallback repeats video initialization, creates only the
video buffer, then fails when audio arrives. Changing only the container to
MPEG-TS did not fix it. Bundling the default audio with video avoids the missing
buffer path without changing the client or relaxing playback assertions.
This is a fixture compatibility change, not a fix to Stremio's worker.
Diagnostic trace and cleanup: `artifacts/hosted-2026-09-20T11-53-24.950Z/`.

The [upstream Web revision checked](https://github.com/Stremio/stremio-web/commit/afbc05e3d99cb30779d889ee0b1c86b927af3a95)
retains the affected build configuration. A client build fix would require new
provenance and fresh acceptance.

The [live HLS probe](./LIVE.md#hls-audio-probe) separately proves put.io delivery
and audio switching. Its sanitized receipt does not establish that put.io uses
the same segment layout as this fixture.
