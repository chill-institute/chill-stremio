# Local adapter

A single-user adapter that serves one put.io folder through Engine with your
chill bearer. For the multi-user service, see [hosted](./hosted.md).

## Run

```sh
CHILL_FOLDER_ID=0 mise run adapter:serve
```

- Supply `CHILL_TOKEN`, a chill bearer (not a put.io token), in the private
  environment; never in arguments, files, URLs or screenshots.
- It binds `127.0.0.1:7000` (`CHILL_ADAPTER_PORT`, `0` for any) and writes
  `.cache/adapter/install.json` (owner-only). Install its `manifestUrl` in
  Stremio; never print it.
- The URL holds a per-process capability, not the bearer; anyone who can reach
  the process with it can browse and play the folder. Restarting revokes it.
- SIGTERM removes the receipt. After an unclean exit, confirm the process
  stopped before deleting a stale receipt; startup won't overwrite it.
- Remote host: `ssh -N -L 7000:127.0.0.1:7000 <remote-host>`. Each device needs
  its own route to the loopback port; media goes directly to the player.
- Folders over 5,000 entries fail. Pending or unavailable files return no
  source.

## Verify

```sh
mise run adapter:smoke
```

Needs the [harness prerequisites](./harness.md#prerequisites) and `openssl`.
It installs the adapter in two fresh pinned Web contexts against a generated
Engine and checks decoded playback, pending reload, cleanup and that the fake
bearer never reaches the browser. Never run the adapter with production
credentials as a substitute for the live lanes.

## Authenticated playback probe

```sh
mise run adapter:live
```

Maintainer-only; needs [live setup](./live.md#setup) and shares the
[allowance](./live.md#credential-and-budget) and
[session cache](./live.md#session-reuse). It signs into Stremio Web, installs
the local adapter, uploads a generated clip with an English sidecar and checks
decoded pixels, audio and captions. It writes no authenticated screenshots,
traces, storage, headers or media URLs.

Cleanup removes only its own add-on from a freshly read account collection and
verifies the rest remain. Keep other clients from editing the account's add-ons
during the run: Stremio's collection write replaces the list. Cleanup failures
fail the run.
