# Agent guide

This repository owns the hosted Stremio adapter for chill.institute. Read
[CONTRIBUTING.md](./CONTRIBUTING.md) for commands and [architecture](./docs/ARCHITECTURE.md)
before changing boundaries. Fixture setup and smoke stay local and credential-free.
`mise run live:probe` is a maintainer-only lane. It may contact put.io only
with its designated test token; it must not use Engine or production tokens.

## Engine-backed adapter

`mise run adapter:serve` runs the local single-user adapter with `CHILL_TOKEN`
and `CHILL_FOLDER_ID` in its private environment. Read [ADAPTER.md](./docs/ADAPTER.md)
for the per-process installation capability and SSH forwarding. Never print the
private installation receipt or use real credentials in the fixture lane.
`mise run adapter:live` uses both designated test accounts, normal chill
OAuth and production Engine for the authenticated Web flow. It shares the
live allowance; see [ADAPTER.md](./docs/ADAPTER.md#authenticated-playback-probe).
`mise run adapter:smoke` proves the actual adapter against a generated local
Engine in the pinned Web client; preserve fake-only capture and cleanup proof.

## Hosted release

`mise run hosted:serve` runs the stateless multi-user adapter. Read
[HOSTED.md](./docs/HOSTED.md) before changing credentials, routes or rollout.
Personal routes live under `/s/<credential>/`; the adapter checks only the
credential's shape and forwards it to Engine in `X-Chill-Stremio-Credential`,
never as `Authorization`. It keeps no database, key, installation registry or
management API; chill-web issues links. Catalog, metadata, stream listing, HEAD
and OPTIONS stay read-only; consuming a selected media URL with GET submits one
transfer, reused in memory for 60 seconds, and a lost submission response is
never retried. HLS terminal states, and waits past the four-minute pending limit
or an HLS status URL's fifth redirect, redirect to status clips under `/notice/`,
which never call Engine. Engine `401`/`403` becomes the reconnect notice.
[Capacity](./docs/HOSTED.md#capacity) refusals of selected media stay `503`;
`/health`, HEAD, OPTIONS and `/notice/` stay outside the per-link limit.
`mise run hosted:smoke` is fake-only, including its recording. Status clips are
generated at setup/build time; runtime only loads them. Redact credentials from
logs, errors, receipts and recordings, and suppress sensitive paths at ingress.
`mise run hosted:credential` writes the designated account's add-on credential
only to a pipe or an owner-only file for the canary Environment; never echo or
log it.

## Proof map

| Change                                                 | Check                                                                                                                                                                                                                                                             | Runs                                                                                     | Leaves                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docs, config, workflows, protocol and unit logic       | `mise run verify` (Vite+ fmt, lint, types, [tests](./tests); `actionlint`; `zizmor`)                                                                                                                                                                              | local, [CI](./.github/workflows/verify.yml) `verify` on PRs and `main`                   | exit status                                                                                                                                                                         |
| Pushed workflow changes                                | [shared scan](https://github.com/chill-institute/.github/tree/main/.github/actions/scan), last step of [CI](./.github/workflows/verify.yml) `verify`: Actionlint and Zizmor when the pushed range touches workflows; secrets rely on GitHub secret scanning       | CI on push to `main` (pushed range) and dispatch (full history)                          | failed run                                                                                                                                                                          |
| Web playback harness, fixture media, pinned Web client | `mise run fixture:smoke`; HLS: `mise run hls:smoke` ([scope](./docs/HARNESS.md#hls-playback))                                                                                                                                                                     | local, [manual CI](./.github/workflows/playback.yml)                                     | `artifacts/<timestamp>/results.json`, `run-N/` screenshots, failure trace; `artifacts/hls-<timestamp>/results.json`; CI artifact `web-playback-<run_id>`                            |
| Engine-backed adapter                                  | `mise run adapter:smoke` ([scope](./docs/ADAPTER.md#verify))                                                                                                                                                                                                      | local, [manual CI](./.github/workflows/playback.yml)                                     | `artifacts/adapter-<timestamp>/results.json`; CI artifact `web-playback-<run_id>`                                                                                                   |
| Hosted service, credentials, routes, acquisition       | `mise run hosted:smoke`, then `docker build` and `mise run hosted:container` ([release](./docs/HOSTED.md#verification-and-release))                                                                                                                               | local, [manual CI](./.github/workflows/playback.yml), publish `build`                    | `artifacts/hosted-<timestamp>/` receipt and `video/` recording, `artifacts/container-<timestamp>/results.json`; CI artifact `hosted-release-proof-<run_id>`                         |
| Native desktop playback                                | `mise run native:desktop:probe` (client only), `native:desktop:probe hosted` (hosted adapter), `native:desktop:probe hosted-hls` (hosted adapter, HLS media) ([scope](./docs/NATIVE-DESKTOP.md))                                                                  | Linux host, [manual CI](./.github/workflows/native-desktop.yml) runs all three on x86_64 | `artifacts/desktop-<timestamp>/`, `desktop-hosted-<timestamp>/` or `desktop-hosted-hls-<timestamp>/results.json`; CI artifacts `linux-desktop-{fixture,hosted,hosted-hls}-<run_id>` |
| Android TV playback                                    | `mise run native:android:probe`; `native:android:account` with the designated Stremio account ([scope](./docs/NATIVE-ANDROID.md))                                                                                                                                 | Linux host with an accelerated Android TV emulator                                       | `artifacts/android-<timestamp>/results.json` and sanitized `emulator.log`; `artifacts/android-account-<timestamp>/results.json`                                                     |
| Live put.io and production Engine                      | `mise run live:probe`, `adapter:live`, `hosted:live`; deployed endpoint: `hosted:public` with `CHILL_STREMIO_CREDENTIAL` ([LIVE](./docs/LIVE.md), [ADAPTER](./docs/ADAPTER.md#authenticated-playback-probe), [HOSTED](./docs/HOSTED.md#verification-and-release)) | designated accounts; shared allowance                                                    | `artifacts/{live,live-adapter,live-hosted,public}-<timestamp>/results.json`                                                                                                         |
| Deployed adapter after publish                         | [canary](./.github/workflows/canary.yml): `mise run hosted:public` with the `canary` Environment's `CHILL_STREMIO_CREDENTIAL` ([HOSTED](./docs/HOSTED.md#verification-and-release))                                                                               | CI: publish `canary` job at the published commit; manual dispatch from `main`            | CI artifact `hosted-public-<run_id>`                                                                                                                                                |
| Release rules, locked semantic-release                 | `npm ci --prefix .github/release --ignore-scripts`, then `node .github/release/smoke.mjs`                                                                                                                                                                         | local, PR [CI](./.github/workflows/verify.yml)                                           | exit status                                                                                                                                                                         |
| Release and deploy                                     | `main` push tags a release ([`release`](./.github/workflows/verify.yml)); [publish](./.github/workflows/publish-hosted.yml) `build` tests and pushes the image; its `publish` Environment job records the digest and dispatches the Engine deploy                 | CI, publish is manual                                                                    | GitHub release, GHCR digest in release notes, Engine `deploy-stremio.yml` run                                                                                                       |

Gaps:

- Android TV decoded playback, audio, seek/pause and subtitles are unproven; the lane exits `blocked`. Owner: chill-institute/chill-stremio.
- Android TV lanes have no CI or declared remote runner. Owner: operator.
- Playback lanes run in CI only on manual dispatch, so none gates PRs or `main`;
  `hosted:smoke` gates only image publication. Owner: chill-institute/chill-stremio.
- The desktop lane stays on Linux client 1.2.0 because 1.2.2 fails Next Video ([result](./docs/NATIVE-DESKTOP.md#current-linux-result)); status clips are unproven on 1.2.2. Owner: chill-institute/chill-stremio.
- The Web smoke proves the pending clip with a 45-second limit; the four-minute production limit has no browser run. Owner: chill-institute/chill-stremio.
- The desktop lane never reaches the pending clip, which libmpv gets at an HLS status URL's fifth redirect, about 150 seconds in; selecting the release again there submits another transfer. Owner: chill-institute/chill-stremio.
- ARM64 desktop lanes have no CI runner, and their last evidence predates the current GNOME runtime. Owner: operator.
- No macOS or Windows native lane. Owner: chill-institute/chill-stremio.
- `hosted:live` fakes Engine's credential check. The canary proves production
  Engine accepts an issued credential only after a publish or a manual dispatch,
  so Engine deploys between adapter releases go unchecked until the next run. Owner: operator.
- No real-account playback proof through the deployed adapter: `hosted:public`
  and its canary consume no stream, and `hosted:live`'s Stremio Web step has no recorded pass
  since v2.0.0. Owner: chill-institute/chill-stremio.
- CI artifacts expire after 7 days; archive evidence needed longer. Owner: chill-institute/chill-stremio.

## Work and verify

- Keep the primary checkout on `main`.
- Run `mise trust`, `mise install`, then `mise run setup` from a fresh checkout.
- A Web pass does not establish native support.
- The opt-in `native:android:account` lane uses only generated fixture media;
  serialize account addon edits, keep pairing/UI captures in memory, and verify
  exact owned-addon removal.
- For direct put.io validation, follow [LIVE.md](./docs/LIVE.md) and its
  designated-account and allowance boundaries.
- Use `mise run fixture:serve` for a foreground fixture server and
  `mise run cleanup` for cleanup. See [harness guidance](./docs/HARNESS.md)
  for browser setup, fresh-state runs, result files and failure artifacts.
- Keep setup, playback and cleanup exclusive within a checkout. Cleanup
  preserves evidence; use the [handoff and recovery contract](./docs/HARNESS.md#autonomous-handoff)
  when reporting completion or a blocked attempt.
- Run harness TypeScript directly with Node; use explicit `.ts` and type-only
  imports. Vite+ owns static checks and tests in
  [vite.config.ts](./vite.config.ts); use its public `vite-plus/test` imports.
  Mise owns Node and pnpm.
- Use TypeScript for service and harness orchestration. Keep resources scoped,
  deadlines finite, and SDK Promise conversion at the protocol boundary.
- Preserve read-only CI, hooks and organization policy.
- Do not add credentials, sessions, installation registries, provider logic,
  live transfers, deployment or publication to the fixture workflow.
- Do not log credentials or sensitive URLs. Fixture-only artifacts must never
  be reused as a capture policy for a live authenticated account.

## Learning more about Effect

This repository uses the Effect Typescript library, pinned in
[package.json](./package.json) and [pnpm-lock.yaml](./pnpm-lock.yaml).

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

## Evidence

HTTP success and advancing playback time do not establish decoded playback.
Retain structured assertions and useful failure artifacts. Web evidence applies
only to the pinned Web client and tested browser; native desktop, Android TV
and live-account checks require their own proof.
