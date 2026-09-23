# Android TV runtime and account boundary

Use the released x86_64 TV client pinned in
[android-versions.ts](../harness/native/android-versions.ts). This lane runs on
a Linux x86_64 host with an Android SDK and working KVM. The
[upstream TV maintainer](https://github.com/Stremio/stremio-bugs/issues/2147#issuecomment-3770356898)
confirms that TV has no guest login. TV presents a pairing/QR **Link
Account** wall. A put.io login is not a Stremio account and must never be
injected into TV. Android mobile guest mode is a different client and cannot
certify TV behavior. Do not copy credentials into this checkout.

## Privacy-safe capture

The probe dumps UI Automator XML only in memory, then deletes it from the
device. It keeps allowlisted static labels such as `Link Account` and
`Sync Addons`. It drops pairing codes, emails, URLs, raw XML, and never
screenshots the login wall. Completing pairing requires a Stremio test account
on a second surface. The maintainer-only lane uses a separate test login;
this probe does not consume it or automate pairing. The opt-in authenticated
command below owns pairing. Never load those credentials into the Web fixture
lane.

## Setup

Provide `emulator`, `adb`, `sdkmanager` and `avdmanager` on PATH using the
standard Android SDK. The probe discovers its SDK from the emulator executable;
it has no devbox-specific path or username. The emulator, TV system image and
APK pins live in [android-versions.ts](../harness/native/android-versions.ts).
Other host architectures fail explicitly. A Google APIs phone image cannot
certify TV behavior.

The checkout filesystem needs at least 13 GiB free for the pinned image's
userdata partition. A small `/tmp` tmpfs cannot hold the disposable AVD; use
an isolated checkout on a disk-backed filesystem. The runner checks free space
before creating the AVD.

The executing user needs read/write access to `/dev/kvm`, and
`emulator -accel-check` must succeed. A CI runner needs usable nested
virtualization; software graphics does not replace CPU acceleration.
Setup installs the missing pinned TV image into that SDK with `sdkmanager`,
then downloads and verifies the official APK. It does not accept licenses for
the user or update a mismatched existing image/emulator. Resolve licenses and
SDK ownership through the SDK owner; do not mutate another identity's SDK.

```sh
mise run native:android:setup
mise run native:android:probe
```

The TypeScript probe verifies image properties and the APK hash, then creates
two new AVDs under `.cache/native/android/attempt-*`. Each uses a 720p TV profile,
two CPU cores, 4 GiB RAM, software graphics with Vulkan disabled, no window, no
snapshot and no host audio. Emulator homes, temporary files, console/ADB ports
and private ADB servers are isolated per attempt. The probe checks available
ports and refuses to attach to an existing device or server.

ADB clients use explicit loopback host mode, which refuses to start a replacement
daemon if their scoped server dies. Android boot has a five-minute deadline;
commands have shorter deadlines, each trial is bounded to eight minutes and
the complete invocation to seventeen minutes. After Android reports boot
completion, the runner allows 45 seconds for a read-only Package Manager query
to resolve the built-in Android package before installing the APK. Results retain
`packageManagerReady`, query count and failing command exit code. It never
restarts a whole trial in response to failure.

## Interpret the result

Results are written to `artifacts/android-<timestamp>/results.json`, with a
per-run `result.json` and sanitized `emulator.log`. `client-window-found` means
Android booted, the APK installed, and UI Automator reported the app package.
It does not establish decoded playback. Authenticated APK failures retain only
an allowlisted package-manager or transport `failureCode`; empty output,
missing failure details, disconnected transport, unavailable package service,
locked user and package-manager exceptions have separate static categories.
Unknown output becomes `unclassified-install-failure`. Unauthenticated attempts also retain sanitized
pre-login command diagnostics. Authenticated account installation stages
distinguish collection read, write, readback and verification without retaining
provider data. `loginWall` / `pairingChallenge`
mean the pairing/QR account wall was classified from allowlisted labels.
`uiText` contains only those labels; links, login codes, raw UI XML and
screenshots of account-linking screens are not retained.

The unauthenticated probe stops at account linking, reports `blocked` and exits
nonzero. Use the [authenticated emulator lane](#authenticated-emulator-lane) to
pair the designated Stremio account. Extending playback requires the
[fixture assertions](./HARNESS.md#playback-proof); account linking alone does not
satisfy them. Keep account screens out of fixture recordings.

## Cleanup and recovery

The probe owns foreground process handles. Its scopes stop the emulator and
private ADB server, verify that all allocated ports refuse connections, and
remove only that attempt's directory. Cleanup errors remain separate from the
primary failure. On cancellation it retains failed structured results. APK
cache and artifacts survive teardown; `mise run cleanup` handles shared Web
fixtures and does not manage native runtimes.

If a private ADB server dies, cleanup still runs
`adb -H 127.0.0.1 -P <private-port> kill-server` against only that port before
verifying that the allocated console and ADB ports refuse connections. It never
touches the default ADB server or another user's emulator.

If boot fails, inspect the stage and emulator log. A successful acceleration
check alone does not prove boot. After a forced host
process kill, inspect only the recorded attempt's resources before retrying.

Emulator proof cannot establish hardware codecs, HDR, audio passthrough,
casting, physical speakers or real remote-control behavior. Those require
separate device evidence. No put.io transfers belong in this lane.

## Authenticated emulator lane

`mise run native:android:account` uses the same pinned, disposable emulator,
with two fresh attempts and the existing finite boot/trial deadlines. It completes
[official account linking](https://link.stremio.com/) in a headless browser; no
physical TV, phone or operator browser is required. Run exclusively: no other
runner or human may modify the designated account's addons during the attempt.

This is a maintainer-only lane. Provision the designated Stremio test account,
load the environment described below, then run:

```sh
mise run native:android:account
```

Set `STREMIO_TEST_EMAIL` to the designated test identity and supply its
`STREMIO_EMAIL` and `STREMIO_PASSWORD`. The command requires both email values
to match and removes the login credentials from the child-process environment
before starting Android or Chromium. It does not load put.io or Engine
credentials, upload media, or start transfers.

The official linking confirmation and disappearance of the TV login wall are
separate assertions. A temporary fixture addon is added to a fresh account
collection, then synced by restarting the TV client. Its random loopback port
is reversed only into the owned emulator. Playback uses the documented TV
[detail intent](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/deep-links.md)
and selects the generated direct source through D-pad focus and Select.
The probe checks focus moves to another source and back before selection, then
uses Back to return to sources after playback. Cleanup rereads the account
collection, removes exactly that attempt's transport URL, and verifies
unrelated descriptors remain. A failed or uncertain install still runs that cleanup.

Pairing codes, credentials, raw UI XML, browser traces, account screenshots and
emulator logs are never retained. UI XML and fixture frames are inspected only
in memory. Evidence under `artifacts/android-account-<timestamp>/results.json`
contains per-run static stages, booleans, allowlisted labels, source/media
SHA256 hashes, frame measurements and PCM measurements; the companion Android
artifact records emulator/ADB cleanup. `installation: passed-partial-proof`
requires linking, exact descriptor readback, a fixture-origin TV stream request
and account/browser/fixture cleanup; check the companion emulator cleanup too.
It does not change the blocked playback verdict. Intact fixture borders,
changing frame hashes and an advancing decoded marker are required together
for picture proof.

Authenticated attempts route emulator output exclusively into a private Pulse
null sink, without host speakers or microphone input. The only loaded audio
modules provide that sink and its private Unix socket; teardown verifies the
socket is closed and removes its private directory. A silent pre-playback
capture is the negative control for a two-second 48 kHz stereo PCM sample.
Movie audio requires more than -40 dBFS and the generated 440 Hz tone. PCM
and UI images stay in memory. The harness requests media volume 10 on its owned
emulator; evidence retains the actual numeric readback and private Pulse
active-input counts.
Emulator audio errors are reduced to static backend categories without retaining
the log. A working host capture path does not establish emulator audio output.
Seek uses paused D-pad navigation, retains decoded origin and destination, and
requires a jump beyond natural elapsed time into the 18–23 second target.
Back dismisses the player HUD before measuring seek and paused frames.
Pause/resume requires unchanged intact pixels followed by decoded advancement;
subtitles, next episode, delayed readiness and interruption recovery remain
separate required assertions. Until implemented and verified, the lane remains
`blocked` and exits nonzero.
Do not present a pairing or HTTP-media-request pass as full TV support.

Pairing, exact fixture installation, intact advancing pictures and D-pad source
navigation have been demonstrated together in one fresh pinned-emulator trial.
The other fresh boot in that aggregate failed APK installation before account
access. A subsequent aggregate verified installation, then failed opening fixture
details before playback. Its uncertain cleanup skipped the next trial; API-only
journal reconciliation later verified the exact addon absent and baseline hashes
preserved without another mutation. Audio and the revised seek/pause sequence
still require proof, including confirming the HUD is present before Back dismisses
it. Earlier marker-only results cannot satisfy current intact-picture gates.
The next acceptance run must first establish repeatable startup and fixture
installation, then decoded playback and TV controls. Hosted acceptance separately
requires discovery, selected downloads, progress and acquired-file playback
through the actual adapter. A generic fixture-addon pass cannot replace it.

## Account mutation recovery

The probe stops its owned TV package before collection installation and again
before cleanup, so its own client cannot concurrently sync addon changes.
Before the account write, it creates an owner-only journal under
`.cache/native/android/recovery/<id>/receipt.json`. Its directory is `0700` and
receipt `0600`. The receipt contains the exact owned fake loopback URL and
hashes of baseline descriptors; it contains no authentication material or
unrelated addon URLs. The sanitized run result retains only the journal ID.

The receipt and parent directories are synced before the provider write.
Reconcile every unresolved `prepared` or `uncertain` receipt before any future
account mutation, including a new command invocation.

Cleanup marks `removal-verified` only after rereading the account, confirming
the exact URL is absent and all baseline descriptor hashes remain. An uncertain
cleanup retains its journal and prevents later account trials. Later trials also
stop when installation was not verified; a recorded error list alone cannot
establish resource cleanup. Recovery must reread the designated account before removing only that positively attributed
URL; a generic fixture name cannot establish ownership. Preserve the receipt
with its verified terminal state. Installation diagnostics distinguish malformed
descriptors, a missing owned URL, manifest/flags mismatch and changed baseline
through booleans/counts, without retaining account payloads.
