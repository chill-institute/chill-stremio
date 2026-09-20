import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function generateHls(
  directory: string,
  source = ".cache/media/movie.mp4",
  packaging: "muxed-ts" | "separate-fmp4" = "muxed-ts",
) {
  const separate = packaging === "separate-fmp4";
  await mkdir(directory, { recursive: true });
  const common = ["-hide_banner", "-loglevel", "error", "-y"];
  const hls = [
    "-f",
    "hls",
    "-hls_time",
    "2",
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    separate ? "fmp4" : "mpegts",
  ];
  await execute(
    "ffmpeg",
    [
      ...common,
      "-i",
      source,
      ...(separate
        ? ["-an"]
        : [
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=36",
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-shortest",
          ]),
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-g",
      "48",
      "-sc_threshold",
      "0",
      ...hls,
      ...(separate ? ["-hls_fmp4_init_filename", "video-init.mp4"] : []),
      join(directory, "video.m3u8"),
    ],
    { timeout: 60000 },
  );
  await execute(
    "ffmpeg",
    [
      ...common,
      "-i",
      source,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=36",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=880:sample_rate=48000:duration=36",
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-map",
      "2:a:0",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-metadata:s:a:0",
      "language=eng",
      "-metadata:s:a:1",
      "language=spa",
      "-t",
      "36",
      "-movflags",
      "+faststart",
      join(directory, "multi-audio.mp4"),
    ],
    { timeout: 60000 },
  );
  for (const [name, frequency] of [
    ["english", 440],
    ["spanish", 880],
  ] as const) {
    await execute(
      "ffmpeg",
      [
        ...common,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=${frequency}:sample_rate=48000:duration=36`,
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        ...hls,
        ...(separate ? ["-hls_fmp4_init_filename", `${name}-init.mp4`] : []),
        join(directory, `${name}.m3u8`),
      ],
      { timeout: 60000 },
    );
    await writeFile(
      join(directory, `${name}.vtt`),
      await readFile(`.cache/media/${name}.vtt`),
    );
  }
  await writeFile(
    join(directory, "master.m3u8"),
    [
      "#EXTM3U",
      "#EXT-X-VERSION:3",
      `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English 440 Hz",LANGUAGE="eng",DEFAULT=YES,AUTOSELECT=YES${separate ? ',URI="english.m3u8"' : ""}`,
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Spanish 880 Hz",LANGUAGE="spa",DEFAULT=NO,AUTOSELECT=YES,URI="spanish.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.42c01e,mp4a.40.2",RESOLUTION=640x360,AUDIO="audio"',
      "video.m3u8",
      "",
    ].join("\n"),
  );
  const files = await readdir(directory);
  return Promise.all(
    files.sort().map(async (file) => ({
      file,
      sha256: createHash("sha256")
        .update(await readFile(join(directory, file)))
        .digest("hex"),
    })),
  );
}

export async function startHlsFixture(directory: string) {
  const files = new Set(await readdir(directory));
  const requests: string[] = [];
  let origin = "";
  const meta = {
    id: "fixture:hls",
    type: "movie",
    name: "HLS Fixture",
    behaviorHints: { defaultVideoId: "fixture:hls" },
  };
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Access-Control-Allow-Origin", "*");
      response.setHeader("Cache-Control", "no-store");
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      requests.push(path);
      const file = path.slice("/media/".length);
      if (path.startsWith("/media/") && files.has(file)) {
        response.setHeader(
          "Content-Type",
          file.endsWith(".m3u8")
            ? "application/vnd.apple.mpegurl"
            : file.endsWith(".vtt")
              ? "text/vtt"
              : file.endsWith(".ts")
                ? "video/mp2t"
                : "video/mp4",
        );
        response.end(await readFile(join(directory, file)));
        return;
      }
      response.setHeader("Content-Type", "application/json");
      if (path === "/manifest.json")
        response.end(
          JSON.stringify({
            id: "institute.chill.hls-fixture",
            version: "0.1.0",
            name: "Chill HLS Fixture",
            description: "Generated multi-audio playback proof",
            resources: ["catalog", "meta", "stream"],
            types: ["movie"],
            idPrefixes: ["fixture:"],
            catalogs: [{ type: "movie", id: "hls", name: "HLS Fixtures" }],
          }),
        );
      else if (path.startsWith("/catalog/"))
        response.end(JSON.stringify({ metas: [meta] }));
      else if (path.startsWith("/meta/"))
        response.end(JSON.stringify({ meta }));
      else if (path.startsWith("/stream/"))
        response.end(
          JSON.stringify({
            streams: [
              {
                name: "HLS multi-audio",
                url: `${origin}/media/master.m3u8`,
                subtitles: ["english", "spanish"].map((name) => ({
                  id: name,
                  lang: name === "english" ? "eng" : "spa",
                  url: `${origin}/media/${name}.vtt`,
                })),
              },
            ],
          }),
        );
      else response.writeHead(404).end();
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No HLS fixture address");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
