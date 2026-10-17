# Contributing

TypeScript, Node.js, Effect and the
[Stremio add-on SDK](https://github.com/Stremio/stremio-addon-sdk). Read
[AGENTS.md](./AGENTS.md) for rules and the proof map.

## Setup and verify

Install the [FFmpeg and browser prerequisites](./docs/harness.md#prerequisites),
then:

```sh
mise trust && mise install && mise run setup
mise run verify
mise run fixture:smoke
```

`mise run fixture:serve` serves fixtures in the foreground; after Ctrl-C,
`mise run cleanup` removes generated state and keeps `artifacts/`. Run the
affected playback lane when playback behavior changes, including
[Renovate](./renovate.json) updates to playback-sensitive dependencies.

## Delivery

Use Conventional Commits. Push verified changes directly when repository rules
permit; otherwise open a pull request. The commit-analyzer `releaseRules` in
[.releaserc.json](./.releaserc.json) decide what releases from `main`;
[smoke.mjs](./.github/release/smoke.mjs) fails when they drift from the other
chill.institute packages. Publishing and rollback:
[hosted release](./docs/hosted.md#release).

Code and docs are [MIT licensed](./LICENSE); dependencies and the
[fixture font](./harness/fonts/LICENSE) keep their own licenses.
