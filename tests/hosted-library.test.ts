import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Schema } from "effect";
import { test, vi } from "vite-plus/test";
import { discoveryTargetId } from "../src/discovery.ts";
import {
  Rows,
  decode,
  episodeRows,
  fillWaits,
  fixture,
  librarySelection,
  location,
  movieRows,
  nextWindows,
  ownedSelection,
  ownedVideo,
  playbackResolutions,
  readOnlyProbes,
  releaseSelection,
  rememberWaits,
  seasonPack,
  target,
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

test("videos already in put.io lead the stream list, outside the release limit", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = Array.from({ length: 10 }, (_, n) =>
      ownedVideo(BigInt(n + 70)),
    );
    f.state.extraReleases = 100;
    const response = await fetch(`${f.base()}/stream/movie/tt1234567.json`);
    const listed = Schema.decodeUnknownSync(
      Schema.Struct({
        streams: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            title: Schema.String,
            url: Schema.String,
            behaviorHints: Schema.Struct({ notWebReady: Schema.Boolean }),
          }),
        ),
      }),
    )(await response.json()).streams;
    assert.equal(listed.length, 110, "10 videos and 100 releases");
    assert.deepEqual(listed[0], {
      name: "Play from put.io",
      title: "Independent.Film.2024.Part70.mkv",
      url: ownedSelection(f, "70"),
      behaviorHints: { notWebReady: false },
    });
    assert.deepEqual(
      listed.slice(0, 10).map(({ name, title }) => ({ name, title })),
      f.state.ownedVideos.map(({ name }) => ({
        name: "Play from put.io",
        title: name,
      })),
    );
    assert.ok(
      listed.slice(10).every(({ name }) => name === "Download to put.io"),
    );
    f.state.seasonPack = seasonPack;
    const episode = await episodeRows(f);
    assert.equal(episode.length, 111, "10 videos, 100 releases and the pack");
    assert.equal(episode[0]?.name, "Play from put.io");
    assert.equal(episode.at(-1)?.name, "Download season to put.io");
    for (const method of ["GetTVShowDetail", "GetTVShowSeason"])
      assert.equal(
        f.calls.filter((call) => call.method === method).length,
        1,
        `${method} serves both the lookup and Search`,
      );
    assert.deepEqual(f.ownedLookups, [
      { title: "Independent film", year: 2024 },
      { title: "Independent series", year: 2024, season: 1, episode: 2 },
    ]);
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("the account lookup runs alongside Search, not after it", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    // Search takes 1 s; the lookup answers after 1.2 s, inside the grace
    // that follows Search only if it started with Search.
    f.state.engineDelayMs = 1_000;
    f.state.ownedDelayMs = 1_200;
    assert.deepEqual(
      (await movieRows(f)).map(({ name }) => name),
      ["Play from put.io", "Download to put.io"],
    );
  } finally {
    await f.close();
  }
});

test("an account lookup slower than its grace is left out", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    f.state.ownedDelayMs = 3_000;
    const started = performance.now();
    assert.deepEqual(
      (await movieRows(f)).map(({ name }) => name),
      ["Download to put.io"],
    );
    assert.ok(performance.now() - started < 2_800);
  } finally {
    await f.close();
  }
});

test("the account lookup keeps its two seconds while a cold season lookup runs longer", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    f.state.seasonPack = seasonPack;
    f.state.ownedDelayMs = 3_000;
    f.state.seasonDelayMs = 4_000;
    assert.deepEqual(
      (await episodeRows(f)).map(({ name }) => name),
      ["Download to put.io", "Download season to put.io"],
    );
  } finally {
    await f.close();
  }
}, 10_000);

test("a fast release search does not cut the account and season lookups short", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    f.state.seasonPack = seasonPack;
    // Search answers at once; both lookups answer after more than its grace.
    f.state.ownedDelayMs = 1_200;
    f.state.seasonDelayMs = 1_200;
    assert.deepEqual(
      (await movieRows(f)).map(({ name }) => name),
      ["Play from put.io", "Download to put.io"],
    );
    assert.deepEqual(
      (await episodeRows(f)).map(({ name }) => name),
      ["Play from put.io", "Download to put.io", "Download season to put.io"],
    );
  } finally {
    await f.close();
  }
});

test("a refused or malformed account lookup leaves the rows unchanged", async () => {
  const f = await fixture();
  try {
    const baseline = await movieRows(f);
    assert.deepEqual(
      baseline.map(({ name }) => name),
      ["Download to put.io"],
    );
    f.state.ownedVideos = [ownedVideo(77n)];
    for (const rejection of [
      { status: 401, code: "unauthenticated" },
      { status: 403, code: "permission_denied" },
      { status: 403, code: "procedure_not_allowed" },
      { status: 503, code: "unavailable" },
    ]) {
      f.state.ownedRejection = rejection;
      assert.deepEqual(await movieRows(f), baseline, rejection.code);
    }
    f.state.ownedRejection = undefined;
    for (const videos of [
      [{ ...ownedVideo(77n), fileType: "FOLDER" }],
      Array.from({ length: 11 }, (_, n) => ownedVideo(BigInt(n + 70))),
    ]) {
      f.state.ownedVideos = videos;
      assert.deepEqual(await movieRows(f), baseline);
    }
  } finally {
    await f.close();
  }
});

test("release targets and missing titles never ask for videos in put.io", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    const release = discoveryTargetId({
      kind: "release",
      query: "Independent film",
      id: "fixture-release",
    });
    assert.deepEqual(
      (await movieRows(f, release)).map(({ name }) => name),
      ["Download to put.io"],
    );
    assert.deepEqual(
      await movieRows(
        f,
        discoveryTargetId({ kind: "movie", id: "missing-film" }),
      ),
      [],
    );
    assert.deepEqual(f.ownedLookups, []);
  } finally {
    await f.close();
  }
});

test("a video already in put.io plays without a transfer or status URL", async () => {
  const f = await fixture();
  const media =
    "https://media.fixture.test/video-77?token=fixture-playback-secret";
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    const [row] = await movieRows(f);
    assert.equal(row?.url, ownedSelection(f, "77"));
    f.calls.length = 0;
    assert.equal(
      (await fetch(ownedSelection(f, "77"), { method: "HEAD" })).status,
      200,
    );
    const prefetch = await fetch(ownedSelection(f, "77"), {
      headers: { "sec-purpose": "prefetch" },
    });
    assert.equal(prefetch.status, 204);
    assert.deepEqual(f.calls, []);
    assert.equal(await location(ownedSelection(f, "77")), media);
    assert.equal(await location(ownedSelection(f, "77", "mp4")), media);
    // While put.io prepares it, legacy MP4 plays the clip and HLS waits.
    f.state.playbackPending = true;
    assert.equal(
      await location(ownedSelection(f, "77", "mp4")),
      `${f.base()}/notice/preparing.mp4`,
    );
    const resolutions = f.calls.length;
    const waited = location(ownedSelection(f, "77"));
    await until(() => f.calls.length >= resolutions + 3);
    f.state.playbackPending = false;
    assert.equal(await waited, media);
    for (const format of ["m3u8", "mp4"])
      assert.equal(
        await location(ownedSelection(f, "78", format)),
        `${f.base()}/notice/unavailable.${format}`,
      );
    for (const rejection of [
      { status: 401, code: "unauthenticated" },
      { status: 403, code: "permission_denied" },
    ]) {
      f.state.rejection = rejection;
      assert.equal(
        await location(ownedSelection(f, "77")),
        `${f.base()}/notice/reconnect.m3u8`,
      );
    }
    f.state.rejection = undefined;
    assert.ok(f.calls.every(({ method }) => method === "ResolvePlayback"));
    assert.equal(f.state.addCount, 0);
    const calls = f.calls.length;
    for (const id of [
      "0",
      "077",
      "-1",
      "",
      "abc",
      "9223372036854775808",
      "1".repeat(20),
    ])
      assert.equal(
        (await fetch(ownedSelection(f, id), { redirect: "manual" })).status,
        400,
        id,
      );
    assert.equal(f.calls.length, calls);
  } finally {
    await f.close();
  }
});

test("a video already in put.io needs no submission unit of its link", async () => {
  const f = await fixture();
  const catalog = () => fetch(`${f.base()}/catalog/movie/discover-movies.json`);
  const stalled: Promise<Response>[] = [];
  // Fake only the request deadline timers; sockets stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    f.state.stallMovies = true;
    for (let i = 0; i < 15; i++) stalled.push(catalog());
    await until(
      () =>
        f.calls.filter(({ method }) => method === "GetMovies").length === 15,
    );
    const another = await fetch(
      `${f.base()}/play/movie/${encodeURIComponent(target)}/fixture-release.m3u8`,
      { redirect: "manual" },
    );
    assert.equal(another.status, 503, "a new selection needs two free units");
    await another.arrayBuffer();
    const media =
      "https://media.fixture.test/video-77?token=fixture-playback-secret";
    assert.equal(await location(ownedSelection(f, "77")), media);
    // Waiting while put.io prepares it holds only the request's unit.
    f.state.playbackPending = true;
    const resolutions = () =>
      f.calls.filter(({ method }) => method === "ResolvePlayback").length;
    const before = resolutions();
    const waited = location(ownedSelection(f, "77"));
    await until(() => resolutions() >= before + 2);
    const manifest = await fetch(`${f.base()}/manifest.json`);
    assert.equal(manifest.status, 429, "the wait holds the link's last unit");
    await manifest.arrayBuffer();
    f.state.playbackPending = false;
    assert.equal(await waited, media);
    assert.equal(f.state.addCount, 0);
    assert.ok(
      f.calls.every(({ method }) =>
        ["GetMovies", "ResolvePlayback"].includes(method),
      ),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    for (const response of await Promise.all(stalled)) {
      assert.equal(response.status, 504);
      await response.arrayBuffer();
    }
  } finally {
    vi.useRealTimers();
    const settled = Promise.allSettled(stalled);
    await f.close();
    await settled;
  }
});

test("a selected download put.io must convert asks once per read and plays once converted", async () => {
  const f = await fixture();
  try {
    f.state.singleFile = true;
    f.state.playbackConvertible = true;
    const url = await releaseSelection(f);
    for (const init of readOnlyProbes)
      await (await fetch(url, init)).arrayBuffer();
    assert.deepEqual(f.state.conversions, []);
    const selected = location(url);
    await until(() => f.state.conversions.length === 1);
    assert.equal(playbackResolutions(f), 1);
    // put.io finishes converting before the selection reads again.
    f.state.playbackConvertible = false;
    assert.equal(
      await selected,
      "https://media.fixture.test/video-21?token=fixture-playback-secret",
    );
    assert.deepEqual(f.state.conversions, [21n]);
    assert.equal(playbackResolutions(f), 2);
    assert.equal(f.state.addCount, 1);
    f.state.playbackConvertible = true;
    f.state.conversionResult = "unavailable";
    for (const format of ["m3u8", "mp4"])
      assert.equal(
        await location(`${f.base()}/status/90.${format}`),
        `${f.base()}/notice/unavailable.${format}`,
      );
    assert.deepEqual(f.state.conversions, [21n, 21n, 21n]);
    f.state.conversionRejection = { status: 403, code: "permission_denied" };
    assert.equal(
      await location(`${f.base()}/status/90.m3u8`),
      `${f.base()}/notice/reconnect.m3u8`,
    );
    // A transient Engine failure stays an error, never the unavailable clip.
    f.state.conversionRejection = { status: 503, code: "unavailable" };
    for (const format of ["m3u8", "mp4"]) {
      const failed = await fetch(`${f.base()}/status/90.${format}`, {
        redirect: "manual",
      });
      assert.equal(failed.status, 503);
      assert.equal(failed.headers.get("location"), null);
      await failed.arrayBuffer();
    }
    // Only conversion_required asks for a conversion: not pending, nor
    // unavailable for another reason.
    f.state.conversionRejection = undefined;
    f.state.conversionResult = "pending";
    f.state.playbackConvertible = false;
    f.state.playbackPending = true;
    const conversions = [...f.state.conversions];
    const resolutions = playbackResolutions(f);
    const waited = location(`${f.base()}/status/90.m3u8`);
    await until(() => playbackResolutions(f) >= resolutions + 3);
    f.state.playbackPending = false;
    f.state.playbackUnavailable = true;
    assert.equal(await waited, `${f.base()}/notice/unavailable.m3u8`);
    assert.deepEqual(f.state.conversions, conversions);
    assert.equal(f.state.addCount, 1);
  } finally {
    await f.close();
  }
});

test("a video already in put.io that put.io must convert starts converting and plays once converted", async () => {
  const f = await fixture();
  const media =
    "https://media.fixture.test/video-77?token=fixture-playback-secret";
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    f.state.playbackConvertible = true;
    const [row] = await movieRows(f);
    assert.equal(row?.url, ownedSelection(f, "77"));
    for (const init of readOnlyProbes)
      await (await fetch(ownedSelection(f, "77"), init)).arrayBuffer();
    assert.deepEqual(f.state.conversions, []);
    assert.equal(
      await location(ownedSelection(f, "77", "mp4")),
      `${f.base()}/notice/preparing.mp4`,
    );
    assert.deepEqual(f.state.conversions, [77n]);
    // HLS waits, asking again on each read that still needs converting.
    const waited = location(ownedSelection(f, "77"));
    await until(() => f.state.conversions.length >= 3);
    // put.io is converting, then done.
    f.state.playbackConvertible = false;
    f.state.playbackPending = true;
    const resolutions = playbackResolutions(f);
    // Reads run one at a time, so the second after the switch follows any
    // conversion asked before it.
    await until(() => playbackResolutions(f) >= resolutions + 2);
    const conversions = f.state.conversions.length;
    await until(() => playbackResolutions(f) >= resolutions + 4);
    f.state.playbackPending = false;
    assert.equal(await waited, media);
    assert.equal(f.state.conversions.length, conversions);
    assert.ok(f.state.conversions.every((id) => id === 77n));
    f.state.playbackConvertible = true;
    f.state.conversionResult = "unavailable";
    assert.equal(
      await location(ownedSelection(f, "77")),
      `${f.base()}/notice/unavailable.m3u8`,
    );
    f.state.conversionResult = "pending";
    for (const [rejection, clip] of [
      [{ status: 404, code: "not_found" }, "unavailable"],
      [{ status: 401, code: "unauthenticated" }, "reconnect"],
      [{ status: 403, code: "permission_denied" }, "reconnect"],
    ] as const) {
      f.state.conversionRejection = rejection;
      assert.equal(
        await location(ownedSelection(f, "77")),
        `${f.base()}/notice/${clip}.m3u8`,
      );
    }
    // Once a restart forgets the wait, a failed first read stays an error the
    // player retries.
    await f.restart();
    f.state.conversionRejection = { status: 503, code: "unavailable" };
    const failed = await fetch(ownedSelection(f, "77"), { redirect: "manual" });
    assert.equal(failed.status, 503);
    await failed.arrayBuffer();
    assert.equal(f.state.conversions.length, conversions + 5);
    assert.equal(f.state.addCount, 0);
  } finally {
    await f.close();
  }
});

test("listing videos put.io must convert never starts a conversion", async () => {
  const f = await fixture();
  try {
    f.state.ownedVideos = [ownedVideo(77n)];
    const resource = (path: string) =>
      fetch(`${f.base()}/${path}`).then(async (response) => {
        assert.equal(response.status, 200, path);
        return response.json();
      });
    // put.io must convert the video, then is preparing it.
    for (const [convertible, name, note] of [
      [
        true,
        "Convert and play from put.io",
        "put.io prepares this video before it plays",
      ],
      [false, "Play from put.io", "put.io is preparing this video"],
    ] as const) {
      f.state.playbackConvertible = convertible;
      f.state.playbackPending = !convertible;
      assert.deepEqual(await resource("stream/movie/chill%3Afile%3A50.json"), {
        streams: [
          {
            name,
            title: `Existing video\n${note}`,
            url: librarySelection(f, "50"),
            behaviorHints: { notWebReady: false },
          },
        ],
      });
      assert.deepEqual(
        await resource("subtitles/movie/chill%3Afile%3A50.json"),
        { subtitles: [] },
      );
      await resource("meta/movie/chill%3Afile%3A50.json");
      await resource("catalog/movie/library.json");
      assert.equal((await movieRows(f))[0]?.url, ownedSelection(f, "77"));
    }
    assert.equal(playbackResolutions(f), 4);
    assert.deepEqual(f.state.conversions, []);
  } finally {
    await f.close();
  }
});

test("a library video put.io must convert lists a row that converts only when selected", async () => {
  const f = await fixture();
  const media =
    "https://media.fixture.test/video-50?token=fixture-playback-secret";
  const libraryRows = async () => {
    const response = await fetch(
      `${f.base()}/stream/movie/chill%3Afile%3A50.json`,
    );
    assert.equal(response.status, 200);
    return (await decode(response, Rows)).streams;
  };
  try {
    f.state.playbackConvertible = true;
    const [row, ...others] = await libraryRows();
    assert.deepEqual(others, []);
    assert.equal(row?.name, "Convert and play from put.io");
    assert.equal(row?.url, librarySelection(f, "50"));
    for (const init of readOnlyProbes)
      await (await fetch(librarySelection(f, "50"), init)).arrayBuffer();
    assert.deepEqual(f.state.conversions, []);
    f.state.conversionStarts = true;
    let responded = false;
    const selected = location(librarySelection(f, "50")).then((value) => {
      responded = true;
      return value;
    });
    await until(() => f.state.conversions.length === 1);
    // While put.io prepares it, the listing offers the same selection without
    // subtitles, and the selection waits without asking put.io again.
    assert.deepEqual(
      (await libraryRows()).map(({ name, url }) => ({ name, url })),
      [{ name: "Play from put.io", url: librarySelection(f, "50") }],
    );
    assert.deepEqual(
      await (
        await fetch(`${f.base()}/subtitles/movie/chill%3Afile%3A50.json`)
      ).json(),
      { subtitles: [] },
    );
    for (const init of readOnlyProbes)
      await (await fetch(librarySelection(f, "50"), init)).arrayBuffer();
    const resolutions = playbackResolutions(f);
    await until(() => playbackResolutions(f) >= resolutions + 2);
    assert.equal(responded, false);
    // put.io has converted it: the waiting selection plays the video, and the
    // listing offers the video itself again.
    f.state.playbackPending = false;
    assert.equal(await selected, media);
    assert.deepEqual(f.state.conversions, [50n]);
    assert.equal(await location(librarySelection(f, "50")), media);
    assert.deepEqual(f.state.conversions, [50n]);
    assert.deepEqual(
      (await libraryRows()).map(({ url }) => url),
      [media],
    );
    f.state.playbackUnavailable = true;
    assert.deepEqual(await libraryRows(), []);
    assert.deepEqual(f.state.conversions, [50n]);
    assert.equal(f.state.addCount, 0);
    // A library selection names its own file as a movie; other owned
    // selections name a page that lists them.
    f.state.playbackUnavailable = false;
    f.state.playbackConvertible = true;
    const calls = f.calls.length;
    for (const selection of [
      { id: "chill:file:51" },
      { id: "chill:file:050" },
      { type: "series" },
      { type: "series", format: "mp4" },
      { id: "chill:files:50" },
      { id: "fixture-film" },
      { id: "chill:movie:!" },
      { type: "series", id: target },
    ])
      assert.equal(
        (
          await fetch(librarySelection(f, "50", selection), {
            redirect: "manual",
          })
        ).status,
        400,
        JSON.stringify(selection),
      );
    assert.equal(f.calls.length, calls);
    assert.deepEqual(f.state.conversions, [50n]);
  } finally {
    await f.close();
  }
});

test("a library video put.io keeps preparing waits in windows, then plays the clip until selected again", async () => {
  const f = await fixture({ selectionPendingMs: 40_000 });
  // Fake request windows and the pending clock; sockets and polling stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    f.state.playbackPending = true;
    const url = librarySelection(f, "50");
    // The window ends once its first read and a poll have answered.
    const wait = async (target: string) => {
      const before = playbackResolutions(f);
      const response = fetch(target, { redirect: "manual" });
      while (playbackResolutions(f) < before + 2) await sleep(5);
      await vi.advanceTimersByTimeAsync(25_000);
      return (await response).headers.get("location");
    };
    const continued = `${url}?wait=1`;
    const clip = `${f.base()}/notice/preparing.m3u8`;
    assert.equal(await wait(url), continued);
    assert.equal(
      await wait(url),
      clip,
      "The client's retry of the selected URL reaches the pending limit",
    );
    assert.equal(await wait(`${url}?wait=5`), clip);
    assert.equal(
      await wait(url),
      continued,
      "Selecting again after the clip waits again",
    );
    // 75 seconds after that wait's request joined, 50 after it ended.
    await vi.advanceTimersByTimeAsync(50_000);
    assert.equal(
      await wait(url),
      clip,
      "A wait is remembered for 60 seconds after its last request ends",
    );
    await vi.advanceTimersByTimeAsync(61_000);
    assert.equal(
      await wait(url),
      continued,
      "A selection idle past the reuse window waits the whole limit again",
    );
    assert.equal(
      await location(librarySelection(f, "50", { format: "mp4" })),
      `${f.base()}/notice/preparing.mp4`,
    );
    f.state.playbackPending = false;
    assert.equal(
      await location(url),
      "https://media.fixture.test/video-50?token=fixture-playback-secret",
    );
    assert.ok(f.calls.every(({ method }) => method === "ResolvePlayback"));
    assert.equal(f.state.addCount, 0);
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("a waiting library selection holds through failed reads and never answers 429", async () => {
  const f = await fixture();
  // Fake request windows; sockets and polling stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.state.playbackPending = true;
    const url = librarySelection(f, "50");
    for (const failure of [
      { status: 429, code: "resource_exhausted" },
      { status: 503, code: "unavailable" },
      { status: 504, code: "deadline_exceeded" },
      // A connection Engine closes fails the fetch, which Connect reports as
      // unknown.
      "dropped",
    ] as const) {
      f.state.rejection = undefined;
      f.state.dropConnections = false;
      const before = playbackResolutions(f);
      const response = fetch(url, { redirect: "manual" });
      await until(() => playbackResolutions(f) >= before + 2);
      if (failure === "dropped") f.state.dropConnections = true;
      else f.state.rejection = failure;
      await until(() => playbackResolutions(f) >= before + 3);
      const failed = playbackResolutions(f);
      const label = failure === "dropped" ? failure : failure.code;
      await sleep(100);
      assert.equal(playbackResolutions(f), failed, label);
      await vi.advanceTimersByTimeAsync(25_000);
      assert.equal(
        (await response).headers.get("location"),
        `${url}?wait=1`,
        label,
      );
    }
    f.state.dropConnections = false;
    const before = playbackResolutions(f);
    const reconnecting = location(url);
    await until(() => playbackResolutions(f) >= before + 2);
    f.state.rejection = { status: 401, code: "unauthenticated" };
    assert.equal(await reconnecting, `${f.base()}/notice/reconnect.m3u8`);
    // A selection that is not waiting keeps a failed first read an error, one
    // the player retries.
    f.state.rejection = { status: 429, code: "resource_exhausted" };
    const limited = await fetch(librarySelection(f, "21"), {
      redirect: "manual",
    });
    assert.equal(limited.status, 503);
    assert.deepEqual(await limited.json(), { error: "unavailable" });
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("a waiting library selection's continuation or retry holds a failed first read", async () => {
  const f = await fixture();
  // Fake request deadlines and windows; sockets and polling stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    f.state.playbackPending = true;
    f.state.rejection = { status: 429, code: "resource_exhausted" };
    const url = librarySelection(f, "50");
    // A continuation waits even with no wait remembered, as after a restart;
    // the client's retry of the selected URL then rejoins that wait.
    for (const [label, target, next] of [
      ["wait=1", `${url}?wait=1`, `${url}?wait=2`],
      ["wait=2", `${url}?wait=2`, `${url}?wait=3`],
      ["retry", url, `${url}?wait=1`],
    ] as const) {
      const before = playbackResolutions(f);
      const response = fetch(target, { redirect: "manual" });
      await until(() => playbackResolutions(f) > before);
      await sleep(100);
      assert.equal(playbackResolutions(f), before + 1, label);
      await vi.advanceTimersByTimeAsync(25_000);
      assert.equal((await response).headers.get("location"), next, label);
    }
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});

test("a full wait memory keeps the joining wait and any a request may still hold", async () => {
  const f = await fixture({ selectionPendingMs: 40_000 });
  // Fake request windows and the pending clock; sockets and polling stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const [oldest, second, ...others] = await fillWaits(f);
    assert.ok(oldest !== undefined && second !== undefined);
    const clip = [`${f.base()}/notice/preparing.m3u8`];
    // Each wait was seen within the longest request, 35 seconds.
    await vi.advanceTimersByTimeAsync(30_000);
    await rememberWaits(f, others.slice(-1));
    assert.deepEqual(
      await nextWindows(f, [oldest]),
      clip,
      "A new wait keeps the oldest, which reaches the pending limit",
    );
    // Now idle longer than any request, and the least recently seen.
    assert.deepEqual(
      await nextWindows(f, [second]),
      clip,
      "A wait keeps its own start",
    );
  } finally {
    vi.useRealTimers();
    await f.close();
  }
}, 10_000);

test("a full wait memory forgets the oldest wait idle longer than any request", async () => {
  const f = await fixture({ selectionPendingMs: 40_000 });
  // Fake request windows and the pending clock; sockets and polling stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  try {
    const [oldest, ...others] = await fillWaits(f);
    const newest = others.at(-2);
    assert.ok(oldest !== undefined && newest !== undefined);
    await vi.advanceTimersByTimeAsync(40_000);
    // A new wait at the limit makes room for itself only.
    await rememberWaits(f, others.slice(-1));
    assert.deepEqual(await nextWindows(f, [oldest, newest]), [
      `${librarySelection(f, String(oldest))}?wait=1`,
      `${f.base()}/notice/preparing.m3u8`,
    ]);
  } finally {
    vi.useRealTimers();
    await f.close();
  }
}, 10_000);

test("a library selection's first read keeps the request deadline and its window starts with the request", async () => {
  const f = await fixture();
  // Fake request deadlines, windows and Engine latency; sockets stay real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const url = librarySelection(f, "50");
    // Each Engine call answers within its own timeout; together they outlast
    // the request deadline.
    f.state.playbackConvertible = true;
    f.state.delayMs = {
      ResolvePlayback: 6_000,
      StartPlaybackConversion: 6_000,
    };
    const slow = fetch(url, { redirect: "manual" });
    await until(() => f.state.heldCalls === 1);
    await vi.advanceTimersByTimeAsync(6_000);
    await until(() => f.state.heldCalls === 2);
    await vi.advanceTimersByTimeAsync(4_000);
    const expired = await Promise.race([slow, sleep(500)]);
    assert.equal(expired?.status, 504);
    await expired?.arrayBuffer();
    await vi.advanceTimersByTimeAsync(2_000);
    f.state.playbackConvertible = false;
    f.state.playbackPending = true;
    f.state.delayMs = { ResolvePlayback: 8_000 };
    let responded = false;
    const selected = fetch(url, { redirect: "manual" }).then((response) => {
      responded = true;
      return response;
    });
    await until(() => f.state.heldCalls === 3);
    await vi.advanceTimersByTimeAsync(8_000);
    // The first read answered pending, and the first poll is waiting.
    await until(() => f.state.heldCalls === 4);
    await vi.advanceTimersByTimeAsync(16_000);
    await sleep(50);
    assert.equal(responded, false);
    await vi.advanceTimersByTimeAsync(1_000);
    await until(() => responded);
    assert.equal((await selected).headers.get("location"), `${url}?wait=1`);
  } finally {
    vi.useRealTimers();
    await f.close();
  }
});
