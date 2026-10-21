# Agent guide

The hosted Stremio add-on for chill.institute; it translates Stremio requests
into Engine calls and keeps no state. Read [architecture](./docs/architecture.md)
before moving boundaries and [hosted](./docs/hosted.md) for runtime and release.

## Setup and verify

Install the [harness prerequisites](./docs/harness.md#prerequisites) first.

```sh
mise trust && mise install && mise run setup
mise run verify
mise run fixture:smoke
```

## Hazards

- Never print, log or commit credentials, add-on links, installation receipts
  or signed media URLs; redact them from logs, errors, receipts and recordings.
- Fixture lanes stay credential-free: no credentials, sessions, provider logic,
  live transfers, deployment or publication.
- Live lanes use only the designated test accounts, never Engine or production
  tokens, within the [shared allowance](./docs/live.md#credential-and-budget).
- Fixture screenshot and recording policy never applies to a live account.
- Only GET on selected media writes; a lost transfer submission is never retried.
- Lanes that edit a Stremio account's add-ons run alone and remove only their
  own descriptor.
- Keep the README, `/configure` and
  [manifest-descriptions.ts](./src/manifest-descriptions.ts) in step.
- HTTP success or advancing time is not decoded playback; a Web pass does not
  prove native support. Keep setup, playback and cleanup exclusive per checkout.

## Proof map

| Change                                           | Check                                                                                | Runs                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | ---------------------------------- |
| Docs, config, workflows, logic                   | `mise run verify`                                                                    | local, `verify.yml`                |
| Release rules                                    | `npm ci --prefix .github/release --ignore-scripts && node .github/release/smoke.mjs` | local, `verify.yml`                |
| [Web harness](./docs/harness.md), media, Web pin | `mise run fixture:smoke`; `mise run hls:smoke`                                       | local, manual `playback.yml`       |
| [Local adapter](./docs/adapter.md)               | `mise run adapter:smoke`                                                             | local, manual `playback.yml`       |
| Hosted service                                   | `mise run hosted:smoke`, then [image checks](./docs/hosted.md#release)               | local, manual CI, publish          |
| [Native desktop](./docs/native-desktop.md)       | `mise run native:desktop:probe [hosted\|hosted-hls]`                                 | Linux, manual `native-desktop.yml` |
| [Android TV](./docs/native-android.md)           | `mise run native:android:probe`; `native:android:account`                            | Linux host with KVM                |
| Live put.io, production Engine                   | [live lanes](./docs/live.md#lanes)                                                   | designated accounts                |
| Release and deploy                               | [release and rollback](./docs/hosted.md#release)                                     | CI; publish is manual              |

Gaps:

- Playback lanes run in CI only on manual dispatch; run the affected lane,
  including for [Renovate](./renovate.json) updates to playback dependencies.
- Android TV playback is unproven and its lanes exit `blocked`.
- Engine deploys go unchecked until the next canary; dispatch it after one.
- CI artifacts expire after 7 days; archive evidence you need.

## Code

- Run harness TypeScript with Node; use explicit `.ts` and type-only imports.
- Vite+ owns checks and tests ([vite.config.ts](./vite.config.ts)); import
  from `vite-plus/test`. Keep resources scoped and deadlines finite.
- Effect is pinned in [package.json](./package.json). Before writing Effect
  code, read `node_modules/effect/AGENTS.md`; search `node_modules/effect/src`.
