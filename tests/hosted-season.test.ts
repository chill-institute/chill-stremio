import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { test, vi } from "vite-plus/test";
import {
  episodeRows,
  episodeTarget,
  fixture,
  location,
  packEpisodes,
  packSelection,
  parsedReleaseLink,
  releaseSelection,
  seasonPack,
  target,
  timedEpisodeRows,
  until,
} from "./support/hosted-fixture.ts";

// Poll pending playback quickly; its window and continuation limits stay real.
vi.mock("../src/playback-wait.ts", async (original) => {
  const actual = await original<typeof import("../src/playback-wait.ts")>();
  return {
    ...actual,
    playbackWait: { ...actual.playbackWait, pollMs: 20, ownedPollMs: 20 },
  };
});

test("an episode lists Engine's season pack after its releases", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    assert.deepEqual(await episodeRows(f), [
      {
        name: "Download to put.io",
        title: "Independent.Film.1080p\nFixture · 3 seeders · 12.06 KiB",
        url: `${f.base()}/play/series/${encodeURIComponent(episodeTarget)}/fixture-release.m3u8`,
      },
      {
        name: "Download season to put.io",
        title: "Season 1 pack · 1080p x264 WEB\nFixture · 5 seeders · 2.00 GiB",
        url: packSelection(f),
      },
    ]);
    f.state.seasonPack = {
      ...seasonPack,
      resolution: "",
      codec: "",
      quality: "",
    };
    assert.equal(
      (await episodeRows(f))[1]?.title,
      "Season 1 pack\nFixture · 5 seeders · 2.00 GiB",
    );
    f.state.seasonPack = { ...seasonPack, id: "fixture-release" };
    assert.deepEqual(
      (await episodeRows(f)).map(({ name }) => name),
      ["Download to put.io"],
      "A pack Search already lists appears once",
    );
    f.state.seasonPack = seasonPack;
    f.state.extraReleases = 100;
    const capped = await episodeRows(f);
    assert.equal(capped.length, 101, "100 episode releases and the pack");
    assert.equal(capped.at(-1)?.name, "Download season to put.io");
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("an episode leaves out releases parsed as other episodes, which its play URLs still select", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    f.state.parsedReleases = [
      { id: "other-season", releaseInfo: { season: 9, episode: 2 } },
      { id: "other-episode", releaseInfo: { season: 1, episode: 3 } },
      {
        id: "episode-range",
        releaseInfo: { season: 1, episode: 1, episodeEnd: 3 },
      },
      { id: "season-pack-release", releaseInfo: { season: 1 } },
    ];
    const play = (id: string) =>
      `${f.base()}/play/series/${encodeURIComponent(episodeTarget)}/${id}.m3u8`;
    assert.deepEqual(
      (await episodeRows(f)).map(({ name, url }) => [name, url]),
      [
        ["Download to put.io", play("fixture-release")],
        ["Download to put.io", play("episode-range")],
        ["Download to put.io", play("season-pack-release")],
        ["Download season to put.io", packSelection(f)],
      ],
    );
    assert.equal(f.state.addCount, 0);
    assert.equal(
      await location(play("other-season")),
      `${f.base()}/notice/select-file.m3u8`,
      "The multi-file download was submitted",
    );
    assert.deepEqual(f.state.addUrls, [parsedReleaseLink("other-season")]);
  } finally {
    await f.close();
  }
});

test("a season lookup Engine refuses or never answers leaves the episode rows", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    f.state.seasonRejection = { status: 403, code: "procedure_not_allowed" };
    assert.deepEqual(
      (await episodeRows(f)).map(({ name }) => name),
      ["Download to put.io"],
    );
    f.state.seasonRejection = undefined;
    f.state.stallSeasonPack = true;
    const { names, elapsedMs } = await timedEpisodeRows(f);
    assert.deepEqual(names, ["Download to put.io"]);
    assert.ok(elapsedMs < 5_500, `${elapsedMs} ms`);
    await until(() => f.state.abandonedSeasonLookups === 1);
  } finally {
    await f.close();
  }
});

test("a season lookup slower than the episode search still lists its pack", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    // The pack answers after the search, but before the grace that follows it ends.
    f.state.engineDelayMs = 500;
    f.state.seasonDelayMs = 750;
    assert.deepEqual((await timedEpisodeRows(f)).names, [
      "Download to put.io",
      "Download season to put.io",
    ]);
  } finally {
    await f.close();
  }
});

test("a cold season lookup still lists its pack within five seconds of the request", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    // Search answers at once; Engine's cold season lookup takes four seconds.
    f.state.seasonDelayMs = 4_000;
    const cold = await timedEpisodeRows(f);
    assert.deepEqual(cold.names, [
      "Download to put.io",
      "Download season to put.io",
    ]);
    assert.ok(cold.elapsedMs < 5_500, `${cold.elapsedMs} ms`);
    f.state.seasonDelayMs = 0;
    const warm = await timedEpisodeRows(f);
    assert.deepEqual(warm.names, cold.names);
    assert.ok(warm.elapsedMs < 1_000, `${warm.elapsedMs} ms`);
  } finally {
    await f.close();
  }
});

test("a season lookup slower than five seconds is left out", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    f.state.seasonDelayMs = 7_000;
    const { names, elapsedMs } = await timedEpisodeRows(f);
    assert.deepEqual(names, ["Download to put.io"]);
    assert.ok(elapsedMs < 5_500, `${elapsedMs} ms`);
  } finally {
    await f.close();
  }
});

test("a season pack plays the one video Engine names as the requested episode", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    f.state.folders.set(20n, [
      ...packEpisodes,
      {
        id: 23n,
        name: "Season file two.sample.mkv",
        fileType: "VIDEO",
        releaseInfo: { season: 1, episode: 2 },
      },
    ]);
    assert.equal(
      await location(packSelection(f)),
      "https://media.fixture.test/video-22?token=fixture-playback-secret",
    );
    assert.equal(f.state.addCount, 1);
    const flagged = (id: bigint) =>
      f.listings.filter((listing) => listing.id === id && listing.releaseInfo)
        .length;
    assert.equal(flagged(10n), 0, "The destination listing");
    assert.equal(flagged(20n), 1, "The download's own listing");
    f.listings.length = 0;
    assert.equal(
      await location(`${f.base()}/status/90.m3u8`),
      `${f.base()}/notice/select-file.m3u8`,
      "The same download selected by its episode release",
    );
    assert.equal(flagged(20n), 0);
    assert.equal(
      await location(`${f.base()}/status/90/1/2.m3u8`),
      "https://media.fixture.test/video-22?token=fixture-playback-secret",
    );
  } finally {
    await f.close();
  }
});

test("a season pack put.io is still completing waits for its files instead of playing unavailable", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    // put.io names the download's folder before it moves the files in.
    f.state.transferStatus = "COMPLETING";
    f.state.folders.set(20n, []);
    let responded = false;
    const status = location(`${f.base()}/status/90/1/2.m3u8`).then((url) => {
      responded = true;
      return url;
    });
    await sleep(300);
    assert.equal(responded, false);
    f.state.transferStatus = undefined;
    f.state.folders.set(20n, packEpisodes);
    assert.equal(
      await status,
      "https://media.fixture.test/video-22?token=fixture-playback-secret",
    );
  } finally {
    await f.close();
  }
});

test("a finished download waits while put.io has not typed its videos yet", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    // put.io types a new file as a plain file for its first seconds.
    f.state.folders.set(
      20n,
      packEpisodes.map((file) => ({ ...file, fileType: "FILE" })),
    );
    let responded = false;
    const status = location(`${f.base()}/status/90/1/2.m3u8`).then((url) => {
      responded = true;
      return url;
    });
    await sleep(300);
    assert.equal(responded, false);
    f.state.folders.set(20n, packEpisodes);
    assert.equal(
      await status,
      "https://media.fixture.test/video-22?token=fixture-playback-secret",
    );
  } finally {
    await f.close();
  }
});

test("a season pack asks for a file choice unless exactly one video is the episode", async () => {
  const f = await fixture();
  const status = () => location(`${f.base()}/status/90/1/2.m3u8`);
  const choose = `${f.base()}/notice/select-file.m3u8`;
  const video = (
    id: bigint,
    releaseInfo?: { season?: number; episode?: number; episodeEnd?: number },
  ) => ({
    id,
    name: `Season file ${id}.mkv`,
    fileType: "VIDEO",
    releaseInfo,
  });
  try {
    for (const [files, expected, reason] of [
      [
        [video(21n, { episode: 2 }), video(22n, { season: 1, episode: 1 })],
        choose,
        "an episode without a season",
      ],
      [
        [
          video(21n, { season: 1, episode: 1 }),
          video(22n, { season: 1, episode: 2, episodeEnd: 3 }),
        ],
        choose,
        "an episode range",
      ],
      [
        [
          video(21n, { season: 1, episode: 2 }),
          video(22n, { season: 1, episode: 2 }),
        ],
        choose,
        "two matching videos",
      ],
      [[video(21n), video(22n)], choose, "no release info"],
      [[], `${f.base()}/notice/unavailable.m3u8`, "no videos"],
      [
        [
          video(21n, { season: 1, episode: 1 }),
          video(22n, { season: 1, episode: 2, episodeEnd: 2 }),
        ],
        "https://media.fixture.test/video-22?token=fixture-playback-secret",
        "a range of the episode alone",
      ],
    ] as const) {
      f.state.folders.set(20n, [...files]);
      assert.equal(await status(), expected, reason);
    }
    f.state.folders.set(10n, [video(20n, { season: 1, episode: 2 })]);
    assert.equal(await status(), choose, "a single-file download");
  } finally {
    await f.close();
  }
});

test("a pending season pack keeps its episode in the status URL", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.state.seasonPack = seasonPack;
    f.state.folders.set(20n, packEpisodes);
    f.state.transferFinished = false;
    const reads = () =>
      f.calls.filter(({ method }) => method === "GetTransfer").length;
    const selected = fetch(packSelection(f), { redirect: "manual" });
    while (reads() === 0) await sleep(5);
    await vi.advanceTimersByTimeAsync(25_000);
    const continued = (await selected).headers.get("location");
    assert.equal(continued, `${f.base()}/status/90/1/2.m3u8?wait=1`);
    vi.useRealTimers();
    f.state.transferFinished = true;
    assert.equal(
      await location(continued),
      "https://media.fixture.test/video-22?token=fixture-playback-secret",
    );
    for (const [path, code] of [
      ["/status/90/0/2.m3u8", 404],
      ["/status/90/1/10000.m3u8", 404],
      ["/status/90/1.m3u8", 404],
      ["/status/90/1/2.m3u8?other=1", 400],
      ["/status/90/1/2.m3u8?wait=6", 400],
    ] as const)
      assert.equal(
        (await fetch(`${f.base()}${path}`, { redirect: "manual" })).status,
        code,
        path,
      );
    assert.equal(f.state.addCount, 1);
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("a season pack Engine no longer offers or refuses plays release-unavailable", async () => {
  const f = await fixture();
  const unavailable = `${f.base()}/notice/release-unavailable.m3u8`;
  try {
    f.state.seasonPack = { ...seasonPack, id: "another-season-pack" };
    assert.equal(await location(packSelection(f)), unavailable);
    f.state.seasonPack = undefined;
    assert.equal(await location(packSelection(f)), unavailable);
    f.state.seasonPack = seasonPack;
    f.state.seasonRejection = { status: 403, code: "procedure_not_allowed" };
    assert.equal(await location(packSelection(f)), unavailable);
    f.state.seasonRejection = { status: 500, code: "internal" };
    assert.equal(await location(packSelection(f)), unavailable);
    f.state.seasonRejection = undefined;
    f.state.seasonPack = { ...seasonPack, id: "" };
    assert.equal(
      await location(packSelection(f)),
      unavailable,
      "A pack without an ID",
    );
    f.state.seasonPack = seasonPack;
    f.state.seasonRejection = { status: 401, code: "unauthenticated" };
    assert.equal(
      await location(packSelection(f)),
      `${f.base()}/notice/reconnect.m3u8`,
    );
    assert.equal(f.state.addCount, 0);
    const calls = f.calls.length;
    assert.equal(
      await location(
        `${f.base()}/play/movie/${encodeURIComponent(target)}/${encodeURIComponent(`pack:${seasonPack.id}`)}.m3u8`,
      ),
      unavailable,
      "A movie has no season pack",
    );
    assert.equal(
      f.calls
        .slice(calls)
        .some(({ method }) => method === "GetTVShowSeasonDownloads"),
      false,
    );
  } finally {
    await f.close();
  }
});

test("movie and episode releases never consult the season lookup", async () => {
  const f = await fixture();
  try {
    f.state.seasonPack = seasonPack;
    f.state.seasonRejection = { status: 403, code: "procedure_not_allowed" };
    f.state.singleFile = true;
    const episode = `${f.base()}/play/series/${encodeURIComponent(episodeTarget)}/fixture-release.m3u8`;
    f.state.releaseMissing = true;
    assert.equal(
      await location(episode),
      `${f.base()}/notice/release-unavailable.m3u8`,
    );
    f.state.releaseMissing = false;
    for (const url of [await releaseSelection(f), episode])
      assert.equal(
        await location(url),
        "https://media.fixture.test/video-21?token=fixture-playback-secret",
      );
    assert.equal(f.state.addCount, 2);
    assert.ok(f.listings.every(({ releaseInfo }) => !releaseInfo));
    assert.equal(
      f.calls.some(({ method }) => method === "GetTVShowSeasonDownloads"),
      false,
    );
  } finally {
    await f.close();
  }
});
