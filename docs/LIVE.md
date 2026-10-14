# Live put.io harness

This maintainer-only lane tests transfers and playback on the designated put.io
test account. Engine owns production provider access; this harness owns bounded live proof.

`live:probe` tests put.io directly. The separate
[authenticated adapter probe](./ADAPTER.md#authenticated-playback-probe),
`mise run adapter:live`, exercises Stremio Web through production Engine using
the designated accounts and the same budget and capture boundaries.

## Commands

```sh
mise run live:setup
mise run live:probe
```

Load the designated test credentials into the process environment before
`live:probe`; see [setup](#setup). Do not copy values into this
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

## Setup

Supply `PUTIO_ACCOUNT_NAME` as the designated account label, `PUTIO_USERNAME`,
`PUTIO_PASSWORD`, `PUTIO_OTP_SECRET` and `PUTIO_TEST_TOKEN` through a private
process environment. The token must belong to the same test login. Lanes that
sign into Stremio also require `STREMIO_TEST_EMAIL` as the expected test identity,
plus matching `STREMIO_EMAIL` and `STREMIO_PASSWORD` credentials.

Live state lives in `~/.local/state/chill-stremio/live/runner`, shared by every
checkout of the current OS user. The first live run creates the directory
(`0700`) and a zeroed `allowance.json` (`0600`) for the current UTC day. An
existing directory or ledger that is not private, not owned by the current user
or not valid stops the run; it is never replaced. There is no checkout-local
fallback or environment path override.

## Credential and budget

Use only the designated test account and its `PUTIO_TEST_TOKEN`. Never borrow
production keys. The generated fixture, `.cache/media/movie.mp4` plus
`english.vtt`, is the only source, except that
[`hosted:acquire`](#real-acquisition-probe) may acquire the single release the
account owner approved, supplied privately at run time; it is never a fallback
or a looser match.

The default allowance is 10 GiB per UTC day, with no transfer-count quota. This is
the standing test budget; ordinary runs need no daily approval. The budget is
tracked per OS user and machine in the shared `allowance.json`.

The [probe](../harness/live/probe.ts) reserves four creations and the prepared
media size twice plus both generated subtitle sizes before provider mutations.
Reservations persist even after failure or cleanup. Bytes put.io reports
beyond a reservation are charged under the same lock even past the cap; such a
ledger refuses every reservation and every one-attempt extension until UTC
rollover. The ledger is locked and atomically replaced with filesystem
synchronization. Probes may cross UTC midnight; each reservation is charged to
its start day. Transfer counts remain recorded for recovery and reporting.

When repairing a ledger with unknown current-day usage, reserve the full cap,
never a fresh zero balance. A valid older ledger rolls forward at UTC midnight;
invalid or future-dated state fails closed. Locks are never stolen by age.
After a crash, preserve `allowance.lock` and any `allowance.json.next` until
the probe process has stopped and uncertain reservations are accounted for. Do not reset state to retry a failed probe.
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

All probes using `authorizeChill` share a private `auth.json` in the same state
directory. This owner-only (`0600`) file contains the ordinary chill token and
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
honor longer provider limits. Confirm a crashed process stopped before removing its lock.

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

## Transfer reuse probe

`mise run hosted:reuse` checks that production Engine answers repeated add-on
requests for one source with the account's existing put.io transfer. Supply
`CHILL_STREMIO_CREDENTIAL` as for
[`hosted:public`](./HOSTED.md#verification-and-release), plus `PUTIO_USERNAME`
and `PUTIO_TEST_TOKEN` from [setup](#setup). `CHILL_ENGINE_BASE_URL` overrides
the Engine endpoint. Engine reuses transfers only for add-on credentials, so
`hosted:live`, which adds with the account bearer, does not cover this.

The source is a magnet for a single-file torrent of the generated English
captions under a random per-run name. No peer holds it, so put.io never
downloads it. Before any provider mutation the probe requires the credential
and the token to list the same put.io root folder and no existing transfer to
carry the run's info hash, then reserves five creations and their payload
bytes. It calls Engine `AddTransfer` with the credential once, again in
sequence, then three times concurrently. It passes only when every call returns
the same transfer and put.io lists exactly one transfer for that info hash, not
in error.

A returned ID counts only once put.io lists it under the run's info hash.
Cleanup cancels only such transfers and never touches earlier ones; a reported
ID without the hash, or a lost response, leaves cleanup `uncertain`. The private
`.cache/live/recovery/reuse-<timestamp>.json` journal keeps the info hash, the
torrent name and every Engine-reported ID for reconciliation. The receipt at
`artifacts/live-reuse-<timestamp>/results.json` labels transfers `t1`, `t2` and
so on, and holds no credential, token, magnet, info hash or provider ID.

A pass covers magnets only; Engine download links, finished or errored
transfers and actual downloads are not exercised.

## File search probe

```sh
mise run live:setup
mise run live:search
```

Supply `PUTIO_USERNAME` and `PUTIO_TEST_TOKEN` from [setup](#setup).
`live:search` measures how put.io `GET /v2/files/search` matches
release-style video names on the designated account. Each run derives twelve
random lowercase words, never real titles, and uploads the generated
`movie.mp4` under these labels:

| Label               | Name shape                                     |
| ------------------- | ---------------------------------------------- |
| `movie-dotted`      | `A.B.2001.1080p.WEB.H264.mkv`                  |
| `movie-spaced`      | `A B (2001).mkv`                               |
| `movie-underscored` | `A_B_2001.mkv`                                 |
| `decoy`             | `A.C.2001.mkv`                                 |
| `episode-nested`    | `D.E.S01E02.720p.mkv`, in a `Season 01` folder |
| `long-word`         | a 24-letter word, then ` (2001).mkv`           |
| `apostrophe`        | `F's.G.2003.mkv`                               |
| `ampersand`         | `H.&.I.2004.mkv`                               |
| `accent`            | `Jé.K.2005.mkv`                                |

After confirming the token's username and before any provider mutation, the
probe reserves eleven creations (the run folder, the season folder and nine
uploads) and nine times the media size. Uploads go into one run-unique folder.

The probe then polls search for the words `A`, `D`, `G`, `I`, `K` and the first
20 letters of the long word, with `per_page=100`, every 10 seconds. It waits up
to three minutes for the first upload to appear and up to one more minute for
the rest. If nothing appears the run fails at stage `indexing`, or at
`search-refused` when put.io refused every poll. Afterwards it sends each query
form once and never follows a cursor:

| Form                    | Query                                 |
| ----------------------- | ------------------------------------- |
| `plain`                 | `a b`                                 |
| `plain-from-me-video`   | `a b from:me type:video`              |
| `quoted`                | `"a b"`                               |
| `dotted`                | `a.b`                                 |
| `single-word`           | `a`                                   |
| `episode`               | `d e`                                 |
| `episode-from-me-video` | `d e from:me type:video`              |
| `long-prefix-20`        | first 20 letters of the long word     |
| `long-full-24`          | the whole long word                   |
| `typo`                  | `a` with one letter changed, then `b` |
| `apostrophe-dropped`    | `fs g`                                |
| `apostrophe-kept`       | `f's g`                               |
| `ampersand-and`         | `h and i`                             |
| `ampersand-omitted`     | `h i`                                 |
| `accent-folded`         | `je k`                                |
| `accent-kept`           | `jé k`                                |

For each form the receipt keeps only the matched labels, the count of other
results, the result and `total` counts, whether a cursor came back and the
field names present on result items. An HTTP 400 is recorded as `refused` with
put.io's error type; other HTTP failures stop the run. `indexing.refused`
counts refused polls with the HTTP statuses and error types seen. Per label the
receipt records time to first appearance, `file_type`, `is_shared` and whether
`parent_id` names the folder it was uploaded to. A label in `indexing.notSeen` either was
not indexed in time or does not match any poll word; the query forms tell
which.

Cleanup deletes the run folder and everything the run created in one request,
then reads each created ID, up to three times, until put.io answers 404. `cleanup.verification` is
`verified` only when every one is gone, `present` when any remains, and
`unverified` when the check could not finish, including when a read returns a
different file. A run passes only with a passing primary, acknowledged cleanup
and verified absence.

The receipt at `artifacts/live-search-<timestamp>/results.json` holds labels,
counts, booleans, put.io field names and enum values only: no words,
filenames, queries, IDs or URLs. The
private `.cache/live/recovery/search-<timestamp>.json` journal keeps the folder
name, label-to-name and label-to-ID mappings and the verification result for
reconciliation.

## Owned video probe

`mise run hosted:owned` checks that the deployed adapter lists and plays a
video the account already holds. Supply `CHILL_STREMIO_CREDENTIAL`,
`PUTIO_USERNAME` and `PUTIO_TEST_TOKEN` as for the
[transfer reuse probe](#transfer-reuse-probe); `CHILL_PUBLIC_STREMIO_ORIGIN`
overrides the adapter endpoint and `CHILL_ENGINE_BASE_URL` the Engine endpoint
used for the account check.

Before any provider mutation the probe requires the credential and the token to
list the same put.io root folder, then reserves two creations and the generated
movie's size. It creates a run-unique folder and uploads the generated fixture
movie, `.cache/media/movie.mp4`, into it as
`Night.of.the.Living.Dead.1968.1080p.WEB.mkv`, named after a 1968
public-domain film (`tt0063350`). It then polls that film's stream list on the
deployed adapter, at most 30 times 10 seconds apart, until a
**Play from put.io** row names the uploaded file. That row's media URL must
answer HEAD with `200` and GET with a `302` to an HLS playlist on the put.io API
origin, not a status clip. FFmpeg then decodes up to 10 seconds of that
playlist's video in memory and must decode frames. The playlist URL is a signed
media grant passed on FFmpeg's command line, so other local users can read it
while the decode runs; run the lane only on a host reserved for the operator.

Cleanup deletes only the folder and file the run created, then requires put.io
to report each as gone; otherwise cleanup stays `uncertain`. The private
`.cache/live/recovery/owned-<timestamp>.json` journal keeps their IDs and the
folder name. The receipt at `artifacts/live-owned-<timestamp>/results.json`
keeps stage codes, booleans, counts, timings and the decoded codec and size; it
holds no credential, token, filename, provider ID or URL.

A pass covers one movie title on Stremio's movie route through the deployed
adapter and production Engine, decoded by FFmpeg rather than a Stremio client.
It does not cover episodes or the recognition gaps in
[videos already in put.io](./HOSTED.md#videos-already-in-putio).

## Real acquisition probe

`mise run hosted:acquire` checks that selecting a release on the deployed
adapter makes production Engine create a put.io transfer, that put.io completes
it and that the adapter then redirects to its HLS media. Supply
`CHILL_STREMIO_CREDENTIAL`, `PUTIO_USERNAME` and `PUTIO_TEST_TOKEN` as for the
[owned video probe](#owned-video-probe), with the same
`CHILL_PUBLIC_STREMIO_ORIGIN` and `CHILL_ENGINE_BASE_URL` overrides, plus the
private pin for the one release the account owner approved:

| Variable                  | Value                                                 |
| ------------------------- | ----------------------------------------------------- |
| `LIVE_ACQUIRE_IMDB_ID`    | the movie's IMDb ID, `tt` and digits                  |
| `LIVE_ACQUIRE_RELEASE_ID` | the release ID in the adapter row's media URL, a UUID |
| `LIVE_ACQUIRE_MAX_BYTES`  | the largest size accepted, a positive integer         |

Keep the pin in the private process environment, never in this checkout. A
missing or malformed pin fails at stage `configuration` before any request.

The probe then:

1. requires the credential and the token to list the same put.io root folder,
   and the designated username
2. reads the movie's stream list once and requires a **Download to put.io**
   row whose media URL names the pinned release; otherwise it fails at
   `pinned-row-missing` with nothing reserved. It never selects another row
3. reads put.io's clock as the run start and lists every put.io transfer as
   the baseline, kept only in the journal
4. reserves one creation and `LIVE_ACQUIRE_MAX_BYTES`
5. sends HEAD, which must answer `200`, then GET to the row's media URL exactly
   once. It follows only same-origin redirects to that link's
   `/status/<id>.m3u8`. When the adapter redirects to the pending clip, the
   probe reads the last status URL again, at most every 10 seconds, until 20
   minutes after the selection; a `503` capacity refusal repeats the same
   read. Any other status clip fails at `adapter-<kind>`
6. attributes the transfer the status URL names, or else the one transfer not
   in the baseline and created during the run. A pre-existing transfer or more
   than one candidate fails at `attribution`; once more than one candidate is
   seen, cleanup never attributes by baseline difference, so the probe cancels
   and deletes nothing it did not create
7. reads the transfer between status reads. When put.io reports a size above
   the pin, it records the transfer's file, cancels the transfer, charges the
   excess bytes to the ledger and fails at `size-exceeded`. Every exit after
   the GET charges an excess the final transfer listing reports
8. requires the final redirect to be an HLS playlist on the put.io API origin,
   as the owned video probe does, not a status clip, and put.io to have
   reported the transfer's size, or fails at `size-unknown`
9. lists transfers again and records the transfer's file and save folder,
   cancels the transfer to stop seeding, and decodes up to 10 seconds of the
   playlist's video with FFmpeg, which must decode frames

Every exit after the GET records the transfer's file before cancelling. Cleanup
cancels only the attributed transfer and deletes its file only when that file
is not in the baseline, sits in the transfer's save folder and was created
during the run. Afterwards put.io must no longer list the transfer and must
answer `404` for the file, including a file that already answered `404` when
it was recorded. The receipt's `cleanup.verification` is `verified` only then;
`acknowledged` alone does not pass. A recorded file the run cannot prove it
created, or a finished transfer whose file was never recorded, leaves
verification `unverified`; a GET with no attributable transfer leaves cleanup
`uncertain`. As in the owned video probe, the playlist URL is a signed media
grant on FFmpeg's command line; run the lane only on a host reserved for the
operator.

The private `.cache/live/recovery/acquire-<timestamp>.json` journal keeps the
run start, the baseline, candidate and attributed transfer IDs and the file
and save folder IDs. The receipt at
`artifacts/live-acquire-<timestamp>/results.json` keeps stage codes, booleans,
counts, timings from selection to the first status URL, to completion and to
media, the status read count, a size bucket, the decoded codec, size and frame
count, and cleanup acknowledgement and verification. It holds no credential,
token, IMDb ID, release ID, title, filename, magnet, info hash, provider ID or
URL.

A pass covers one approved movie release acquired through the deployed adapter
and production Engine, decoded by FFmpeg rather than a Stremio client.

## HLS audio probe

Under the same maintainer-only test environment, run
`mise exec -- node harness/live/hls.ts`. It creates a generated MP4 with English
440 Hz and Spanish 880 Hz audio, reserves the upload allowance, and resolves HLS
through production Engine and the actual library translator. A temporary local
addon presents that URL to the pinned Stremio Web client. Decoded audio must
change frequency after selecting Spanish. This covers Engine, put.io and
Stremio Web. Hosted installation and native playback need separate proof.

The run stores no screenshots, recording, trace, private URLs or provider IDs.
Its sanitized receipt lives under `artifacts/live-hls-*`; exact owned-file cleanup
and unknown acquisition handling use the shared live lifecycle.
