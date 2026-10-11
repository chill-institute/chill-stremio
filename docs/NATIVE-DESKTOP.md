# Linux desktop trial

This lane runs the GTK4/WebKitGTK/libmpv Stremio shell directly on a
Linux x86_64 or ARM64 host. Each trial owns a fresh XDG profile, private D-Bus
session, Xvfb display and Pulse null sink. It uses local fixture content
without account credentials. Results are separate from [Web](./HARNESS.md) and
[Android TV](./NATIVE-ANDROID.md).

## Setup

Install `flatpak`, `bubblewrap`, `pulseaudio`, `pulseaudio-utils`, `xdotool`,
`xclip`, `xvfb`, `xauth`, `dbus`, `ffmpeg`, `tesseract-ocr` and fixture fonts
using the devbox package manager. Node and the Web fixture setup remain owned
by [mise](../mise.toml).

On Debian/Ubuntu, install the system prerequisites once:

```sh
sudo apt-get install --no-install-recommends --yes flatpak bubblewrap pulseaudio pulseaudio-utils xdotool xclip xvfb xauth dbus ffmpeg fonts-dejavu-core tesseract-ocr
mise run native:desktop:setup
```

On other distributions, install the equivalent packages before running the same
mise task. Setup checks prerequisites, installs the exact client commit from
[desktop-versions.ts](../harness/native/desktop-versions.ts) and installs or
updates the signed head of its GNOME runtime branch.
The private Flatpak installation is `~/.local/share/chill-stremio/flatpak`; setup
does not change the user's normal app installation. It is repeatable and does
not require a desktop session. Verified client pins cover Linux x86_64 and
ARM64; setup selects the native architecture. Other architectures fail
explicitly until they have their own verified pins.

Flathub serves signatures only for each ref's newest builds. On 2026-10-11 it
signed the four newest `org.gnome.Platform//50` builds, from 19 September to
3 October; the earlier runtime pin from 10 September had lost its signature, so
`flatpak update --commit` failed GPG verification. The runtime rebuilds every
few days, so an exact runtime pin stops being pullable within weeks. Setup
prints the deployed runtime commit and every receipt records it in
`versions.runtimeCommit`. The client rebuilds less often, and Flathub still
signed its six newest builds back to July, so it stays pinned: setup moves the
installed client to the pinned commit and verifies it, and the probe rejects
any other client. When Flathub stops signing the client pin, setup fails with
that reason; pin a newer signed commit only after all three desktop modes pass
with it. Do not disable GPG verification to restore an older commit.

The probe fixes the client locale to `C`, uses Cairo for GTK rendering, software
GL for video and shared-memory WebKit composition, and keeps the client home
inside its disposable profile. With the GL renderer, MPV readiness events arrived
near the end of the 36-second HLS fixture despite playback already advancing.
It sets `MALLOC_PERTURB_=255` only for the owned Flatpak process. This glibc
allocation-initialization workaround avoids uninitialized scaler-table padding
in the pinned libmpv build on this software-rendered host. It preserves the
client binary and scaling settings; it is not an addon or Engine option.
Remove it only after an updated client/runtime passes both fresh trials without
it.

Linux sandbox support is required; do not disable the Flatpak sandbox to make a
launch pass.

## Probe and evidence

Requires the current [setup stamp](./HARNESS.md#pinned-client):

```sh
mise run native:desktop:probe
```

Each invocation runs two fresh trials without whole-run retries. Trial deadlines
are five minutes per trial; the wrapper is bounded to twenty minutes. Results
are retained under `artifacts/desktop-<timestamp>/results.json`.

Installation waits for visible active controls in the pinned 1280×720 UI before
opening the URL dialog, submitting the fixture URL and confirming the manifest.
The textbox is selected and copied to the trial's isolated X11 clipboard;
`xclip` must read the exact expected URL before submission. This uses only the
owned Xvfb display, never the operator's desktop clipboard. Source selection
requires a unique visible, confidently recognized label inside the source list;
row coordinates do not identify a stream. Subtitle OFF selection runs OCR inside
the language panel, then maps the recognized target back to screen coordinates.
Screenshots retain missing targets.

Playback captures move the pointer into the video and wait beyond the pinned
client’s three-second controls timeout. Interrupted recovery rewinds through the
timeline first so saved progress cannot resume the short fixture near its end.
After interruption it returns to the source list, restarts the owned client
with the same profile, and selects Direct again. This proves restart-assisted
recovery. Same-process reselection can leave the pinned client’s loading cover
visible; reloading its Web view did not reliably clear that state.
Subtitle selection briefly pauses playback, then resumes before capture because
pausing keeps the overlay visible. Episode checks dismiss the native next-video
prompt when present and use Stremio’s `Shift+N` shortcut. The final intact-frame
and subtitle pixel checks remain mandatory.

A successful mouse command does not prove installation: the final verdict also
requires captured manifest and completed-installation states plus a fixture
stream request from the native client. Missing or unrecognized UI states fail
within a bounded deadline; their screenshots remain in the trial artifacts.

A pass requires UI installation, delayed-ready recovery, decoded advancing
movie frames, non-silent Pulse PCM, seek near 20 seconds, subtitles on and off,
a real interrupted response with decoded recovery, and next-episode playback.
The movie samples must precede seeking, be separated by at least 1.5 seconds,
and show matching fixture identity, advancing markers and changed frame-region
hashes. A marker jump larger than the capture interval permits is rejected.
The libmpv VO/AO logs support frame and PCM evidence; logs alone cannot pass.
Decoded screenshots must also preserve the generated fixture's solid color
borders. Sparse or dense black grids fail even when identity colors and a
moving marker survive. Delayed readiness begins with an injected empty stream
response, captures its visible state, and reloads through the native context
menu in the same window before selecting the now-visible direct source.

Both trials must also prove fresh state, profile cleanup and closed fixture/Web
listeners. The aggregate requires owned runtime cleanup and no cleanup errors.
Failures remain structured and nonzero; missing proof stays in `remaining`.

## Hosted adapter trial

The fixture probe proves the client; it does not prove the product. The hosted
mode runs the actual hosted adapter from [hosted.ts](../src/hosted.ts) against
the same generated Engine responses and lawful media as `hosted:smoke`
([hosted-fixture.ts](../harness/hosted-fixture.ts)), then drives the native
client through discovery, selection, library playback, failure states and a
rejected credential. It needs the same setup stamp and client pins:

```sh
mise run native:desktop:probe hosted
```

Results are retained under `artifacts/desktop-hosted-<timestamp>/results.json`
with `mode: "hosted"`; fixture receipts keep `mode: "fixture"`. Two fresh trials
run without whole-run retries, nine minutes each, thirty minutes overall.

Each trial generates a fake add-on credential of issued length, serves the
adapter behind an observing loopback proxy as its public origin, and hands the
guest only the add-on link and a loopback control URL. The fixture Engine
requires the credential header. The guest reports checkpoints; the harness
asserts adapter and Engine state at each one. A trial passes only when every
item holds:

- The client confirms the configurable add-on's manifest dialog and lists the
  hosted catalogs. The dialogs print the private add-on link, which wraps across
  several lines and moves the Install button down. The guest locates Install,
  blacks out the whole URL block before any frame in that stage is written, keeps
  redacting after a failed installation, never retains the typed-URL frame and
  clears the isolated clipboard. The harness rejects retained text evidence that
  contains the credential.
- Movie discovery shows the generated title; `Show` opens its detail page and
  the `Download to put.io` row is visible. The episode route shows the series
  title and its release row. Both checkpoints require zero transfers, zero media
  GETs and at least one stream listing: browsing stays read-only.
- Selecting the row consumes the media URL and submits exactly one transfer.
  The player stays loading without a status clip; completing the fixture transfer
  must decode the real movie in that same player without another selection. The
  transfer completes before libmpv would reach the pending clip, so that clip is
  untested here.
- put.io library lists the completed file. The harness replays HEAD and reads the
  transfer's status URL before and after restarting the adapter on the same
  port; the transfer count stays one. The file's detail page plays it with intact
  advancing decoded frames, non-silent Pulse PCM, a resolved Engine playback and
  rendered English captions from the library subtitle resource.
- A paced media response, whose final byte is withheld so it stays open, is cut
  mid-playback and the following reconnects are refused for six seconds.
  Recovery returns to the source list, restarts the owned client with the same
  profile and reselects the file; recovered decoded pixels are required. `playbackContinuedAfterCut` records whether the frame
  captured after the cut still showed decoded video.
- Failed, unknown and multi-file releases each submit once. The client loads
  the matching HLS status clip's playlist and segment, libmpv logs a 1280×720
  video output, the guest reads `Download` and `failed`, `unknown` or `ready` in
  the clip's headline band on a frame without fixture video, and the source list
  returns when the clip ends. Reading the failed and multi-file status URLs
  redirects to the same clip and does not submit. The chosen second file of the
  multi-file download decodes as the episode fixture from the library.
- After the fixture Engine starts rejecting the credential with `401`, the
  client's put.io library shows the reconnect row.
- The generated Engine saw exactly four transfers and rejected no requests.

Fresh state, owned instance cleanup, closed listeners and the shared cleanup
gates apply as in the fixture lane. The generated media proxy serves HTTPS with
a disposable self-signed certificate because the adapter only accepts secure
playback URLs. Each hosted profile copies the runtime's existing trust anchors
and p11-kit trust module, and adds that certificate. A process-scoped
`FLATPAK_BWRAP` wrapper mounts both read-only inside the app sandbox, allowing
WebKit to fetch captions and artwork. The module matters on hosts with
`p11-kit`: there Flatpak's session helper replaces the runtime trust module
with a client of the host trust store, which ignores the fixture anchors. The
client, TLS verification, Flatpak isolation and host trust remain unchanged.
Profile cleanup removes the certificate, module copy and wrapper.

## Focused hosted HLS trial

`mise run native:desktop:probe hosted-hls` runs the generated hosted adapter
with HLS movie and episode sources. It retains intact decoded-frame, PCM audio,
library caption, one-transfer, reconnect and cleanup assertions. It does not
establish interrupted-media recovery, terminal-state presentation or native
audio switching; the full `hosted` mode covers the first two.

## Current Linux result

On 2026-10-11, manual CI on GitHub's x86_64 `ubuntu-26.04` runner used client
1.2.0 (`7580e7db…`) and GNOME runtime 50.5 (`0bd50910…`).
[Run 38160488734](https://github.com/chill-institute/chill-stremio/actions/runs/38160488734)
passed all three modes in both fresh trials, as did
[run 38156337283](https://github.com/chill-institute/chill-stremio/actions/runs/38156337283)
before the clip check also required the `Download` headline word:

- Fixture mode: decoded advancing video, PCM audio, seeking, subtitles on/off,
  next episode, delayed readiness, restart-assisted interruption recovery and
  cleanup.
- Hosted mode: discovery, automatic playback, library playback with captions
  and PCM audio, the paced cut with restart-assisted recovery, the failed,
  unknown and multi-file status clips decoded in libmpv with a return to the
  source list, exact-file playback, the reconnect row, four transfers and
  cleanup.
- Hosted HLS mode.

Before status clips, client 1.2.0 stayed on its loading screen when those
selections answered `409`.
[Run 38141014977](https://github.com/chill-institute/chill-stremio/actions/runs/38141014977)
was blocked in three trials because a client launch logged
`Failed to open display`; a later launch in the same trial reached the Xvfb
display.

Client 1.2.2 (`0496ce1d…`), Flathub's current build, passed both hosted modes in
[run 38136421172](https://github.com/chill-institute/chill-stremio/actions/runs/38136421172)
and
[run 38138963135](https://github.com/chill-institute/chill-stremio/actions/runs/38138963135),
before status clips. In three of those runs' four fixture trials, however, Next
Video never loaded the next episode into libmpv. The lane stays on 1.2.0 until
one client passes all three modes.

In every hosted trial the frame captured after the paced cut still decoded
(`playbackContinuedAfterCut`); the recovery evidence is the restart-assisted
reselection, not a visible mid-stream failure. Hosted mode recorded one play
request for the movie selection and two for each terminal selection, which
loads its clip playlist twice; the adapter's reuse window kept each selection
to one transfer.

ARM64 has no CI runner. Its client pin `3795122e…` (1.2.0) is still signed on
Flathub. Both fresh ARM64 fixture trials passed on 2026-09-21 and both hosted
HLS trials on 2026-09-23, with runtime `2b6d25cb…`; neither has been repeated
on the current runtime, and live-account playback on ARM64 remains untested.

Linux is the current desktop release target; macOS and Windows need separate
compatibility evidence.

## Ownership and recovery

Only the Flatpak instance IDs returned for this attempt may be stopped. Never
kill by application ID, stop another display/audio server, or reuse a normal
Stremio profile. `--die-with-parent` bounds sandbox lifetime when its launcher
exits. The wrapper retains evidence and removes only its own temporary run
directory. Primary and cleanup errors remain separate.
After terminating an owned Flatpak instance, the guest waits up to ten seconds
for that exact instance to disappear; delayed registry removal is not a reason
to signal other instances.

After forced termination, reconcile the recorded attempt's resources before
retrying. Keep setup, playback and shared fixture cleanup exclusive within one
checkout. `mise run cleanup` preserves artifacts and does not uninstall native
clients.

Software rendering, Xvfb and a Pulse null sink do not prove hardware codecs,
HDR, passthrough, physical speakers or a real desktop session. Native account
pairing and live put.io playback require separate evidence.

## CI

[Linux desktop playback](../.github/workflows/native-desktop.yml) is a manual,
read-only GitHub Actions lane on x86_64 Ubuntu. After one setup it runs the
fixture, `hosted` and `hosted-hls` modes in that order; each later mode still
runs when an earlier one is blocked. Each mode keeps its own artifact,
`linux-desktop-fixture-<run_id>`, `linux-desktop-hosted-<run_id>` and
`linux-desktop-hosted-hls-<run_id>`, even when playback is blocked. It has no
account secrets and is not a required merge gate. A workflow pass still
requires every playback and cleanup assertion in all three modes; setup
success alone is insufficient.
