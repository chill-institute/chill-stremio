# Linux desktop

Runs the Stremio for Linux Flatpak (GTK4, WebKitGTK, libmpv) headlessly. Each
trial gets a fresh XDG profile, private D-Bus, Xvfb display and Pulse null sink,
and uses no account credentials.

## Setup

```sh
sudo apt-get install --no-install-recommends --yes flatpak bubblewrap pulseaudio pulseaudio-utils xdotool xclip xvfb xauth dbus ffmpeg fonts-dejavu-core tesseract-ocr
mise run native:desktop:setup
```

- Setup installs the client commit pinned in
  [desktop-versions.ts](../harness/native/desktop-versions.ts) into a private
  installation at `~/.local/share/chill-stremio/flatpak`, plus the signed head
  of its GNOME runtime branch. Pins cover x86_64 and ARM64.
- Flathub signs only each ref's newest builds, so the runtime follows its
  branch and receipts record `versions.runtimeCommit`. When the client pin
  loses its signature, setup fails; pin a newer signed commit only after all
  three modes pass. Never disable GPG verification or the Flatpak sandbox.
- The probe sets `MALLOC_PERTURB_=255` for the owned Flatpak process to avoid
  uninitialized scaler-table padding in the pinned libmpv under software
  rendering. Remove it only after a new client and runtime pass both trials
  without it.

## Modes

Each needs the current [setup stamp](./harness.md#pinned-client) and runs two
fresh trials without retries.

```sh
mise run native:desktop:probe             # client, generic fixture add-on
mise run native:desktop:probe hosted      # the actual hosted adapter
mise run native:desktop:probe hosted-hls  # hosted adapter, HLS media
```

- Fixture: UI installation, delayed readiness, decoded frames, PCM audio, seek,
  subtitles on and off, interrupted-response recovery, next episode.
- Hosted: the adapter from [hosted.ts](../src/hosted.ts) against the
  `hosted:smoke` fake Engine: read-only browsing, one transfer per selection,
  automatic playback, library playback with captions, status clips, the
  reconnect row, and an adapter restart that submits nothing. The transfer
  finishes before libmpv reaches the pending clip, so that clip is untested.
- Hosted HLS: decoded HLS movie and episode with audio and captions; no
  interruption, status clips or audio switching.

Recovery after a cut restarts the owned client and reselects; same-process
reselection can leave the loading cover visible.

Installation needs captured manifest and installed states plus a fixture stream
request; a successful click proves nothing. The add-on dialog prints the
private link, so the guest blacks out the whole URL block before writing any
frame, and the harness rejects retained text containing the credential.
[Installation screenshots](../tests/fixtures/desktop-installation) show the
states it matches.

## Current Linux result

Manual CI on 2026-10-11 (x86_64, client 1.2.0, GNOME runtime 50.5) passed all
three modes in both trials:
[run 38160488734](https://github.com/chill-institute/chill-stremio/actions/runs/38160488734).
Client 1.2.2 passed both hosted modes but failed Next Video in three of four
fixture trials, so the lane stays on 1.2.0. ARM64 has no CI runner; it last
passed fixture and hosted HLS on 2026-09-21/23 on an older runtime.

## Ownership and recovery

- Stop only the Flatpak instance IDs this attempt started; never kill by app
  ID, stop another display or audio server, or reuse a normal profile.
- After a force kill, reconcile the recorded attempt before retrying.
- `mise run cleanup` keeps artifacts and does not uninstall native clients.
- Software rendering does not prove hardware codecs, HDR, passthrough or a real
  desktop session.

## CI

[native-desktop.yml](../.github/workflows/native-desktop.yml) is manual and
read-only on x86_64 Ubuntu. It runs all three modes after one setup, keeps
`linux-desktop-{fixture,hosted,hosted-hls}-<run_id>` artifacts, has no account
secrets and does not gate merges.
