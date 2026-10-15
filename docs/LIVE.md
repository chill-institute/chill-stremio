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
fallback or environment path override, and a `HOME` other than the OS account's
home stops the run, as in a container that maps the uid to another user.

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
release-style video and folder names on the designated account. Each run
derives sixteen random lowercase words, never real titles, and uploads the
generated `movie.mp4` under these labels, or creates the folders:

| Label                 | Name shape                                     |
| --------------------- | ---------------------------------------------- |
| `movie-dotted`        | `A.B.2001.1080p.WEB.H264.mkv`                  |
| `movie-spaced`        | `A B (2001).mkv`                               |
| `movie-underscored`   | `A_B_2001.mkv`                                 |
| `decoy`               | `A.C.2001.mkv`                                 |
| `episode-nested`      | `D.E.S01E02.720p.mkv`, in a `Season 01` folder |
| `long-word`           | a 24-letter word, then ` (2001).mkv`           |
| `apostrophe`          | `F's.G.2003.mkv`                               |
| `ampersand`           | `H.&.I.2004.mkv`                               |
| `accent`              | `Jé.K.2005.mkv`                                |
| `movie-folder`        | folder `N O (2001)`                            |
| `movie-folder-file`   | `movie.mkv`, in `movie-folder`                 |
| `show-folder`         | folder `L M`                                   |
| `show-folder-season`  | folder `Season 01`, in `show-folder`           |
| `show-folder-episode` | `S01E02.mkv`, in `show-folder-season`          |

After confirming the token's username and before any provider mutation, the
probe reserves sixteen creations (the run folder, the season folder, three
labelled folders and eleven uploads) and eleven times the media size. Everything
goes into one run-unique folder.

The probe then polls search for the words `A`, `D`, `G`, `I`, `K`, `L`, `N` and
the first 20 letters of the long word, with `per_page=100`, every 10 seconds.
It waits up to three minutes for the first label to appear and up to one more
minute for the rest, except the three generic names, which carry no poll word.
If nothing appears the run fails at stage `indexing`, or at
`search-refused` when put.io refused every poll. Afterwards it sends each query
form once and never follows a cursor:

| Form                    | Query                                 |
| ----------------------- | ------------------------------------- |
| `plain`                 | `a b`                                 |
| `plain-from-me-video`   | `a b from:me type:video`              |
| `quoted`                | `"a b"`                               |
| `dotted`                | `a.b`                                 |
| `underscored`           | `a_b`                                 |
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
| `movie-folder`          | `n o`                                 |
| `show-folder`           | `l m`                                 |

For each form the receipt keeps only the matched labels, the count of other
results, the result and `total` counts, whether a cursor came back and the
field names present on result items. `items` lists each matched label with its
`file_type`, such as `FOLDER`, and `parent`: the label its `parent_id` names,
or `other`. A generic name listed under a folder form was found through its
folder. An HTTP 400 is recorded as `refused` with
put.io's error type; other HTTP failures stop the run. `indexing.refused`
counts refused polls with the HTTP statuses and error types seen. Per label the
receipt records time to first appearance and, from its first search result,
`file_type`, `is_shared` and whether `parent_id` names the folder it was
created in. A label in `indexing.notSeen` either was not indexed in time or
does not match any poll word; the query forms tell which. `indexing.allIndexed`
ignores the generic names.

After the query forms, stage `reread` waits until at least one minute has
passed since the first label appeared, reads every label with
`GET /v2/files/<id>`, then sends the poll words once more. `reread.fixtures`
records per label whether the read `found` it, its `fileType`, whether the
repeated polls returned it (`searchSeen`) and the `searchFileType` they
reported, apart from the first sighting. `reread.afterMs` is the time since
the first poll, and `reread.refused` counts refused repeated polls. A failed
read stops the run.

Cleanup deletes the run folder and every folder and file the run created in
one request, then reads each created ID, up to three times, until put.io answers 404. `cleanup.verification` is
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

`mise run hosted:owned` checks that the deployed adapter lists and plays
videos the account already holds, on Stremio's movie and episode routes. Supply
`CHILL_STREMIO_CREDENTIAL`, `PUTIO_USERNAME` and `PUTIO_TEST_TOKEN` as for the
[transfer reuse probe](#transfer-reuse-probe); `CHILL_PUBLIC_STREMIO_ORIGIN`
overrides the adapter endpoint and `CHILL_ENGINE_BASE_URL` the Engine endpoint
used for the account check. Set `LIVE_OWNED_WEB=1` to add the
[Stremio Web step](#stremio-web-step); any other value or none skips it.

Before any provider mutation the probe requires the credential and the token to
list the same put.io root folder, then reserves three creations and twice the
generated movie's size. It creates a run-unique folder and uploads the
generated fixture movie, `.cache/media/movie.mp4`, into it twice:

| Route                          | Upload name                                   | Named after                    |
| ------------------------------ | --------------------------------------------- | ------------------------------ |
| `/stream/movie/tt0063350`      | `Night.of.the.Living.Dead.1968.1080p.WEB.mkv` | a 1968 public-domain film      |
| `/stream/series/tt0055662:1:2` | `The.Beverly.Hillbillies.S01E02.720p.WEB.mkv` | an episode of a 1962 TV series |

Engine lists an episode only under its exact show title, season and episode,
and the episode name carries no year; see
[videos already in put.io](./HOSTED.md#videos-already-in-putio). For the movie,
then the episode, the probe polls the route's stream list on the deployed
adapter, at most 30 times 10 seconds apart, until a **Play from put.io** row
names that upload. That row's media URL must answer HEAD with `200` and GET
with a `302` to an HLS playlist on the put.io API origin, not a status clip.
FFmpeg then decodes up to 10 seconds of that playlist's video in memory and
must decode frames. Episode failures carry an `episode-` stage prefix. A title
never listed records its upload's put.io file type as `uploadFileType`, or
`unknown`. The
playlist URL is a signed media grant passed on FFmpeg's command line, so other
local users can read it while the decode runs; run the lane only on a host
reserved for the operator.

Cleanup deletes only the folder and the two files the run created, then
requires put.io to report each as gone; otherwise cleanup stays `uncertain`.
The private `.cache/live/recovery/owned-<timestamp>.json` journal keeps their
IDs and the folder name. The receipt at
`artifacts/live-owned-<timestamp>/results.json` keeps stage codes, booleans,
counts, timings and the decoded codec and size, with the episode's under
`proof.episode` and the Web step's under `proof.web`, which reads `skipped`
when the step is off; it holds no credential, token, filename, provider ID or
URL.

### Stremio Web step

With `LIVE_OWNED_WEB=1`, after both FFmpeg decodes the probe serves the pinned
Stremio Web build from `mise run setup` and opens it in a fresh headless
Chromium guest context. It installs the personal manifest through the
**Add addon** dialog as `hosted:live` does, opens the movie's detail page and
reads the adapter's stream list the page requests. When that list lacks
exactly one **Play from put.io** row with the media URL the FFmpeg check
followed, it reloads the page on the listing poll's interval, up to its
attempt count. The Web step stops after 8 minutes and the whole lane after 20,
so a row that is slow to appear can end the step before the last reload. It
then selects that row and requires:

- a GET for the row's media URL
- `200` or `206` responses from put.io hosts for at least one playlist and one
  other media request
- `readyState` of at least 2, `currentTime` advancing by over a second and
  more decoded video frames
- the generated fixture's 640×360 picture, advancing frame marker and identity
  colour, since this lane plays only that fixture
- no request carrying the credential to any origin but the adapter's, and none
  with `Authorization`
- Chromium, its context and the Web listener closed afterwards

Requests go only to the Web listener, the adapter, Cinemeta and put.io hosts.
The step captures no screenshot, recording or trace; Stremio shows the
personal link in its install dialog. Failures carry a `web-` stage prefix, and
the receipt keeps the request counts, two time and frame samples, the picture
size and markers.

A pass covers one movie and one episode through the deployed adapter and
production Engine, decoded by FFmpeg, and with the Web step the movie in the
pinned Stremio Web client in Chromium. It does not cover other clients, season
packs or the recognition gaps in
[videos already in put.io](./HOSTED.md#videos-already-in-putio). Run the
step in the [browser image](./HARNESS.md#browser-image) on a host without
Chromium libraries.

## Real acquisition probe

`mise run hosted:acquire` checks that selecting a movie release, an episode
release or a season pack on the deployed adapter makes production Engine create
a put.io transfer, that put.io completes it and that the adapter then redirects
to its HLS media. Supply `CHILL_STREMIO_CREDENTIAL`, `PUTIO_USERNAME` and
`PUTIO_TEST_TOKEN` as for the [owned video probe](#owned-video-probe), with the
same `CHILL_PUBLIC_STREMIO_ORIGIN` and `CHILL_ENGINE_BASE_URL` overrides, plus
the private pin for the one release the account owner approved:

| Variable                  | Value                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| `LIVE_ACQUIRE_IMDB_ID`    | the movie's or series' IMDb ID, `tt` and digits                                                |
| `LIVE_ACQUIRE_RELEASE_ID` | the release ID in the adapter row's media URL: a UUID, or `pack:` and a UUID for a season pack |
| `LIVE_ACQUIRE_EPISODE`    | optional; `<season>:<episode>`, each 1 to 9999 without leading zeros, for an episode           |
| `LIVE_ACQUIRE_MAX_BYTES`  | the largest size accepted, a positive integer                                                  |

Without `LIVE_ACQUIRE_EPISODE` the pin names a movie release. With it, a UUID
names that episode's single release and `pack:<uuid>` its season pack, which
requires the episode it plays. For example, with neutral values:

```sh
# An episode release: season 1, episode 2
LIVE_ACQUIRE_EPISODE=1:2
LIVE_ACQUIRE_RELEASE_ID=00000000-0000-4000-8000-000000000000
# The same episode played from its season pack
LIVE_ACQUIRE_RELEASE_ID=pack:00000000-0000-4000-8000-000000000000
```

Keep the pin in the private process environment, never in this checkout. A
missing, malformed or inconsistent pin, such as a season pack without an
episode, fails at stage `configuration` before any request. Set
`LIVE_ACQUIRE_WEB=1` to make the selection in
[Stremio Web](#stremio-web-selection) instead of steps 5 and 8 below; any other
value or none keeps the probe's own GET.

The probe then:

1. requires the credential and the token to list the same put.io root folder,
   and the designated username
2. reads the stream list once, the movie's or, with an episode, that
   episode's `/stream/series/<imdb>:<season>:<episode>.json`, and requires a
   **Download to put.io** row, or for a season pack the **Download season to
   put.io** row, whose media URL names the pinned release and, for an
   episode, the pinned episode; otherwise it fails at `pinned-row-missing`
   with nothing reserved. It never selects another row
3. reads put.io's clock as the run start and lists every put.io transfer as
   the baseline, kept only in the journal
4. reserves one creation and `LIVE_ACQUIRE_MAX_BYTES`
5. sends HEAD, which must answer `200`, then GET to the row's media URL exactly
   once. It follows only same-origin redirects to that link's
   `/status/<id>.m3u8`, or for a season pack
   `/status/<id>/<season>/<episode>.m3u8` naming the pinned episode. When the
   adapter redirects to the pending clip, the probe reads the last status URL
   again, at most every 10 seconds, until 20 minutes after the selection; a
   `503` capacity refusal repeats the same read. Any other status clip fails
   at `adapter-<kind>`
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
   and, when that file is a folder the run created, every entry under it,
   within the adapter's own limits of 32 folders, 8 levels and 5000 entries
10. for an episode or season pack, reads the file the playlist names. It must
    be the saved file or under the saved folder, and its name must carry the
    pinned season and episode, as `S01E02` or `1x02`, and not a range such as
    `S01E02E03`, `S01E02.E03`, `S01E02-03` or `1x02-1x03`, or the probe fails
    at `episode-identity`; a resolution such as `S01E02-720p` is not a range
11. cancels the transfer to stop seeding, and decodes up to 10 seconds of the
    playlist's video with FFmpeg, which must decode frames

Every exit after the GET records the transfer's file, and lists everything
under a saved folder the run created, before cancelling. Cleanup cancels only
the attributed transfer, again while put.io still lists it, since cancelling a
seeding transfer only stops it, and deletes its file only when that file is not
in the baseline, sits in the transfer's save folder and was created
during the run. A season pack saves a folder, and deleting it removes the
tree. Afterwards put.io must no longer list the transfer and must answer `404`
for the file, including a file that already answered `404` when it was
recorded, and for every entry the run found under a saved folder. The
receipt's `cleanup.verification` is `verified` only then;
`acknowledged` alone does not pass. A recorded file the run cannot prove it
created, a saved folder whose tree could not be listed within those limits, or
a finished transfer whose file was never recorded, leaves verification
`unverified`; a GET with no attributable transfer leaves cleanup
`uncertain`. As in the owned video probe, the playlist URL is a signed media
grant on FFmpeg's command line; run the lane only on a host reserved for the
operator.

The private `.cache/live/recovery/acquire-<timestamp>.json` journal keeps the
run start, the baseline, candidate and attributed transfer IDs, the file
and save folder IDs and the IDs found under a saved folder. The receipt at
`artifacts/live-acquire-<timestamp>/results.json` keeps stage codes, booleans,
counts, timings from selection to the first status URL, to completion and to
media, the status read count, a size bucket, the decoded codec, size and frame
count, and cleanup acknowledgement and verification. `release` is `movie`,
`episode` or `season-pack`; for an episode `playedInTransfer` and
`playedEpisodeMatches` record the identity check, and for a season pack
`packVideos` counts the video files the transfer saved, samples included.
Once the run has seen what the transfer saved, `savedTypes` counts those
entries by put.io type and, for an episode pin, `savedEpisodeNames` counts the
names that read as the pinned episode.
`locationNamesFile` is `false` when the transfer saved a folder. It holds no
credential, token, IMDb ID, release ID, title, filename, magnet, info hash, provider ID or
URL.

A pass covers one approved movie release, episode release or season pack
acquired through the deployed adapter and production Engine, decoded by FFmpeg
rather than a Stremio client.

### Stremio Web selection

With `LIVE_ACQUIRE_WEB=1` the probe runs steps 1 to 4 and the HEAD of step 5
unchanged, then serves the pinned Stremio Web build from `mise run setup` in a
fresh headless Chromium guest context and installs the personal manifest as
the [owned video probe's Web step](#stremio-web-step) does. It opens the
movie's detail page, or the pinned episode's, and reads the stream list the
page requests, reading it at most three times, 10 seconds apart, until it
holds the pinned row by the step 2 rules. Just before the first
click the selection counts as sent. The page then selects only that row and
follows the adapter's redirects, status URLs and manifest retries itself. When
it reaches the pending clip, the probe opens the title's page again once the
player leaves and selects the same row, which rejoins the download. Any other
status clip fails at `adapter-<kind>`. Chromium aborts a request for any other
media URL on the adapter, and the probe fails.

While the page waits, the probe lists transfers every 10 seconds. The one
transfer not in the baseline and created during the run is attributed; a
second fails at `web-transfers`, is never attributed, and leaves cleanup
`uncertain` with the first still cancelled and deleted. The size gate of step
7 and the 20-minute acquisition limit from the first click apply as before;
either stops the page. Once the page requests put.io media it must show:

- a GET for the pinned media URL
- `200` or `206` responses from put.io hosts for at least one playlist and one
  other media request
- `readyState` of at least 2, `currentTime` advancing by over a second and
  more decoded video frames
- exactly one put.io file named by its put.io API requests; for an episode or
  season pack, that file passes the identity check of step 10
- no request carrying the credential to any origin but the adapter's, and none
  with `Authorization`
- Chromium, its context and the Web listener closed afterwards

The probe then lists transfers again, reads the transfer's size and records
its file as in steps 7 and 9, and cancels it. FFmpeg decodes nothing; the page
supplies the decode proof. Cleanup and verification are unchanged, including
after a browser failure. Failures in the page carry a `web-` stage prefix. The
Web step stops after 28 minutes and the whole lane after 30. It captures no
screenshot, recording or trace, and the page's signed playlist URLs stay inside
Chromium.

The receipt adds `selectionToTransferMs` and, under `proof.web`, the client
and browser versions, the stream list reads, row clicks, selected-URL, status
and pending clip requests, other media requests, put.io playlist and segment
responses, how many put.io files played, `transfersCreated`, two time and frame
samples, cleanup booleans and `status`; `locationNamesFile` reports whether
the played file is the transfer's saved file. It names no file, title, URL or
ID. Run it in the [browser image](./HARNESS.md#browser-image) on a host without
Chromium libraries. A pass covers playback of one approved release in the
pinned Stremio Web client in Chromium after acquisition through the deployed
adapter and production Engine.

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
