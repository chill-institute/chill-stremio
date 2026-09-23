# chill-stremio

![chill.institute stremio](https://chill.institute/banner.png)

The Stremio add-on for [chill.institute](https://chill.institute). Browse movies
and TV shows, choose releases to download to put.io, and play your library
inside Stremio.

## Install

1. Open [setup](https://stremio.chill.institute/configure).
2. Connect your put.io account through chill.institute.
3. Select **install chill** to add it to Stremio.

Your add-on link gives access to your library and downloads. Keep it private.
If the add-on shows **Reconnect chill.institute**, open
[chill.institute/stremio](https://chill.institute/stremio) and install it again.
For a public listing, use the [public manifest](https://stremio.chill.institute/manifest.json).

## Use

- Open **Discover → put.io library** to browse videos across your account,
  including subfolders. Stremio's **Library** tab is for items saved in Stremio.
- Browse movies and shows, search **Releases**, or open a movie or episode to
  see chill release results.
- Select **Download to put.io** on a release. Playback waits for the download
  and starts when a single video is ready. Completed downloads appear in
  **put.io library**, where you can choose files from multi-file downloads.
  Selecting the same release again later starts another download.

The add-on is in early access. Web HLS playback, subtitles and audio switching
have been tested. Focused Linux HLS playback passes, but the broader desktop
checks still fail on MP4 reopening and terminal states. macOS, Windows and
Android TV playback remain unverified. See [desktop support](./docs/NATIVE-DESKTOP.md)
and [Android TV support](./docs/NATIVE-ANDROID.md) before relying on those clients.

## Develop

Install the [FFmpeg and browser prerequisites](./docs/HARNESS.md#prerequisites),
then run:

```sh
mise trust
mise install
mise run setup
mise run verify
mise run fixture:smoke
```

The fixture harness uses generated media and needs no account credentials.
See [contributing](./CONTRIBUTING.md) for local servers, checks and cleanup.

## Read

- [Hosted setup and recovery](./docs/HOSTED.md)
- [Local Engine-backed adapter](./docs/ADAPTER.md)
- [Architecture](./docs/ARCHITECTURE.md)
- [Playback harness](./docs/HARNESS.md)

[Contributing](./CONTRIBUTING.md) · [MIT License](./LICENSE)
