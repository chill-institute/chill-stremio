# Live put.io lanes

Maintainer-only lanes that touch the designated put.io and Stremio test
accounts and production Engine. Engine owns production provider access; these
lanes own bounded live proof. Each writes a sanitized receipt under
`artifacts/<lane>-<timestamp>/results.json`.

## Setup

Supply these through a private process environment, never this checkout:

- `PUTIO_ACCOUNT_NAME` (label), `PUTIO_USERNAME`, `PUTIO_PASSWORD`,
  `PUTIO_OTP_SECRET`, and `PUTIO_TEST_TOKEN` for the same login.
- Stremio lanes: `STREMIO_TEST_EMAIL` plus matching `STREMIO_EMAIL` and
  `STREMIO_PASSWORD`.
- Deployed-adapter lanes: `CHILL_STREMIO_CREDENTIAL`, minted as in
  [canary credential](./hosted.md#canary-credential).
  `CHILL_PUBLIC_STREMIO_ORIGIN` and `CHILL_ENGINE_BASE_URL` override endpoints.

Run `mise run live:setup` first; it encodes the fixture and calls nothing.
Live state lives in `~/.local/state/chill-stremio/live/runner` (`0700`), shared
by every checkout of the OS user. A directory or ledger that is not private,
not owned or invalid stops the run and is never replaced. A `HOME` other than
the account's home stops the run; there is no override.

## Credential and budget

- Use only the designated account and `PUTIO_TEST_TOKEN`; never production
  keys. The only source is the generated fixture, except that
  [`hosted:acquire`](#real-acquisition-probe) may fetch the one release the
  account owner approved, never as a fallback or looser match.
- The daily allowance is `byteLimit` in
  [versions.ts](../harness/live/versions.ts), per UTC day, tracked in
  `allowance.json` (`0600`). Ordinary runs need no approval.
- Every lane reserves creations and bytes before any provider mutation.
  Reservations persist through failure and cleanup. Bytes put.io reports past
  a reservation are charged even beyond the cap, which then refuses everything
  until UTC rollover.
- Locks are never stolen. After a crash, keep `allowance.lock` and
  `allowance.json.next` until the process has stopped and uncertain
  reservations are accounted for. Never reset state to retry.
- Repairing a ledger with unknown usage: reserve the full cap, never zero.
  Invalid or future-dated state fails closed.
- Extra testing needs the account owner's explicit approval for the current UTC
  day: add a finite `byteLimit` and a `reason` under `approvedLimits`, under the
  lock, keeping the day and counters. `--approved-extra` grants one attempt and
  is refused once usage is past the cap. Rollover drops overrides. This never
  changes provider quotas or rate-limit handling.
- Cleanup removes only positively attributed resources the run created; never
  an account-wide transfer clean.

## Session reuse

Lanes that sign in share `auth.json` (`0600`) in the state directory: the chill
token and account identity, no browser state. Each run checks it with Engine's
`GetUserProfile` and requires the designated username; only an unauthenticated
answer permits OAuth refresh. `auth.lock` serializes refresh (130-second wait,
never stolen). OAuth persists a one-hour cooldown, even after a crash or a
rejected login. Never delete session state to retry a rate-limited login.

## Capture and recovery

- Authenticated requests go only to the origins in
  [versions.ts](../harness/live/versions.ts) and never follow redirects; signed
  media and subtitle URLs are fetched anonymously.
- Treat returned URLs as opaque credentials; resolve at playback start and stop
  retrying on rate limits.
- Receipts hold no credentials, tokens, filenames, magnets, info hashes,
  provider IDs or signed URLs. Never point the Web fixture screenshot policy at
  a signed put.io URL.
- Browser steps capture no screenshot, recording or trace, and fail if the
  credential reaches any origin but the adapter or `Authorization` is sent.
- `hosted:owned` and `hosted:acquire` pass a signed URL on FFmpeg's command
  line; run them only on a host reserved for the operator.
- Results keep `primary` and `cleanup` apart. Cleanup `acknowledged` means
  put.io accepted the deletion, not verified absence; `uncertain` cleanup fails
  the run.
- Resource IDs live in the private `.cache/live/recovery/` journals (`0700`,
  `0600`). Keep them for the attempt owner; they authorize recovery of
  attributed resources only.
- Browser steps run in the [browser image](./harness.md#browser-image) on hosts
  without Chromium libraries.

## Lanes

| Command                                 | Proves                                                        | Code                                                    |
| --------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------- |
| `mise run live:probe`                   | put.io upload, decode, Range, URL renewal, URL transfer       | [probe.ts](../harness/live/probe.ts)                    |
| `mise run live:search`                  | how put.io file search matches release-style names            | [search.ts](../harness/live/search.ts)                  |
| `mise run adapter:live`                 | Stremio Web through production Engine, local adapter          | [adapter.md](./adapter.md#authenticated-playback-probe) |
| `mise run hosted:live`                  | real Engine acquisition behind a fake Engine credential check | [hosted.ts](../harness/live/hosted.ts)                  |
| `mise run hosted:reuse`                 | repeated adds return one put.io transfer                      | [reuse.ts](../harness/live/reuse.ts)                    |
| `mise run hosted:owned`                 | owned videos list and play through the deployed adapter       | [owned.ts](../harness/live/owned.ts)                    |
| `mise run hosted:acquire`               | one approved release acquired and played                      | [acquire.ts](../harness/live/acquire.ts)                |
| `mise run hosted:public`                | the deployed adapter accepts the credential (no stream)       | [public.ts](../harness/live/public.ts)                  |
| `mise exec -- node harness/live/hls.ts` | HLS audio switching via put.io in Stremio Web                 | [hls.ts](../harness/live/hls.ts)                        |

`live:probe` lists distinct egress as remaining unless `LIVE_EGRESS_PROXY` is a
CONNECT proxy on a second public path; the operator must establish that it uses
a different IP, since the harness checks only Range responses.

### Transfer reuse probe

Sends one unseeded magnet of generated captions to Engine `AddTransfer` five
times, sequentially and concurrently, and requires one put.io transfer. It
first requires the credential and token to share a root folder. It covers
magnets only. Cleanup cancels only transfers listed under the run's info hash.

### Owned video probe

Uploads the fixture under a 1968 public-domain film's name and a 1962 series
episode's name, waits for each **Play from put.io** row, and decodes its HLS
playlist with FFmpeg. Selections follow up to five `wait=<n>` redirects while
put.io prepares a video. A failed stream-list read counts under
`listingErrors`, and the third in a row fails the stage. Optional steps:

- `LIVE_OWNED_WEB=1` (Stremio Web step) plays the movie row in pinned Stremio
  Web in Chromium.
- `LIVE_OWNED_CONVERT=1` (convert step) uploads a lossless Matroska copy and
  checks that listings, HEAD, OPTIONS and prefetch never start a conversion,
  that one selection starts it and ends as `preparing`, or `hls` when put.io
  finishes during the wait (`selection.outcome`; `other` fails), and that the row plays once
  put.io finishes. The lane cannot count `StartPlaybackConversion` calls;
  [live-owned.test.ts](../tests/live-owned.test.ts) proves only the selection
  asks, once per read while put.io still queues the conversion.

### Real acquisition probe

Selects the one release the account owner approved on the deployed adapter,
waits for put.io to complete it, decodes the playlist and removes only what it
created. The pin stays in the private environment:

| Variable                  | Value                                              |
| ------------------------- | -------------------------------------------------- |
| `LIVE_ACQUIRE_IMDB_ID`    | `tt` and digits                                    |
| `LIVE_ACQUIRE_RELEASE_ID` | the row's release UUID, or `pack:<uuid>`           |
| `LIVE_ACQUIRE_EPISODE`    | optional `<season>:<episode>`; required for a pack |
| `LIVE_ACQUIRE_MAX_BYTES`  | the largest accepted size                          |

- It never selects another row; a missing pinned row fails before reserving.
- It attributes only the transfer the status URL names, or the single new one;
  more than one candidate fails and nothing unattributed is touched.
- A transfer larger than the pin is cancelled, charged and fails.
- Episode pins require the played file's name to carry exactly that episode.
- Cleanup deletes only files created in the run inside the transfer's save
  folder and verifies `404`s; `acknowledged` alone does not pass.
- `LIVE_ACQUIRE_WEB=1` (Stremio Web selection) makes the selection in pinned
  Stremio Web instead of the probe's own GET.
