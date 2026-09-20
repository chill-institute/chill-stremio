# Agent guide

This repository owns the hosted Stremio adapter for chill.institute. Read
[README.md](./README.md) for commands and [architecture](./docs/ARCHITECTURE.md)
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

## Work and verify

- Preserve unrelated changes. Live checks require the registered executor identity.
- Keep the primary checkout on `main`. Commit verified changes with
  Conventional Commits and push directly when repository policy permits;
  otherwise use a pull request. Monitor the resulting CI.
- Run `mise trust`, `mise install`, then `mise run setup` from a fresh checkout.
- Run `mise run verify` before delivery for deterministic unit and protocol
  checks. `mise run fixture:smoke` exercises the real Web playback harness.
- Native setup, commands and acceptance live in [Android TV](./docs/NATIVE-ANDROID.md)
  and [desktop](./docs/NATIVE-DESKTOP.md). A Web pass does not establish native support.
  `native:desktop:probe hosted` proves the actual hosted adapter in the native
  client; the default fixture mode proves only the client.
  The opt-in `native:android:account` lane uses only generated fixture media;
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
  imports. Vite+ owns static checks and tests in [vite.config.ts](./vite.config.ts); use its public
  `vite-plus/test` imports. Mise owns Node and pnpm.
- Use TypeScript for service and harness orchestration. Keep resources scoped,
  deadlines finite, and SDK Promise conversion at the protocol boundary.
- Run `actionlint` and `zizmor .github/workflows` after workflow changes.
  Preserve read-only CI, hooks and organization policy.
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
and live-account checks require their own proof. Report unavailable checks
without presenting them as passes.
