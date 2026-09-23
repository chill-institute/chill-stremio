# Hosted adapter

The hosted process serves durable, revocable installations for multiple chill
accounts. One-time account setup lives in chill-web at `/stremio`;
the adapter uses the ordinary chill bearer and existing generic Engine RPCs.
The [local single-user adapter](./ADAPTER.md) remains useful for isolated probes.

## Run on Linux

Install the pinned tools with `mise trust`, `mise install`, then
`mise run setup`. Setup generates status clips with FFmpeg; the running service
only loads the generated files. No desktop session is required by the service.
Provide a dedicated installation encryption key through the private process
environment. The key must remain stable across restarts and be backed up through
the owning secret store; generating a new key makes existing installations
unreadable. Never reuse an Engine or provider key.

[hosted-run.ts](../src/hosted-run.ts) owns the runtime configuration schema.
Set `CHILL_INSTALLATION_KEY_HEX` privately, then run:

```sh
CHILL_PUBLIC_ORIGIN=http://127.0.0.1:7000 mise run hosted:serve
```

The default listener is loopback. Set `CHILL_LISTEN_HOST=0.0.0.0` only behind the
configured HTTPS ingress. `CHILL_PUBLIC_ORIGIN` must be the exact external origin;
the server checks the Host header against it. `CHILL_WEB_ORIGIN` controls the
management API's browser origin. Use `VITE_PUBLIC_STREMIO_BASE_URL` in chill-web to point
a local UI at a local adapter.

The state directory must be owned by the runtime user with mode 0700, and the
SQLite file must be 0600. Symlinked database files and permissive storage fail
closed. Run one service instance against a local persistent filesystem; do not
share SQLite over network storage. SIGTERM cancels requests and closes storage.
The [Dockerfile](../Dockerfile) builds a non-root Linux image with locked
production dependencies and bakes the release version into the add-on
manifest through `CHILL_ADAPTER_VERSION`, which Stremio clients use to detect
updates; local runs report `0.0.0`. Bind a private persistent directory at
`/data`, use a read-only root filesystem and drop container capabilities.
[Verification and release](#verification-and-release) covers image publication.

The process does not log request paths, headers, tokens or upstream bodies.
Ingress must also suppress access logs for this service: installation paths and
returned playback URLs are credentials. Disable request/response capture,
analytics and third-party scripts on installation and playback surfaces.
`GET /health` reports process liveness without contacting Engine or providers.

## Public add-on listing

`https://stremio.chill.institute/manifest.json` is the public catalog entry.
It requires configuration and contains no account credential. Stremio's
**Configure** action opens `/configure`, a public HTML page with a
**connect your account** link to `https://chill.institute/stremio`.
The page carries over chill-web’s `AuthPage`, `FullscreenCenter` and button
styles and logo, using system fonts. It follows the system light/dark theme.
Assets are served locally from `/configure-assets/`; its Content Security
Policy permits only the hashed stylesheet and same-origin images. It returns
HTTP 200 without scripts or an automatic redirect. The service root redirects
to account setup.
After connection, **install chill** installs the account-specific manifest.
Only those private installation URLs authorize library and download access;
public catalog, stream and management requests do not bypass authentication.

Submit only the public manifest through Stremio's official
[publishing form](https://stremio.github.io/stremio-publish-addon/index.html)
or the SDK's `publishToCentral`. Never submit a personal installation URL.
Submission must return `result.success: true`. Verify the exact public URL in
[the community catalog](https://api.strem.io/addonscollection.json); Stremio
allows up to 24 hours for a submitted add-on to appear. An accepted submission
alone is not proof of catalog visibility.

## Account and playback flow

1. Choose **Configure** on the chill.institute add-on, or open `/stremio` on chill.institute.
2. Connect your account. Copy its manifest URL
   into Stremio, or use the install action. The URL remains stable after restart.
3. Open **Discover → put.io library**, browse movie/series discovery, or search **Releases**.
   Ordinary Stremio movie and episode pages also list chill release results.
4. Select a **Download to put.io** release row in Stremio. The player consumes
   its media URL; the adapter commits a durable claim and submits it to Engine.
5. The player waits for a pending download and starts a ready single video
   automatically. Unknown, failed or multi-file results show a status clip.
   **Downloads** shows progress; **Acquired videos** lets you choose completed files.

**put.io library** is the first browsable addon catalog. Stremio's separate
**Library** tab contains items saved in Stremio, not the connected put.io account.
The addon catalog lists and searches videos across the connected account, including
subfolders. New connections start at the put.io root without a folder picker.
Connecting verifies the account but does not list its files; library read errors
must not prevent installation, discovery or release search.
Existing root connections gain nested videos automatically. Older connections
scoped to a non-root folder retain their original direct-folder scope; revoke
and reconnect to include the whole library. Download destinations are unchanged.

Library requests traverse folders breadth-first and stop after finding the
requested page or file. Each request rechecks membership and retains the
10-second deadline. Traversal rejects cycles, mismatched parents and duplicate
IDs, with limits of 5,000 entries per folder, 50,000 total entries, 1,000 folders
and 64 levels. Exceeding a limit or an upstream error returns an error rather
than a silently incomplete page. Large or slow libraries may hit these limits.

HLS is the default playback delivery. Engine verifies a put.io master playlist
using a separate download grant; the player fetches media directly from put.io.
The account OAuth token remains in Engine. Missing HLS is unavailable rather than
an automatic conversion request.

Pending HLS playback waits in 25-second windows, with up to five redirects.
Legacy `.mp4` URLs retain 45-second windows. Client manifest timeouts can end
waiting sooner. At the server limit it returns `503 download_pending`; select
the source again to resume waiting. Downloads continue independently of the player.
Resume or repeated consumption of the original selected URL reuses the same claim
rather than resubmitting it. HLS terminal states return `409` with their error
code. Legacy status clips remain available; neither path retries downloads.

Movie discovery and episode detail retain their verified artwork and descriptions.
Release search and detail add movie artwork only when the result's IMDb ID matches
one catalog movie's IMDb link. TV release detail also requires a verified single
episode in that show's season. Unmatched or ambiguous results keep their release
filename and download details. Optional artwork lookup outages use the same
fallback; authentication and invalid-response errors still fail. Artwork
association never replaces the exact release ID used for acquisition. Artwork
presentation still needs client acceptance.

Engine uses its configured download destination, which can differ from the
installation's library folder. Acquired playback verifies the operation's exact
transfer result and traverses only that result's folders; it does not guess the
first video or search unrelated folders. Membership is rechecked before playback.
**Downloads** shows the ten newest operation statuses, including unknown outcomes.
**Acquired videos** shows up to 100 videos from the ten newest submitted operations.
Deleted historical transfers are omitted; authentication, timeouts and provider
failures remain errors.

The installation capability delegates library/discovery access, playback and
chosen-release downloads to the linked put.io account. Keep its URL private:
anyone who has it can exercise those permissions. Managing installations requires
the owner's ordinary chill bearer, verified through `GetUserProfile`. Revocation
denies subsequent adapter requests; it cannot cancel transfers already started or
retract provider playback URLs already issued. The stored chill token is encrypted
with the capability; ownership and capability lookup use hashes. Treat the
database and its backups as private.

Catalog, metadata and stream listings, HEAD and OPTIONS are read-only. Only GET
consumption of the selected `/play/` media URL enters the capability-authorized
write path. The adapter omits `bingeGroup` and ignores requests marked with explicit
prefetch hints. These guards do not cryptographically prove a human click for
every Stremio client; the supported client's actual request behavior needs browser
proof. See [selection.ts](../src/selection.ts) and [hosted.ts](../src/hosted.ts).
The authenticated acquisition POST remains a low-level compatibility/test API,
not the user interaction. Shared protobufs and Engine functions retain generic
names and ordinary chill auth. Provider credentials never enter this service;
only Engine-resolved playback URLs reach the player.

## Interrupted acquisitions

A durable operation claim is committed before `AddTransfer`. Repeated media URL
consumption for the same target and release by the same account reuses that claim, including
across process restarts or replacement installations. This does not deduplicate
transfers created by other applications or a different release selection.

If submission fails or its response is lost, the claim stays `unknown`. Do not
retry the provider call or delete the claim: the provider may already have
accepted it. The in-player status clip and **Downloads** retain the unknown state.
If operator reconciliation is needed, inspect the account's existing transfers;
never submit again merely to obtain a known result. There is no
automatic reconciliation API in the current Engine contract. Read status again
for known submitted transfers; rate limits and request deadlines remain errors.
Operation claims are retained independently of installation revocation to prevent
reinstallation from silently duplicating a download.

## Verification and release

The adapter runs in early access at `https://stremio.chill.institute`; the manifest
description and the chill-web setup page label it work in progress. The earlier
Web direct-file download-to-playback flow passes. HLS audio switching passes a
real put.io Web probe, and the generated hosted HLS flow passes with default
audio bundled into its video variant. The original separate-track fixture
retains the [client-worker regression](./HARNESS.md#hls-playback).
Both fresh focused Linux HLS trials pass automatic playback after waiting,
rendered captions, acquired-file playback, PCM audio and cleanup.
[Android TV](./NATIVE-ANDROID.md) acceptance remains incomplete. Passing a
generic native fixture addon does not establish hosted support; the
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

The hosted smoke uses generated accounts, Engine responses and lawful fixture
media from [hosted-fixture.ts](../harness/hosted-fixture.ts) with the pinned
real Stremio Web client. Its recording is safe to share
only because the entire lane is fake. Set `HOSTED_SMOKE_WEB_DIST` to the absolute
path of the built chill-web `dist` directory to exercise its actual setup UI,
installation reload and revocation. Without it, the receipt reports
`actualProductUI=false` and does not establish setup acceptance. The generated
flow checks standard IMDb movie sources, library navigation, movie and episode
context, pending progress, automatic playback after completion, durable deduplication,
exact-file playback, rendered seeking and English/Spanish/off subtitle controls.
Its generated failure cases submit distinct failed, unknown and multi-file
releases through the real adapter. The player must render the corresponding
status clip; returning to Downloads and refreshing its sources must stay
read-only. Both Downloads and Acquired videos must play the explicitly selected
second file, with decoded fixture identity checks. HEAD, OPTIONS, repeated media
GET and an additional SQLite restart must preserve the five original submissions.
Unknown-state recovery proves safe status rereading and retained duplicate
prevention only; it cannot reconcile a lost Engine response.
Status videos come from [status-media.ts](../scripts/status-media.ts) at
setup/image build time, with [runtime loading](../src/status-media.ts) requiring
the generated assets. Require a passing smoke receipt for the in-Stremio
interaction. This lane is separate from the restricted
[authenticated account probe](./ADAPTER.md#authenticated-playback-probe), which
must never record the authenticated browser. Read each run's structured result
before claiming installation, decoded playback or complete cleanup.

Every push to `main` cuts a semantic-release version and GitHub release as
`chill-ci`. [Publish hosted adapter](../.github/workflows/publish-hosted.yml) is
a manual, main-only workflow. It resolves the latest published release (or a
chosen tag), verifies that exact commit, builds one image, tests it with
generated private state, pushes it to GHCR as `X.Y.Z`, `X.Y`, `X`, `latest` and
`sha-<commit>`, records the digest on the release, then dispatches the hosting
repository's adapter deploy and waits for it. The default verification and fixture workflows retain read-only permissions.

Engine owns the adapter deployment and shared host-mutation lock; its manual
dispatch remains the rollback path.
Its adapter role pulls the immutable image before stopping the writer, snapshots
stopped SQLite, checks private health before installing the route, then checks
public and Engine health. Image rollback preserves the current database and
key. Storage schema v2 adds the stored release title while retaining prior
installations and acquisition claims.
An older v1-only image cannot read it; do not use that image as a rollback target.
The Engine deploy workflow reads the package with its own repository token, so
the `chill-stremio` container package must grant `chill-engine` read access in
its Actions access settings; GitHub exposes no API for that grant.

`mise run hosted:public` checks the deployed endpoint with the designated
account: it creates an installation through the public management API, reads
the manifest, Downloads and whole-library catalogs, and release results for a
standard IMDb movie. It revokes the installation and requires
the capability to stop resolving. It consumes no stream, so it creates no
transfer. This maintainer-only lane uses the same private credential-loading
procedure as `adapter:live`.
`CHILL_PUBLIC_STREMIO_ORIGIN` overrides the endpoint. Results go to
`artifacts/public-<timestamp>/results.json` without capability URLs.

`mise run hosted:live` separately tests one self-generated clip through real
Engine acquisition. It uses normal OAuth with the designated put.io test
account. A strict loopback proxy supplies only controlled fixture discovery;
AddTransfer, status, membership and playback resolution go to production Engine.
This is hybrid acquisition proof, not a claim that production search found the
fixture. Production discovery has its own read-only evidence. The probe never
records authenticated screens or playback URLs. After acquisition it installs
the addon through the pinned Stremio Web UI in a fresh guest browser, opens the
exact acquired file and requires advancing decoded video, intact fixture frames
and increasing decoded AAC bytes. Video pixels remain in memory. The receipt
checks browser, context and Web listener cleanup and absence of the Engine
bearer from browser requests. This uses the same devbox and direct provider
HTTPS; it does not establish playback from another device or network.

The shared executor ledger reserves the source upload and copied bytes plus
three creations before any provider mutation. An explicitly approved one-attempt
extension is available through `--approved-extra`; it preserves existing usage
and audit history. Persisted private preflight and result checkpoints support
exact-resource cleanup. Unknown copy outcomes remain pending; never clear them
merely because transfer cancellation succeeded.

The public endpoint depends on the `infra`-owned DNS record, the Engine-owned
Compose service and deploy workflow, and the encryption key provisioned through
the private deployment runbook.
Native desktop and Android TV support require their own passing receipts; Web
results do not establish native support.

Back up the SQLite database and its WAL consistently with the SQLite backup
mechanism or while the service is stopped; copying the database alone during
writes can lose committed operations. Keep the encryption key in its existing
secret recovery system, separate from the database backup. Restore into isolated
storage and verify installation resolution before cutover. Rolling back an image
must retain the same key and database; never roll operation state backward, as
that can lose duplicate-prevention claims. Stop the service and preserve state
if the older image cannot read the current schema.
