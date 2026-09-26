# Contributing

The adapter and playback harness use TypeScript, Node.js, Effect and the
[Stremio add-on SDK](https://github.com/Stremio/stremio-addon-sdk).
Read the [architecture](./docs/ARCHITECTURE.md) for adapter, Engine and
shared-schema responsibilities, and [AGENTS.md](./AGENTS.md) for implementation
rules.

## Local workflow

Install the [FFmpeg and browser prerequisites](./docs/HARNESS.md#prerequisites),
then use the toolchain pinned in [mise.toml](./mise.toml):

```sh
mise trust
mise install
mise run setup
mise run verify
mise run fixture:smoke
mise run fixture:serve
```

Stop the foreground server with Ctrl-C, then run `mise run cleanup` to remove
generated runtime state. Cleanup preserves evidence.

A successful fixture smoke reports `passed` for two fresh browser runs and
writes `artifacts/<run timestamp>/results.json`. See
[playback assertions](./docs/HARNESS.md#playback-proof) to interpret the evidence
and [recovery](./docs/HARNESS.md#results-and-recovery) after a failure.

Harness entrypoints run directly with Node's native TypeScript support. Vite+
owns formatting, linting, type checks and tests in
[vite.config.ts](./vite.config.ts); mise owns Node and pnpm locally and in CI.

## Adapter checks

`mise run adapter:smoke` tests installation, catalog and decoded playback against
a generated local Engine fixture. `mise run hosted:smoke` exercises the hosted
discovery, acquisition and playback flow and records a demo. Both use fake
credentials and make no live provider calls.

To run a service locally, follow the
[Engine-backed adapter setup](./docs/ADAPTER.md#run) or
[hosted service setup](./docs/HOSTED.md#run-on-linux).

Native and live checks have separate runner and account prerequisites:

- [Desktop](./docs/NATIVE-DESKTOP.md): `mise run native:desktop:probe hosted`
  drives the hosted adapter in the native client with generated Engine responses.
  It requires the fixture setup stamp; rerun setup if cleanup removed it.
- [Android TV](./docs/NATIVE-ANDROID.md): emulator setup, playback checks and
  account cleanup.
- [Live put.io](./docs/LIVE.md): designated test account, allowance and recovery requirements.
- [Authenticated adapter](./docs/ADAPTER.md#authenticated-playback-probe): the Web
  flow through Engine with maintainer test accounts.

Web playback does not establish native support. Setup alone is not a playback pass.

## Verification and delivery

Run `mise run verify` before delivery. It checks formatting, lint, types,
unit and protocol behavior, and workflows. Use the affected playback lane
when changing playback behavior.

[Verification CI](./.github/workflows/verify.yml) runs on contributions and
updates to `main`. The [Web playback workflow](./.github/workflows/playback.yml)
is manually dispatched to bound runner cost.
[Renovate configuration](./renovate.json) identifies playback-sensitive
dependencies that require review and fresh browser evidence.

Use Conventional Commits. Push verified changes directly when repository rules
permit; otherwise open a pull request.

Only `feat` (minor), `fix`, `perf`, `refactor`, `revert` (patch) and breaking
(major) commits release from `main`; `docs`, `test`, `build`, `ci`, `chore`
and `deps` do not. The rule set is the commit-analyzer `releaseRules` in
[`.releaserc.json`](./.releaserc.json), identical in every chill.institute
package repo; [`smoke.mjs`](./.github/release/smoke.mjs) fails when it drifts.

Original code and documentation are [MIT licensed](./LICENSE). Third-party
dependencies retain their own licenses.
