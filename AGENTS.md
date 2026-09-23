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
registered executor and allowance; see [ADAPTER.md](./docs/ADAPTER.md#authenticated-playback-probe).
`mise run adapter:smoke` proves the actual adapter against a generated local
Engine in the pinned Web client; preserve fake-only capture and cleanup proof.

## Hosted release

`mise run hosted:serve` owns durable multi-user installation and acquisition
state. Read [HOSTED.md](./docs/HOSTED.md) before changing authorization, storage
or rollout. `mise run hosted:smoke` is fake-only, including its recording.
Management requires a verified ordinary chill bearer. Installation capabilities
delegate library playback and chosen-release downloads. Catalog, metadata, stream
listing, HEAD and OPTIONS stay read-only; consuming a selected media URL with GET
may commit a download. Preserve durable unknown acquisition claims after
interrupted submission. Never repeat AddTransfer on an unknown outcome.
Status clips are generated at setup/build time; runtime only loads them. Storage
v2 preserves existing claims; do not roll it back to an unsupported v1 image.
Keep keys and backups private, and suppress sensitive paths at ingress.

## Proof map

| Change                                                 | Check                                                                                                                                                                                                                             | Runs                                                                         | Leaves                                                                                                                                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docs, config, workflows, protocol and unit logic       | `mise run verify` (Vite+ fmt, lint, types, [tests](./tests); `actionlint`; `zizmor`)                                                                                                                                              | local, [CI](./.github/workflows/verify.yml) `verify` on PRs and `main`       | exit status                                                                                                                                                 |
| Web playback harness, fixture media, pinned Web client | `mise run fixture:smoke`; HLS: [`hls-smoke.ts`](./docs/HARNESS.md#hls-playback)                                                                                                                                                   | local, [manual CI](./.github/workflows/playback.yml)                         | `artifacts/<timestamp>/results.json`, `run-N/` screenshots, failure trace; CI artifact `web-playback-<run_id>`                                              |
| Engine-backed adapter                                  | `mise run adapter:smoke` ([scope](./docs/ADAPTER.md#verify))                                                                                                                                                                      | local                                                                        | `artifacts/adapter-<timestamp>/results.json`                                                                                                                |
| Hosted service, authorization, storage, acquisition    | `mise run hosted:smoke`, then `docker build` and `mise run hosted:container` ([release](./docs/HOSTED.md#verification-and-release))                                                                                               | local, [publish](./.github/workflows/publish-hosted.yml) before image push   | `artifacts/hosted-<timestamp>/` receipt and `video/` recording, `artifacts/container-<timestamp>/results.json`; CI artifact `hosted-release-proof-<run_id>` |
| Native desktop playback                                | `mise run native:desktop:probe` (client only), `native:desktop:probe hosted` (hosted adapter) ([scope](./docs/NATIVE-DESKTOP.md))                                                                                                 | Linux host, [manual CI](./.github/workflows/native-desktop.yml) fixture mode | `artifacts/desktop-<timestamp>/` or `desktop-hosted-<timestamp>/results.json`; CI artifact `linux-desktop-<run_id>`                                         |
| Android TV playback                                    | `mise run native:android:probe`; `native:android:account` with the designated Stremio account ([scope](./docs/NATIVE-ANDROID.md))                                                                                                 | Linux host with an accelerated Android TV emulator                           | `artifacts/android-<timestamp>/results.json` and sanitized `emulator.log`; `artifacts/android-account-<timestamp>/results.json`                             |
| Live put.io and production Engine                      | `mise run live:probe`, `adapter:live`, `hosted:live`; deployed endpoint: `hosted:public` ([LIVE](./docs/LIVE.md), [ADAPTER](./docs/ADAPTER.md#authenticated-playback-probe), [HOSTED](./docs/HOSTED.md#verification-and-release)) | registered executor only; designated accounts; shared allowance              | `artifacts/{live,live-adapter,live-hosted,public}-<timestamp>/results.json`                                                                                 |
| Release and deploy                                     | `main` push tags a release ([`release`](./.github/workflows/verify.yml)); [publish](./.github/workflows/publish-hosted.yml) builds, pushes and dispatches the Engine deploy                                                       | CI, publish is manual                                                        | GitHub release, GHCR digest in release notes, Engine `deploy-stremio.yml` run                                                                               |

Gaps:

- Android TV decoded playback, audio, seek/pause and subtitles are unproven; the lane exits `blocked`. Owner: chill-institute/chill-stremio.
- Android TV lanes have no CI or declared remote runner. Owner: operator.
- `adapter:smoke` has no CI workflow. Owner: chill-institute/chill-stremio.
- No macOS or Windows native lane. Owner: chill-institute/chill-stremio.

## Work and verify

- Live checks require the registered executor identity.
- Keep the primary checkout on `main`.
- Run `mise trust`, `mise install`, then `mise run setup` from a fresh checkout.
- A Web pass does not establish native support.
- The opt-in `native:android:account` lane uses only generated fixture media;
  serialize account addon edits, keep pairing/UI captures in memory, and verify
  exact owned-addon removal.
- For direct put.io validation, follow [LIVE.md](./docs/LIVE.md) and its
  designated-account, sole-executor and allowance boundaries.
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
