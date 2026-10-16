# Architecture

## Owners

- Engine: source discovery, provider authorization, transfers, library access,
  playback resolution, and add-on credential issue and verification.
- chill-contracts: shared schemas and the generated client pinned in
  [package.json](../package.json).
- chill-web: issues add-on links.
- This repo: Stremio translation and the selected-media download boundary. It
  keeps no database or key and never receives the put.io OAuth token. Its only
  memory is in process, keyed by credential-and-selection hashes: shared
  submissions and owned-video waits, both bounded per [hosted](./hosted.md).

The [local adapter](./adapter.md) calls Engine's `UserService` with the chill
bearer; the [hosted adapter](./hosted.md) calls the same functions with
`X-Chill-Stremio-Credential` and no `Authorization`.

## Reads

- Library: `GetFolder` and `ResolvePlayback` in [library.ts](../src/library.ts).
  Membership is rechecked on every metadata and stream request; int64 IDs stay
  decimal; filenames stay filenames.
- Discovery: [discovery.ts](../src/discovery.ts) and
  [discovery-engine.ts](../src/discovery-engine.ts). IMDb movie IDs map to
  Engine's catalog; movies outside it use Cinemeta's public title and year,
  sent no credentials. Episode IDs resolve through Engine TV detail and season
  APIs.
- Owned videos: `FindOwnedVideos` gets the same title and year as release
  search. Engine owns filename matching; the adapter never parses filenames.

## Writes

[selection.ts](../src/selection.ts) is the only write path; listings, HEAD,
OPTIONS and prefetch hints stay read-only, and no client guard proves a human
click.

- Release rows carry an adapter media URL; provider links stay in Engine. GET
  re-resolves the exact Engine search ID with a fresh link and calls
  `AddTransfer` once. Engine search IDs must stay stable across searches; a
  vanished release is never replaced by a title match.
- Season packs resolve only through `GetTVShowSeasonDownloads` with the same
  pack ID, never the episode search.
- Never call `GetDownloadFolder`: it can create folders and persist settings.
  Engine's configured destination decides where transfers land.
- `StartPlaybackConversion` runs only from GET on selected media; Engine treats
  repeats as idempotent.
- [acquisition-engine.ts](../src/acquisition-engine.ts) lists only the exact
  transfer result, bounded by depth, folders, entries and time; past those it
  asks for a file choice. No first-video or size-based guess, no account crawl.

## Deadlines

Discovery RPCs get the time left on the request or submission budget, capped by
the 10-second step, minus 500 ms to receive. `AddTransfer` gets 21 seconds,
outlasting Engine's 20-second shared add. The submission budget is independent
of any request; a spent deadline fails without calling Engine. Transfer
submission is never retried. Waiting is bounded in
[playback-wait.ts](../src/playback-wait.ts); routes and windows in
[hosted.ts](../src/hosted.ts).

## Playback URLs

- Engine verifies the put.io HLS master with a separate download grant; the
  player fetches media from put.io. The grant may use the query key
  `oauth_token`; that name does not mean the OAuth token leaked.
- Resolution never falls back to the original file. HLS sources make no codec
  claims; only known MP4/H.264/AAC is marked Web-ready.
- put.io's [URL contract](https://api.swaggerhub.com/apis/putio/putio/2.8.14)
  promises requesting-IP validity; cross-IP use is an unproven assumption. Do
  not forward client IP headers or add a media relay without its own design and
  authorization. Never promise a URL lifetime.
