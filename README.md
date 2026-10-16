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
  A video put.io must convert first, such as most `.mkv` files, offers
  **Convert and play from put.io**: selecting it asks put.io to prepare the
  video and shows a short clip. While put.io converts it, the video lists
  **Play from put.io** instead, which shows the same clip until put.io is
  done; then it lists and plays as usual.
- Browse movies and shows, search **Releases**, or open a movie or episode to
  see chill release results.
- A movie or episode already in your put.io account lists up to ten
  **Play from put.io** sources first, which play the video without
  downloading again. Videos named differently from the title, such as without
  its year, may not appear; open them from **put.io library**.
- Select **Download to put.io** on a release. Playback waits for the download
  and starts when a single video is ready. If the download fails, needs a file
  choice or is still running after a few minutes, the player shows a short
  clip that says what to do next. Completed downloads appear in
  **put.io library**, where you can choose files from multi-file downloads.
  Selecting the same release again reuses its put.io download unless that
  download failed or was deleted.
- An episode can also offer **Download season to put.io**, which downloads the
  season pack and plays that episode once the download finishes. The season's
  other episodes then appear in **put.io library**.

Supported clients are Stremio Web, tested in Chromium, and Stremio for Linux,
tested with the Flathub app 1.2.0 on x86_64; app 1.2.2 failed Next Video
testing. Other Stremio apps, including Android TV, macOS and Windows, are
unverified; see [desktop support](./docs/NATIVE-DESKTOP.md) and
[Android TV support](./docs/NATIVE-ANDROID.md) before relying on them.

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
