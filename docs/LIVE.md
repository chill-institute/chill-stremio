# Live put.io harness

This maintainer-only lane tests transfers and playback on the designated put.io
test account. The account owner must provision one executor before using it.
Engine owns production provider access; this harness owns bounded live proof.

`live:probe` tests put.io directly. The separate
[authenticated adapter probe](./ADAPTER.md#authenticated-playback-probe),
`mise run adapter:live`, exercises Stremio Web through production Engine using
the designated accounts and the same executor, budget and capture boundaries.

## Commands

```sh
mise run live:setup
mise run live:probe
```

Load the designated test credentials into the process environment before
`live:probe`; see [executor setup](#executor-setup). Do not copy values into this
checkout.

Authenticated requests are restricted to the API and upload origins in
[versions.ts](../harness/live/versions.ts). Authenticated redirects are rejected;
signed media and subtitle URLs use anonymous requests. An anonymous subtitle
failure does not authorize sending the account token to another origin.

`live:setup` encodes the self-generated fixture movie and English captions. It
does not call put.io. `live:probe` simulates quota failures, then on the
designated account:

- uploads a uniquely named movie plus matching English SRT/VTT sidecars
- decodes start/seek frames and PCM from the HTTPS download
- requires HTTP 206 Range, including a 20s pause then resume
- resolves the download URL again after that pause and requires working Range access;
  reusing the same URL is valid
- requires put.io-delivered English cue text from folder subtitles or HLS
- records start-from 20s when the file API persists it
- adds a URL transfer of that same lawful file and polls to completion
- deletes only the folder, files, and transfer it created

Decode, Range, pause/resume, and URL renewal fail the probe. Missing
subtitles or URL-transfer acquisition stay in `remaining` instead of aborting
playback proof. `playback.startFrom` is recorded only when the API returns 20;
an absent field does not establish resume-position support. Overlay rendering
is extra when ffmpeg has libass.

URL renewal records whether the URL changed, but does not require rotation or
prove recovery from expiry or IP limits. Treat returned URLs as opaque
credentials, resolve at playback start, and do not infer a lifetime from token
reuse. A bounded refresh may return the same token; rate-limit responses must
stop retries rather than trigger repeated URL requests.

Engine `PUTIO_OAUTH_TOKEN` still does not identify this account. Distinct
egress stays listed unless `LIVE_EGRESS_PROXY` is an HTTP CONNECT proxy on
a second public path and Range 206 succeeds on both paths. The operator must
independently establish that the proxy uses a different public IP: the harness
checks Range responses, not the egress IP itself. Proxy Range success does not
prove decoded playback on another device or a provider support commitment.
Cross-IP decoded playback needs separate evidence under this capture policy.
Native playback needs separate [Android TV](./NATIVE-ANDROID.md) and
[desktop](./NATIVE-DESKTOP.md) evidence; successful TV pairing is insufficient.

The put.io file-API reference is pinned in
[versions.ts](../harness/live/versions.ts).

## Executor setup

Supply `PUTIO_ACCOUNT_NAME` as the designated account label, `PUTIO_USERNAME`,
`PUTIO_PASSWORD`, `PUTIO_OTP_SECRET` and `PUTIO_TEST_TOKEN` through a private
process environment. The token must belong to the same test login. Lanes that
sign into Stremio also require `STREMIO_TEST_EMAIL` as the expected test identity,
plus matching `STREMIO_EMAIL` and `STREMIO_PASSWORD` credentials.

All checkouts use `~/.local/state/chill-stremio/live/runner`. The executor owner
must provision this directory with mode `0700` and its state files with mode
`0600`, owned by the registered OS user. `runner.json` has these fields:

| Field             | Value                                                    |
| ----------------- | -------------------------------------------------------- |
| `version`         | `2`                                                      |
| `account`         | Nonempty label matching `PUTIO_ACCOUNT_NAME`             |
| `username`        | Executor's OS username                                   |
| `uid`             | Executor's numeric OS UID                                |
| `machineIdSha256` | Lowercase SHA-256 of the trimmed `/etc/machine-id` value |

Registration does not create the allowance ledger. Provision or migrate it only
after reconciling usage under the [budget rules](#credential-and-budget). There
is no automatic registration or environment override for the state directory.

Older account-specific state requires manual migration while all live probes
are stopped. Preserve the existing allowance day, counters, overrides, cached
authentication, lock files and pending writes when moving state to the fixed
directory; update registration to version 2 with the matching identity. Reconcile
interrupted owners before releasing any locks. Do not initialize a fresh ledger
or delete authentication state to bypass an unresolved attempt.

## Credential and budget

Use only the designated test account and its `PUTIO_TEST_TOKEN`. Never borrow
production keys. The lawful source is `.cache/media/movie.mp4` plus `english.vtt`.

The default allowance is 10 GiB per UTC day, with no transfer-count quota. This is
the standing test budget; ordinary runs need no daily approval. The designated
Linux devbox is the sole executor; other runners must submit live work there.
Every checkout shares `allowance.json` in
`~/.local/state/chill-stremio/live/runner`. The adjacent `runner.json` binds
registration to the test account, Linux machine ID, OS username and UID. The directory and files must be private (`0700`/`0600`). There is no
checkout-local fallback, environment path override or automatic registration.

The [probe](../harness/live/probe.ts) reserves four creations and the prepared
media size twice plus both generated subtitle sizes before provider mutations.
Reservations persist even after failure or cleanup. The ledger is locked and
atomically replaced with filesystem synchronization. Probes may cross UTC
midnight; each reservation is charged to its start day. Transfer counts remain
recorded for recovery and reporting.

The executor owner must reconcile existing usage before provisioning or
repairing registration and the ledger. Unknown current-day usage requires a
full-cap reservation, never a fresh zero balance. A valid older ledger rolls
forward at UTC midnight; missing, invalid or future-dated state fails closed.
Locks are never stolen by age. After a crash, preserve `allowance.lock` and any
`allowance.json.next` until the owner establishes the process stopped and
reconciles uncertain reservations. Do not reset state to retry a failed probe.
Cleanup targets only newly created, positively attributed test artifacts and
never calls account-wide transfer clean.

The account owner may explicitly authorize extra testing for the current UTC
day. Record a finite absolute `byteLimit` ceiling plus a
nonempty `reason` in the ledger's optional `approvedLimits` object, under the
same allowance lock and durable replacement procedure. Preserve the existing
day and both reservation counters; never zero usage to grant another attempt.
Grant only the approved scope. Probes preserve and consume that allowance;
normal UTC rollover drops the override and restores the defaults. This changes
the local test budget only, never provider quotas or rate-limit handling.
Older ledgers remain readable; their obsolete `transferLimit` is ignored and
removed on the next reservation without changing recorded usage.

## Session reuse

All probes using `authorizeChill` share a private `auth.json` on the registered
executor. This owner-only (`0600`) file contains the ordinary chill token and
account identity. It stays outside the checkout and artifacts. No browser
cookies or browser storage are persisted.

Each run verifies the cached token with Engine's `GetUserProfile` and requires
the designated username. An unauthenticated response permits normal OAuth
refresh; a network error, other server error, or account mismatch stops the run
without another login. Tokens are opaque: Engine decides validity, rather than
the harness inventing an expiry or minting tokens with production signing keys.

An exclusive `auth.lock` serializes validation and refresh across checkouts.
Waiters are cancellable and stop after 130 seconds; locks are never stolen.
OAuth attempts persist a one-hour cooldown before opening the browser, including
when a process crashes or put.io rejects a login. Successful validated login
clears the cooldown. Do not delete session state to retry a rate-limited login;
honor longer provider limits. Reconcile a crashed owner before removing its lock.

## Capture

Results go to `artifacts/live-<timestamp>/results.json`. Keep credentials,
provider filenames, magnets, infohashes and signed URLs out of shared
artifacts. Decoded start/seek/subtitle PNGs are local fixture-identity frames,
not authenticated page captures. Do not reuse the Web fixture screenshot
policy against a signed put.io URL in a browser.

## Recovery

Terminal results keep `primary` and `cleanup` separately, including after
failure, timeout or cooperative cancellation. Partial playback evidence remains
available if a later operation fails. Cleanup `acknowledged` means the provider
returned its validated deletion/cancellation success envelope; it does not
claim independently verified absence. Missing acquisition responses or failed
cleanup remain `uncertain` and prevent success.

Owned resource IDs and pending acquisitions stay in the private
`.cache/live/recovery/<timestamp>.json` journal (directory `0700`, file `0600`),
outside shared artifacts. Preserve that journal for the attempt owner to
reconcile uncertain operations. It authorizes recovery of positively attributed
resources only, never account-wide cleanup. Force kill cannot guarantee
finalizers; filesystem failure can prevent publication and must be resolved
before retrying. A reported artifact path is emitted only after writing it.

## HLS audio probe

Under the same maintainer-only test environment, run
`mise exec -- node harness/live/hls.ts`. It creates a generated MP4 with English
440 Hz and Spanish 880 Hz audio, reserves the upload allowance, and resolves HLS through production Engine and the actual library translator.
A temporary local addon presents that URL to the pinned Stremio Web client. Decoded audio must
change frequency after selecting Spanish. This covers Engine, put.io and Stremio Web. Hosted installation and native
playback need separate proof.

The run stores no screenshots, recording, trace, private URLs or provider IDs.
Its sanitized receipt lives under `artifacts/live-hls-*`; exact owned-file cleanup
and unknown acquisition handling use the shared live lifecycle.
