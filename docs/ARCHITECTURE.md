# Adapter boundaries

The hosted add-on translates Stremio requests into the existing chill.institute
product model. Engine owns source discovery, provider authorization, transfers,
library access and playback resolution. Shared schemas and generated clients
belong in chill-contracts. The adapter owns Stremio translation and the
selected-media download boundary and keeps no state. chill-web issues add-on
links; Engine issues and verifies their credentials.

The local adapter calls generic `UserService` functions with the ordinary chill
bearer. The hosted adapter calls the same functions with the add-on credential
from its URL in `X-Chill-Stremio-Credential` and no `Authorization` header.
The Stremio account owns add-on installation/sync only. The adapter never
receives the user's put.io OAuth token.

## Read and write boundaries

The [local adapter](./ADAPTER.md) exposes videos directly inside one selected
folder using `GetFolder` and `ResolvePlayback`. Membership is rechecked on each
metadata/stream request. Decimal int64 IDs preserve provider precision; filenames
remain filenames rather than inferred movie identities.

The [hosted adapter](./HOSTED.md) library starts at the account root and
includes nested videos through bounded breadth-first `GetFolder` reads; catalog
pagination and exact-file lookup stop once satisfied. Membership is rechecked
for metadata and playback, and traversal errors are not converted to partial
success. No transfer or folder creation is needed to browse.

The hosted adapter also adds movie/TV discovery and release search using
existing Engine RPCs. Catalog IDs and episode metadata are translated in
[discovery.ts](../src/discovery.ts), with validated generated responses in
[discovery-engine.ts](../src/discovery-engine.ts). Movie/series search filters
the current discovery catalog; the dedicated release catalog calls `Search`.
Standard Stremio IMDb movie IDs resolve to the matching Engine catalog identity.
Movies outside that catalog use validated title/year metadata from Cinemeta's
fixed public endpoint before ordinary Engine release search; no account credentials
are sent to Cinemeta. IMDb episode IDs resolve through Engine TV detail and
season APIs and share the adapter's existing episode identity. Stream and subtitle
resources advertise IMDb IDs; Cinemeta remains responsible for their metadata.
Provider release URLs remain backend-only. A release row instead carries an
adapter media URL that submits the release when consumed.
Engine search IDs must identify the same source release across repeated searches;
temporary download credentials and changing seed counts must not change that ID.
The adapter rechecks that exact ID before opening or acquiring a result, using
the freshly issued link. A vanished release must not be replaced by a title match.
The [Engine search contract](https://github.com/chill-institute/chill-engine/blob/main/docs/ARCHITECTURE.md)
owns stable source identity and its fallback limits. Release artwork association
must remain separate from this acquisition identity.

Catalog, metadata and stream listings, HEAD and OPTIONS are read-only.
[selection.ts](../src/selection.ts) returns release rows inside Stremio. GET
consumption of the selected media URL freshly resolves the release through Engine
and calls `AddTransfer` once with the returned link. Explicit prefetch hints are
rejected, and release rows omit `bingeGroup`; these measures do not prove a human
click universally across clients. Identical requests share one submission in
process memory while any is open and for 60 seconds afterwards; later requests
and requests after a restart submit again. A failed or lost submission
response reports `unknown` and is never retried.
Engine's configured download destination controls where the transfer lands;
the adapter never calls `GetDownloadFolder`, which can create or recover a folder
and persist settings.

[acquisition-engine.ts](../src/acquisition-engine.ts) validates transfer status
and enumerates only the exact transfer result. Result folders are bounded by
depth, total folders, total entries and time. Playback verifies that the selected
video remains inside that result and its parent folder. No first-video guess or
unbounded account crawl is allowed.

## Credentials

[hosted.ts](../src/hosted.ts) serves personal routes under `/s/<credential>/`.
[credential.ts](../src/credential.ts) checks only the `v4.local.` shape and
length; Engine decides whether the credential is valid and which account it
belongs to. The adapter keeps no database, key or per-account memory beyond
open requests. A `401` or `403` from Engine becomes a reconnect row, source,
status clip or `409 reconnect`, pointing to `https://chill.institute/stremio`.

The credential grants library/discovery access, playback and chosen-release
downloads to put.io. Keep add-on links private. Personalized responses use
`Cache-Control: no-store` and `Referrer-Policy: no-referrer`; protocol reads
permit Stremio clients. Host validation rejects unexpected public origins.
Requests, upstream bodies, headers, credentials and playback URLs must be absent
from logs, analytics, traces, authenticated screenshots and proxy access logs.
Harness receipts replace credentials with `[credential]`.

## Playback and failure behavior

The adapter requests HLS through `ResolvePlayback` in
[contracts v2.7.0](https://github.com/chill-institute/chill-contracts/releases/tag/v2.7.0).
Engine checks ownership, resolves a download grant, verifies the HLS master
anonymously and returns its HTTPS URL. The player fetches playlists and media
from put.io; the account OAuth token stays in Engine.

Resolution is read-only. Existing processing returns pending; missing HLS returns
unavailable. Neither starts conversion or falls back to the original file.
Older clients that omit the delivery option retain original-file playback.

The [library translator](../src/library.ts) validates media/subtitle URLs and
expiry. Ready playback returns a direct source; pending/unavailable returns no
source. Authentication, malformed responses, timeouts and provider rate limits
remain errors instead of empty successful catalogs. Requests have finite total
deadlines and cancel on disconnect. Transfer submission is never retried.

Ready library streams include Engine's validated subtitle tracks, and the
subtitles resource returns the same tracks for library files. Selected-release
playback has no subtitle lookup; reopening the completed file from the library
provides its tracks. No subtitle lookup starts a download.

A selected download waits for one verified video, then redirects to its media
URL. While it is pending, the adapter redirects to a read-only status URL that
carries the decimal transfer ID. [Playback waiting](../src/playback-wait.ts)
bounds polling; the [hosted routes](../src/hosted.ts) set HLS and legacy request
windows. Client manifest timeouts may end a wait sooner. At the server limit it
returns `503 download_pending`. Disconnects cancel polling.

HLS terminal states return `409` with the acquisition state. Legacy `.mp4` URLs
retain generated status clips. Completed files, including each file of a
multi-file download, are chosen from the put.io library. Clips are
[generated during setup or build](../scripts/status-media.ts) and
[loaded at runtime](../src/status-media.ts).

HLS URLs are offered to the client HLS player without claiming known codecs.
Known MP4/H.264/AAC remains Web-ready for compatible older responses. A passing
fixture cannot establish support for all provider formats. Source reselection
resolves a URL again, possibly returning the same token. Do not promise a URL
lifetime or automatic recovery from provider restrictions.

The approved direct-delivery experiment requests a provider URL in Engine and
returns it to the player. The separate download credential can use the query key
`oauth_token`; its name alone does not imply the original OAuth credential was
exposed. Engine rejects leakage of the actual provider OAuth value.

put.io's [public URL contract](https://api.swaggerhub.com/apis/putio/putio/2.8.14)
promises requesting-IP validity. Cross-IP use remains an experimental assumption,
not a provider support guarantee. Do not forward client IP headers or add a
media relay. A relay needs its own design and operational authorization. Fetch
URLs when playback starts, keep them opaque, respect rate limits and never assume
minting another URL clears an IP restriction.

## Proof

The local and hosted fixture lanes use generated Engine responses and lawful
H.264/AAC media with pinned Stremio Web. Keep structured decoded video/audio,
frame/pixel, recovery and cleanup assertions; HTTP success or advancing time
alone does not prove playback. The hosted demo is recordable because it is
entirely fake; authenticated runs must never reuse that capture policy. Require
a structured browser receipt for the in-Stremio selection flow.

The [authenticated probe](./ADAPTER.md#authenticated-playback-probe) checks
real Stremio login, installation, folder browsing and decoded playback through
Engine. It retains sanitized measurements, checks that the bearer stays out of
browser requests, removes its temporary account add-on and cleans its provider
resources. Local-adapter proof is separate from
[hosted release acceptance](./HOSTED.md).

Native [desktop](./NATIVE-DESKTOP.md) and [Android TV](./NATIVE-ANDROID.md) need
separate passing evidence. Their current limitations are documented with each
client's results.
