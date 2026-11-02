# Contributing

TypeScript, Node.js, Effect and the
[Stremio add-on SDK](https://github.com/Stremio/stremio-addon-sdk). Read
[AGENTS.md](./AGENTS.md) for rules and the proof map.

## Setup and verify

Install the [FFmpeg and browser prerequisites](./docs/harness.md#prerequisites),
then run the [setup and verify commands](./AGENTS.md#setup-and-verify).

`mise run fixture:serve` serves fixtures in the foreground; stop it before
`mise run cleanup` ([recovery](./docs/harness.md#results-and-recovery)).

## Delivery

[Release rules](./.releaserc.json) ·
[release check](./.github/release/smoke.mjs) ·
[publishing and rollback](./docs/hosted.md#release).

Code and docs are [MIT licensed](./LICENSE); dependencies and the
[fixture font](./harness/fonts/LICENSE) keep their own licenses.
