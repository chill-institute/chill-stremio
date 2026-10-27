# Hosted adapter

The multi-user add-on at `https://stremio.chill.institute`. Behaviour lives in
[hosted.ts](../src/hosted.ts), [selection.ts](../src/selection.ts) and
[admission.ts](../src/admission.ts); the hosted suites
(`tests/hosted*.test.ts`) pin it. For isolated single-user probes, use the
[local adapter](./adapter.md).

## Run

```sh
CHILL_PUBLIC_ORIGIN=http://127.0.0.1:7000 mise run hosted:serve
```

[hosted-run.ts](../src/hosted-run.ts) owns the configuration schema.
`CHILL_PUBLIC_ORIGIN` must be the exact external origin. Set
`CHILL_LISTEN_HOST=0.0.0.0` only behind the HTTPS ingress.
`CHILL_WEB_ORIGIN` and `CHILL_ENGINE_BASE_URL` override the production web and
Engine origins. `GET /health` reports process liveness only, not capacity or
Engine reachability. Run the
[Dockerfile](../Dockerfile) image with a read-only root filesystem, no
capabilities and no volume; `hosted:container` checks that shape.

## Hazards

- **Ingress logging.** Paths carry the add-on credential and playback URLs are
  provider grants. Suppress ingress access logs for this service, and add no
  request capture, analytics or third-party scripts to add-on or playback
  surfaces.
- **Personal links.** Anyone with an add-on link can browse, play and start
  downloads, and Stremio prints the full link in its install dialog. Submit
  only the public `https://stremio.chill.institute/manifest.json` to
  Stremio's
  [publishing form](https://stremio.github.io/stremio-publish-addon/index.html).
- **Deploys.** Waits are remembered only in process, so a deploy ends any
  Stremio Web wait older than about 90 seconds with a player error; the user
  selects the row again.

## Release

```sh
mise run verify
mise run hosted:smoke
docker build -t chill-stremio:release-candidate .
mise run hosted:container
```

- Read the `hosted:smoke` receipt before claiming playback or cleanup. Its
  recording is shareable only because the lane is fake.
- Publish by dispatching
  [Publish hosted adapter](../.github/workflows/publish-hosted.yml) from
  `main`; the workflow owns the build, deploy dispatch and canary.
- **Rollback:** dispatch Engine's deploy with an earlier image digest. Any
  v2.0.3+ image works; v2.0.0–v2.0.2 reject every issued link. A release older
  than the canary fails its canary job, so dispatch the canary from `main`
  instead.
- The `chill-stremio` package must grant `chill-engine` read access in its
  Actions access settings; GitHub has no API for it.

### Canary credential

[canary.yml](../.github/workflows/canary.yml) reads `CHILL_STREMIO_CREDENTIAL`
from the `canary` Environment. Keep repository and organization secrets out of
this repo; the canary runs repository code.

Mint with the designated account's [environment](./live.md#setup):

```sh
credential="$(mktemp)"
mise run hosted:credential > "$credential" &&
  gh secret set CHILL_STREMIO_CREDENTIAL --env canary -R chill-institute/chill-stremio < "$credential"
rm -f "$credential"
```

- `409 download_folder_missing`: give the account a download folder first.
- **Rotate** after any exposure, before Engine retires the signing key, or
  when the canary reports `Engine rejected the credential`. As the designated
  account, choose **disconnect Stremio** at `https://chill.institute/stremio`,
  then mint again.
- A `season-downloads` or `owned-videos` canary failure means Engine does not
  grant that RPC to add-on credentials; a new credential won't fix it.
