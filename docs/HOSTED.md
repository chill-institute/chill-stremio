# Hosted adapter

The hosted process serves the chill.institute Stremio add-on for multiple
accounts without storing anything. chill-web issues each account's add-on link
at `/stremio`. The link carries an Engine-issued credential; the adapter
forwards it to Engine on every call and keeps no database, installation list or
download history. The [local single-user adapter](./ADAPTER.md) remains useful
for isolated probes.

## Run on Linux

Install the pinned tools with `mise trust`, `mise install`, then
`mise run setup`. Setup generates status clips with FFmpeg; the running service
only loads the generated files. No desktop session, key or state directory is
required. [hosted-run.ts](../src/hosted-run.ts) owns the runtime configuration
schema:

```sh
CHILL_PUBLIC_ORIGIN=http://127.0.0.1:7000 mise run hosted:serve
```

The default listener is loopback. Set `CHILL_LISTEN_HOST=0.0.0.0` only behind the
configured HTTPS ingress. `CHILL_PUBLIC_ORIGIN` must be the exact external origin;
the server checks the Host header against it. `CHILL_WEB_ORIGIN` sets the
chill-web origin used for `/configure`, the service root redirect and reconnect
notices. `CHILL_ENGINE_BASE_URL` overrides the Engine API base.

The [Dockerfile](../Dockerfile) builds a non-root Linux image with locked
production dependencies and bakes the release version into the add-on manifest
through `CHILL_ADAPTER_VERSION`, which Stremio clients use to detect updates;
local runs report `0.0.0`. Run it with a read-only root filesystem and no
container capabilities. It needs no volume. SIGTERM cancels open requests and
stops the listener. [Verification and release](#verification-and-release) covers
image publication.

The process does not log request paths, headers, credentials or upstream bodies.
Ingress must also suppress access logs for this service: add-on paths contain
the credential, and returned playback URLs are provider credentials. Disable
request/response capture, analytics and third-party scripts on add-on and
playback surfaces. `GET /health` reports process liveness without contacting
Engine or providers, and still answers when other requests fill the adapter's
[capacity](#capacity).

## Capacity

Each process admits 64 units of work at once: one for each open request and one
for each selection submission until Engine answers it. One add-on link may hold
16 of them. Stremio requests every visible catalog, a title's resources and the
player's resources at once, does not cancel them when the user moves on, and
syncs installed add-ons to every device signed in to the same Stremio account;
16 covers one link browsing, searching and playing on two devices.

A request over the process limit gets `503 {"error":"unavailable"}`. A request
over its link's limit gets `429 {"error":"resource_exhausted"}`, except selected
media under `/play/` and `/status/`, which gets `503 unavailable` because HLS
players retry a 5xx but not a 4xx. Every refusal carries `Retry-After: 5` and
`Access-Control-Allow-Origin: *`. A new selection needs two free units on its
link, one for the request and one for its submission; otherwise it returns that
`503` and submits nothing. The pinned Stremio Web client's hls.js settings
retry a refused manifest and Stremio for Linux's do not, but no client run has
been refused yet; select the source again if playback stops. `GET /health`, HEAD and
OPTIONS never count, and status clips under `/notice/` count only toward the
process limit. Each process keeps its own counts, keyed by a hash of the
credential and dropped when a link's last unit ends.

## Add-on links

A personal add-on link has the form
`https://stremio.chill.institute/s/<credential>/manifest.json`. The credential is
an opaque PASETO `v4.local.` token of up to 1,024 characters. The adapter checks
only its shape; a malformed credential returns `404` without contacting Engine.
Every Engine call for that link sends `X-Chill-Stremio-Credential` and no
`Authorization` header. Engine accepts the credential for `Search`, `GetMovies`,
`GetTVShows`, `GetTVShowDetail`, `GetTVShowSeason`, `GetFolder`,
`ResolvePlayback`, `GetTransfer` and `AddTransfer`.

Keep your add-on link private: anyone who has it can browse your put.io library,
play its videos and start downloads to your account. Stremio shows the full link
in its install dialog, so do not share screenshots of that dialog. Manage add-on links at
`https://chill.institute/stremio`. When Engine rejects a credential
with `401` or `403`, catalogs show a **Reconnect chill.institute** row, stream
lists show a **Reconnect at https://chill.institute/stremio** source that opens
that page, and selected media plays the reconnect status clip, which names that
page. Subtitle requests return no tracks.

## Public add-on listing

`https://stremio.chill.institute/manifest.json` is the public catalog entry.
It requires configuration and contains no account credential. Public and
personal manifests show the setup page logo from `/configure-assets/logo.png`
and list the project contact email, which Stremio's Report action uses.
Stremio's **Configure** action opens `/configure`, a public HTML page with a
**connect your account** link to `https://chill.institute/stremio`.
The page carries over chill-web’s `AuthPage`, `FullscreenCenter` and button
styles and logo, using system fonts. It follows the system light/dark theme.
Assets are served locally from `/configure-assets/`; its Content Security
Policy permits only the hashed stylesheet and same-origin images. It returns
HTTP 200 without scripts or an automatic redirect. The service root and each
personal link's `/configure` redirect to `https://chill.institute/stremio`.
Only personal links reach account data; public catalog and stream requests do
not.

Submit only the public manifest through Stremio's official
[publishing form](https://stremio.github.io/stremio-publish-addon/index.html)
or the SDK's `publishToCentral`. Never submit a personal add-on link.
Submission must return `result.success: true`. Verify the exact public URL in
[the community catalog](https://api.strem.io/addonscollection.json); Stremio
allows up to 24 hours for a submitted add-on to appear. An accepted submission
alone is not proof of catalog visibility.

## Account and playback flow

1. Choose **Configure** on the chill.institute add-on, or open `/stremio` on chill.institute.
2. Connect your account and install the add-on link it shows.
3. Open **Discover → put.io library**, browse movie/series discovery, or search **Releases**.
   Ordinary Stremio movie and episode pages also list chill release results.
4. Select a **Download to put.io** release row. The player requests its media
   URL; the adapter looks the release up again and submits it to Engine.
5. The player waits for the download and starts a ready single video
   automatically. Completed downloads appear in **put.io library**, where you can
   choose any file, including one from a multi-file download.

**put.io library** is the first browsable add-on catalog. Stremio's separate
**Library** tab contains items saved in Stremio, not the connected put.io account.
The catalog lists and searches videos across the whole account, starting at the
put.io root and including subfolders. Library read errors do not affect
discovery or release search.

Library requests traverse folders breadth-first and stop after finding the
requested page or file. Each request rechecks membership and retains the
10-second deadline. Traversal rejects cycles, mismatched parents and duplicate
IDs, with limits of 5,000 entries per folder, 50,000 total entries, 1,000 folders
and 64 levels. Exceeding a limit or an upstream error returns an error rather
than a silently incomplete page. Large or slow libraries may hit these limits.

The add-on has no Downloads or Acquired videos catalog. Engine targets its
configured download folder; when that folder is inside the account, completed
downloads appear in **put.io library**.

## Selected media

Catalog, metadata and stream listings, HEAD, OPTIONS and requests marked with
prefetch hints are read-only. GET on a selected
`/s/<credential>/play/<type>/<id>/<release>.m3u8` URL resolves the release through
Engine `Search` and submits the returned link with `AddTransfer`; Engine chooses
the destination folder. A release missing from that search plays the
`release-unavailable` clip below; a legacy `.mp4` selection returns `404`, or
`503 unavailable` when an indexer reported an error. The adapter omits
`bingeGroup`. These guards do not cryptographically prove a human click for
every Stremio client.

Identical play requests share one submission while any of them is open and for
60 seconds after the last one finishes, so a player reopening or retrying the
selected URL does not submit again. That memory is per process and bounded;
selecting the same release after the window or after a restart adds another
transfer. Under capacity pressure the oldest idle entries may be dropped before
their window ends. A submission does not depend on the requesting client staying
connected. A failed, lost or timed-out submission response is never retried and
reports `unknown`.

After submission the adapter polls `GetTransfer`, finds the downloaded video with
`GetFolder` and resolves it with `ResolvePlayback`. A still-pending download
redirects to `/s/<credential>/status/<transferId>.m3u8?wait=<n>`, where the
transfer ID is decimal. Status URLs only read; reopening one resumes waiting
without submitting. HLS waits in 25-second windows and legacy `.mp4` URLs in
45-second windows, with up to five redirects. Each window starts with the
request and includes submission and status reads, so a still-pending download
redirects before the request deadline. Stremio Web abandons each redirect chain
after 30 seconds and requests the selected URL again, up to ten times, rejoining
the same submission. Once an HLS selection has waited four minutes, or an HLS
status URL reaches its fifth redirect, the adapter redirects to the pending
status clip. Selecting the source again within the reuse window waits another
four minutes on the same submission; later it submits again. Stremio for Linux
follows the redirects itself and reaches the clip at the fifth status redirect,
about 150 seconds in; the reuse window has ended by then, so selecting the
source again submits again. Legacy `.mp4` URLs return `503 download_pending` at
their fifth redirect. Downloads continue independently of the player.

HLS terminal states redirect to a five-second status clip,
`/s/<credential>/notice/<state>.m3u8`, for `failed`, `select-file`,
`unavailable`, `unknown` or `reconnect`. When Search no longer lists the selected
release, or its indexers fail, HLS selection plays `release-unavailable` without
submitting. Legacy `.mp4` URLs redirect to the matching `.mp4` clip. A
multi-file download plays
`select-file`; choose the file from **put.io library**. The adapter does not
guess the first video. Clip routes only check the credential's shape and never
contact Engine.

When a clip ends, the player returns to the stream list. Stremio Web counts a
clip played past 70% as watched, and when an episode's clip ends it can move on
to the next episode's sources. Stremio may also start a clip at the video's
saved progress and skip it. Personalized responses use `Cache-Control: no-store`
and `Referrer-Policy: no-referrer`; request lines longer than 4,096 characters
are rejected.

HLS is the default playback delivery. Engine verifies a put.io master playlist
using a separate download grant; the player fetches media directly from put.io.
The account OAuth token remains in Engine. Missing HLS is unavailable rather than
an automatic conversion request.

Movie discovery and episode detail retain their verified artwork and descriptions.
Release search and detail add movie artwork only when the result's IMDb ID matches
one catalog movie's IMDb link. TV release detail also requires a verified single
episode in that show's season. Unmatched or ambiguous results keep their release
filename and download details. Optional artwork lookup outages use the same
fallback; authentication and invalid-response errors still fail. Artwork
association never replaces the exact release ID used for acquisition. Artwork
presentation still needs client acceptance.

Library videos include Engine's subtitle tracks in their stream and through the
subtitles resource. Playback that starts directly from a selected release carries
no separate subtitle lookup; reopen the video from **put.io library** to get its
tracks.

## Verification and release

The adapter runs at `https://stremio.chill.institute`. Stremio Web and Stremio
for Linux are supported; both manifest descriptions and `/configure` say so and
call other Stremio apps unverified. The earlier Web direct-file
download-to-playback flow passes. HLS audio switching passes a real put.io Web
probe, and the generated hosted HLS flow passes with default audio bundled into
its video variant. The original separate-track fixture retains the
[client-worker regression](./HARNESS.md#hls-playback).
[Android TV](./NATIVE-ANDROID.md) acceptance remains incomplete. Passing a
generic native fixture add-on does not establish hosted support; the
[hosted desktop trial](./NATIVE-DESKTOP.md#hosted-adapter-trial) drives this
adapter in the pinned Linux client. Linux proof does not establish macOS or
Windows support.

```sh
mise run verify
mise run hosted:smoke
docker build -t chill-stremio:release-candidate .
mise run hosted:container
```

The hosted smoke checks the public manifest’s Configure action in the pinned
client. It verifies Stremio’s external-warning destination, serves a generated
warning page, then follows the adapter redirect to setup. The warning fixture
does not establish the current third-party warning page’s appearance.

The hosted smoke uses a generated credential, Engine responses and lawful
fixture media from [hosted-fixture.ts](../harness/hosted-fixture.ts) with the
pinned real Stremio Web client. The fixture Engine requires the credential
header and rejects `Authorization` and `GetUserProfile`. The flow installs the
generated link, masks it in the add-on field, hides it wherever Stremio renders
it and fails if it stays visible, and checks library playback,
standard IMDb movie sources, movie and episode context, pending progress,
automatic playback after completion, status reads across an adapter restart,
the completed file in **put.io library**, rendered seeking and
English/Spanish/off subtitle controls. Its failed, unknown and multi-file
releases each submit once through the real adapter; the player must decode each
HLS status clip without an error and return to the stream list, and the
multi-file result plays its second file from the library. A pending release,
with the limit shortened to 45 seconds, must keep the player waiting through a
manifest timeout and retry, show the pending clip, and play after completion
when selected again, without another transfer. A rejected credential must show
the reconnect row and source, and its selected media must redirect to the
reconnect clip. The receipt is redacted and must not contain the credential;
its recording is safe to share only because the entire lane is fake. Status
clips come from [status-media.ts](../scripts/status-media.ts) at setup/image
build time, as legacy MP4 files and as HLS playlists with one MPEG-TS segment;
[runtime loading](../src/status-media.ts) requires and validates every
generated file.
Require a passing smoke receipt for the in-Stremio interaction. Read each run's
structured result before claiming installation, decoded playback or complete
cleanup.

`mise run hosted:container` runs the built image read-only, without
capabilities or a volume, against a closed loopback Engine port. It checks the
non-root user, health, a generated credential's manifest, a served HLS status
clip, removed routes,
sanitized Engine failures, clean SIGTERM, restart and that container logs never
contain the credential.

Every `feat`, `fix`, `perf`, `refactor`, `revert` or breaking change on `main`
cuts a semantic-release version and GitHub release as `chill-ci`; see the
[release rules](../CONTRIBUTING.md). [Publish hosted adapter](../.github/workflows/publish-hosted.yml) is
a manual, main-only workflow in three jobs. The `build` job has no Environment
and only `contents: read` and `packages: write`: it resolves the latest
published release (or a chosen tag), installs, verifies that exact commit,
builds one image, tests it, pushes it to GHCR as `X.Y.Z`, `X.Y`, `X`, `latest`
and `sha-<commit>`, and outputs the tag, its commit and the pushed digest. The
`publish` job runs in the `publish` Environment with no `GITHUB_TOKEN`
permissions and no checkout, so dependency, verify and test code never runs
next to the `chill-ci` key. It validates the build outputs, mints scoped
`chill-ci` tokens, records the digest on the release, then dispatches the
hosting repository's adapter deploy with that digest and waits for it. The
`canary` job then runs the post-deploy canary at the published commit. The
default verification, fixture and canary workflows retain read-only permissions.

Engine owns the adapter deployment and shared host-mutation lock; its manual
dispatch remains the rollback path. Any v2.0.3 or later image can be a rollback
target because the adapter keeps no state; v2.0.0 to v2.0.2 reject every issued
link because they do not accept Engine's key-ID credential footer.
The Engine deploy workflow reads the package with its own repository token, so
the `chill-stremio` container package must grant `chill-engine` read access in
its Actions access settings; GitHub exposes no API for that grant.

`mise run hosted:public` checks the deployed endpoint with the designated
account's Engine-issued add-on credential, supplied privately as
`CHILL_STREMIO_CREDENTIAL`. It reads the public manifest, the personal manifest,
the whole-library catalog and release results for a standard IMDb movie, and
fails if Engine rejects the credential or either manifest description differs
from this checkout's [copy](../src/manifest-descriptions.ts), so run it at the
deployed commit. It consumes no stream, so it creates no transfer and does not
prove playback. `CHILL_PUBLIC_STREMIO_ORIGIN` overrides the endpoint. Results
go to `artifacts/public-<timestamp>/results.json` without the credential. It
needs only Node, not the installed packages.

The post-deploy canary, [canary.yml](../.github/workflows/canary.yml), runs
`hosted:public` in the `canary` GitHub Environment, which admits only `main` and
holds `CHILL_STREMIO_CREDENTIAL`. Publish calls it at the published commit once
the adapter deploy finishes and passes it the caller's secrets, which a called
job needs to read its own Environment; keep repository and organization secrets
out of this repository, because the canary runs repository code; dispatch it from `main` for an ad hoc check,
optionally with an older `main` commit as `ref`. It refuses commits outside
`main`, checks out without persisted credentials, installs the pinned toolchain
but no dependencies and keeps the redacted receipt as artifact
`hosted-public-<run_id>` for 7 days. A missing secret or any failed step fails
the run. Releases cut before the canary existed start `hosted:public` through
the installed packages, which the canary omits, so republishing one fails its
canary job; dispatch the canary from `main` to check such a rollback.

Mint the credential with the designated account's [environment](./LIVE.md#setup)
and store it in the Environment:

```sh
credential="$(mktemp)"
mise run hosted:credential > "$credential" &&
  gh secret set CHILL_STREMIO_CREDENTIAL --env canary -R chill-institute/chill-stremio < "$credential"
rm -f "$credential"
```

`gh secret set` stores whatever arrives on stdin, even nothing, so the
owner-only temporary file keeps a failed mint from replacing a working secret.
The task signs in through the shared [session cache](./LIVE.md#session-reuse),
asks Engine for a credential for the account's download folder and writes it
only to a pipe or a `0600` file; it refuses a terminal. Engine answers
`409 download_folder_missing` until the account has a download folder. To
rotate, sign in to `https://chill.institute/stremio` as the designated account,
choose **disconnect Stremio** and confirm, which revokes every add-on link of
that account, then mint again. Mint again after any exposure, before Engine
retires the key that signed the credential, and whenever the canary reports
`Engine rejected the credential`.

`mise run hosted:live` separately tests one self-generated clip through real
Engine acquisition. It uses normal OAuth with the designated put.io test
account. A strict loopback proxy stands in for Engine in front of the local
adapter: it accepts only a generated add-on credential, supplies controlled
fixture discovery and forwards AddTransfer, status, folder and playback
resolution to production Engine with the account's bearer. This is hybrid
acquisition proof; it does not prove that production Engine accepts an issued
credential (`hosted:public` does) or that production search found the fixture.
The probe checks that HEAD, status reads and an adapter restart submit nothing,
waits for the transfer, resolves the completed file from the library and never
records authenticated screens or playback URLs. It then installs the add-on
through the pinned Stremio Web UI in a fresh guest browser, opens the completed
file and requires advancing decoded video, intact fixture frames and increasing
decoded AAC bytes. Video pixels remain in memory. The receipt checks browser,
context and Web listener cleanup and absence of the Engine bearer from browser
requests. This uses the same devbox and direct provider HTTPS; it does not
establish playback from another device or network.

The shared live ledger reserves the source upload and copied bytes plus
three creations before any provider mutation. An explicitly approved one-attempt
extension is available through `--approved-extra`; it preserves existing usage
and audit history. Persisted private preflight and result checkpoints support
exact-resource cleanup. Unknown copy outcomes remain pending; never clear them
merely because transfer cancellation succeeded.

`mise run hosted:reuse` sends one unseeded magnet to production Engine five
times with the designated add-on credential, sequentially and concurrently, and
requires every call to return the same put.io transfer; see the
[transfer reuse probe](./LIVE.md#transfer-reuse-probe).

The public endpoint depends on the `infra`-owned DNS record and the Engine-owned
Compose service and deploy workflow. Native desktop and Android TV support
require their own passing receipts; Web results do not establish native support.
