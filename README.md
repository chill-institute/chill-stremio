# chill-stremio

A Stremio add-on for [chill.institute](https://chill.institute): discover titles,
choose releases, download to put.io and play inside Stremio. The adapter and its
credential-free playback harness use TypeScript, Node.js, Effect and the
[official add-on SDK](https://github.com/Stremio/stremio-addon-sdk).

## Hosted adapter

The hosted adapter is in early access at `https://stremio.chill.institute`,
labelled work in progress in Stremio and on the setup page. HLS with audio-track
switching passes a real put.io Web probe. The full generated hosted HLS flow
also passes with the compatible fixture layout described in
[HLS playback](./docs/HARNESS.md#hls-playback). The focused Linux HLS probe passes
automatic playback and visible captions. The broader native regression still
has MP4 reopening and terminal-state failures. Android TV and
macOS/Windows remain unverified. See the current [desktop](./docs/NATIVE-DESKTOP.md)
and [Android TV](./docs/NATIVE-ANDROID.md) evidence and limitations.

The [public add-on manifest](https://stremio.chill.institute/manifest.json)
opens account setup through Stremio’s **Configure** action. Connect once, then
choose **install chill**. Setup is also available at
[chill.institute/stremio](https://chill.institute/stremio). **put.io library** includes
videos across your put.io library, including subfolders.
Browse, search, select releases to download to put.io, check progress and play
inside Stremio. The hosted process owns encrypted, revocable installations and calls
existing generic Engine APIs. See [hosted setup, recovery and rollout](./docs/HOSTED.md).
`mise run hosted:serve` runs the service; `mise run hosted:smoke` exercises the
fixture discovery/acquisition/playback flow and records a credential-free demo.

## Local Engine-backed adapter

Run `CHILL_FOLDER_ID=0 mise run adapter:serve` with your regular `CHILL_TOKEN`
in a private process environment. Install the manifest URL from the owner-only
`.cache/adapter/install.json` file. The process stays on loopback and exposes one
folder; see [adapter setup and limits](./docs/ADAPTER.md).

`mise run adapter:smoke` proves installation, catalog and decoded playback through
a local generated Engine fixture in the real Stremio Web client. It makes no
live provider calls.
`mise run adapter:live` runs the authenticated Web flow with maintainer test
accounts; see [live adapter setup](./docs/ADAPTER.md#authenticated-playback-probe).

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
# Stop the foreground server with Ctrl-C, then clean generated runtime state.
mise run cleanup
```

Native and live probes have separate runner and account prerequisites. Follow
[Android TV](./docs/NATIVE-ANDROID.md), [desktop](./docs/NATIVE-DESKTOP.md), or
[live put.io](./docs/LIVE.md) before selecting those lanes. Desktop probing
requires the fixture setup stamp; rerun setup if cleanup removed it.
`mise run native:desktop:probe hosted` drives the actual hosted adapter in the
native client with generated Engine responses.

A successful smoke run reports `passed` for two fresh browser runs and writes
`artifacts/<run timestamp>/results.json`. See
[playback assertions and results](./docs/HARNESS.md#playback-proof) to interpret
the evidence, and [recovery](./docs/HARNESS.md#results-and-recovery) after failure.

Harness entrypoints run directly with Node's native TypeScript support. Vite+
owns formatting, linting, type checks and tests in
[vite.config.ts](./vite.config.ts); mise owns Node and pnpm locally and in CI.
For implementation rules, read [AGENTS.md](./AGENTS.md). For adapter, Engine and
shared-schema responsibilities, read [architecture](./docs/ARCHITECTURE.md).

## Verification and delivery

[Verification CI](./.github/workflows/verify.yml) runs the deterministic gate
for contributions and updates to `main`. The
[Web playback workflow](./.github/workflows/playback.yml) is manually dispatched
to bound runner cost. [Renovate configuration](./renovate.json) selects the
playback-sensitive dependencies that require review and fresh browser evidence.

Native and live checks require their own proof; Web playback does not establish
native support. Use [desktop setup](./docs/NATIVE-DESKTOP.md),
[Android SDK/KVM setup](./docs/NATIVE-ANDROID.md), or the
[designated-account live lane](./docs/LIVE.md). Setup alone is not a playback pass.

## License

Original code and documentation are [MIT licensed](./LICENSE). Third-party
dependencies retain their own licenses.
