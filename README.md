# chill-stremio

![chill.institute stremio](https://chill.institute/banner.png)

The Stremio add-on for [chill.institute](https://chill.institute). Browse
movies and TV shows, download releases to put.io, and play your put.io library
inside Stremio.

## Install

1. Open [setup](https://stremio.chill.institute/configure).
2. Connect your put.io account through chill.institute.
3. Select **install chill**.

Your add-on link opens your library and starts downloads; keep it private. If
the add-on shows **Reconnect chill.institute**, install it again from
[chill.institute/stremio](https://chill.institute/stremio).

## Use

- **Discover → put.io library** lists every video in your account. A video
  put.io must convert first, such as most `.mkv` files, offers **Convert and
  play from put.io**: the player waits a few minutes while put.io prepares it,
  then plays it without subtitles until you open it again. If put.io takes
  longer, a short clip plays and the video lists **Play from put.io**, which
  waits again.
- Movie and episode pages list videos you already have as **Play from put.io**,
  then chill release results.
- **Download to put.io** downloads a release and plays it when one video is
  ready; an episode can also offer **Download season to put.io**. If playback
  can't start, a short clip says what to do next.

Supported clients are Stremio Web and Stremio for Linux (Flathub 1.2.0,
x86_64). Other Stremio apps are unverified.

## Develop

See [contributing](./CONTRIBUTING.md). Docs:
[hosted service](./docs/hosted.md), [local adapter](./docs/adapter.md),
[architecture](./docs/architecture.md), [harness](./docs/harness.md).

[MIT License](./LICENSE)
