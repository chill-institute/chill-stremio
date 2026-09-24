# Local Engine-backed adapter

For the stateless multi-user service and discovery, use [HOSTED.md](./HOSTED.md).

The adapter serves one selected folder using the existing chill bearer token.
`GetFolder` supplies catalog and metadata; `ResolvePlayback` requests HLS streams
using contracts v2.7.0. Engine returns a verified put.io HLS master URL with a
separate download grant; the account OAuth token never reaches the adapter.
It uses the released generated client and never calls put.io directly.

## Run

Install the pinned tools and dependencies:

```sh
mise trust
mise install
pnpm install --frozen-lockfile
```

Provide `CHILL_TOKEN` through your private process environment using your existing
chill authorization. This is a regular chill bearer, not a put.io token or a
Stremio account password. Do not put it in command arguments, tracked files,
add-on URLs or screenshots. Select a folder with `CHILL_FOLDER_ID` (`0` is root):

```sh
CHILL_FOLDER_ID=0 mise run adapter:serve
```

The process binds `127.0.0.1:7000`; `CHILL_ADAPTER_PORT` can select another
unprivileged port, or `0` for an automatically allocated port. It writes
`.cache/adapter/install.json` with owner-only permissions. Read its
`manifestUrl` privately and enter it in Stremio's add-on installation field.
The folder appears as **put.io library**, with filenames as titles.

The manifest URL contains a random installation capability, never the chill
bearer. Anyone with that URL and network access to this process can browse and
resolve videos from the selected folder. Protect the file and URL. The key exists
only for this process: stopping it revokes the installation, and restarting
requires reinstalling the newly generated URL. There is no installation registry.

Ctrl+C or SIGTERM closes the listener, cancels Engine requests and removes the
installation receipt. After an unclean exit, establish that the process stopped
before deleting the stale receipt. Startup will not overwrite it.

This is a local single-user process, not a publicly hosted multi-user service.
On an SSH devbox, run the process there and forward the same loopback port from
the computer running Stremio:

```sh
ssh -N -L 7000:127.0.0.1:7000 <your-devbox>
```

A synced localhost installation does not make the process reachable on other
devices. Each receiving device needs connectivity to that loopback service.
The adapter does not proxy video; returned media URLs go directly to the player.

## Behavior

Only videos in the selected folder are exposed. Metadata and stream requests
recheck membership; moving a file out of the folder removes its access through
this installation. IDs preserve provider int64 precision. Catalogs paginate in
100-item pages and support search. Folders above 5,000 entries fail explicitly.

Pending and unavailable playback return no source. Authentication, invalid
provider data and connectivity failures return errors, never an empty successful
catalog. Requests have a ten-second total budget, cancel on disconnect and do
not retry automatically. Personalized responses use `Cache-Control: no-store`.

Expiry stays unknown unless Engine supplies a timestamp. Expired URLs are
rejected; source reselection resolves again and may return the same token. Known
MP4/H.264/AAC sources are marked Web-ready; unknown or other formats require a
capable player and are not advertised as Web-ready. The current Engine resolver
returns unknown codecs, so the local browser fixture proof is not proof of every
real provider file. Optional subtitle URLs must be independently usable HTTPS.

## Verify

```sh
mise run verify
mise run adapter:smoke
```

The smoke requires the existing [Web fixture prerequisites](./HARNESS.md) and
setup media, plus `openssl` for a temporary loopback TLS fixture. It installs the
actual adapter in two fresh pinned Stremio Web contexts, uses a generated local
Engine RPC fixture, checks decoded video/audio, and tests pending-source reload.
It verifies cleanup and that the fake Engine bearer never enters
the browser. All credentials and content in this lane are generated fixtures.
Results go to `artifacts/adapter-<timestamp>/results.json`.

Real-account and cross-IP proof remain separate under [LIVE.md](./LIVE.md).
Do not run this process with production credentials as a substitute for that
lane's designated account, shared allowance and capture policy. Native client
support still needs its own proof.

## Authenticated playback probe

This is a maintainer-only lane. Follow [live setup](./LIVE.md#setup), including the designated Stremio
identity and credentials. Once configured, run:

```sh
mise run adapter:live
```

The probe reuses the designated account's private cached chill token after an
Engine profile check. If no valid token exists, it uses normal browser OAuth
and the account's stored two-factor secret; see [session reuse](./LIVE.md#session-reuse).
It signs into Stremio Web, installs the local adapter, browses its
selected folder through production Engine, and attempts direct playback of a
newly uploaded generated clip with a matching English subtitle sidecar. It reserves
three creations and the clip and subtitle bytes before provider mutations, using
the same shared allowance as `live:probe`.
No production token or credential override is used.

Playback proof checks rendered fixture pixels, advancing markers and decoded
frames/audio, and that the media source matches Engine's response. Subtitle proof
requires the fixture track from Engine, the generated English cue fetched from that track,
and rendered captions that disappear with Off and return when reselected. The provider
may label the track undetermined; the probe retains that label and checks cue content. Only
video pixels and subtitle state are inspected in memory. No authenticated screenshots, traces, browser
storage, headers or media URLs are written. The token is persisted only in the
private session cache described above. Sanitized outcomes go to
`artifacts/live-adapter-<timestamp>/results.json`; private provider recovery IDs
use the existing [live recovery journal](./LIVE.md#recovery).

Cleanup removes the exact temporary add-on from a freshly read Stremio account
collection, verifies remote absence and preservation of other descriptors, and
deletes only the provider resources created by the attempt. Keep other clients
from editing this test account's add-ons during the probe; Stremio's collection
write replaces its list. Cleanup failures remain failures even if playback
worked. The probe closes browser and local listeners on completion.

This exercises pinned Web on the devbox. It does not prove native support or
playback from the user's device; those need their own client and network proof.
