# Android TV

Runs the released x86_64 TV client pinned in
[android-versions.ts](../harness/native/android-versions.ts) in a disposable
emulator. Playback is unproven: both lanes exit `blocked`.

TV has no guest login
([upstream](https://github.com/Stremio/stremio-bugs/issues/2147#issuecomment-3770356898));
it shows a pairing/QR **Link Account** wall. A put.io login is not a Stremio
login and must never be typed into TV. Phone images and Android mobile cannot
certify TV behavior.

## Setup

- Linux x86_64 with `emulator`, `adb`, `sdkmanager` and `avdmanager` on PATH,
  read/write `/dev/kvm`, and a passing `emulator -accel-check`.
- At least 13 GiB free on a disk-backed checkout filesystem, not a `/tmp`
  tmpfs.
- Setup installs the pinned image and verifies the APK. It never accepts
  licenses or changes a mismatched SDK; resolve those with the SDK's owner.

```sh
mise run native:android:setup
mise run native:android:probe
```

The probe boots two fresh AVDs under `.cache/native/android/attempt-*` with
isolated ports and a private ADB server, and refuses to attach to an existing
device or server. It never retries a trial.

## Capture

UI Automator XML is read in memory and deleted from the device; only
allowlisted labels such as `Link Account` survive. Pairing codes, emails, URLs,
raw XML, browser traces, account screenshots and emulator logs from account
runs are never retained.

## Results

`artifacts/android-<timestamp>/results.json` with sanitized `emulator.log`.
`client-window-found` means the app launched, not that anything played.
`loginWall`/`pairingChallenge` mean the account wall was recognized.

## Cleanup

Scopes stop the emulator and the private ADB server, verify ports are closed and
remove only the attempt directory. If the ADB server died, cleanup runs
`adb -H 127.0.0.1 -P <private-port> kill-server` on that port only; it never
touches the default server or another user's emulator. `mise run cleanup` does
not manage native runtimes. No put.io transfers belong in these lanes.

## Authenticated emulator lane

```sh
mise run native:android:account
```

Maintainer-only. Set `STREMIO_TEST_EMAIL`, `STREMIO_EMAIL` and
`STREMIO_PASSWORD` for the designated Stremio account; the emails must match,
and credentials are removed from the child environment before Android or
Chromium start. It loads no put.io or Engine credentials.

It pairs through [link.stremio.com](https://link.stremio.com/) headlessly, adds
a temporary fixture add-on to the account, syncs it to TV and drives playback
with the D-pad. Run it alone: nobody else may edit the account's add-ons.

- Before the account write, an owner-only journal at
  `.cache/native/android/recovery/<id>/receipt.json` records the owned URL and
  baseline descriptor hashes.
- Cleanup rereads the account, removes exactly that URL and verifies the
  baseline remains; only then is it `removal-verified`.
- Reconcile every `prepared` or `uncertain` receipt before any later account
  mutation, rereading the account and removing only the attributed URL.
- `installation: passed-partial-proof` does not change the `blocked` playback
  verdict. Audio, seek and pause remain unproven; never present pairing or a
  media request as TV support.
