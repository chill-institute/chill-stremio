import {
  createGuest,
  requireLoopback,
  requireRunDirectory,
  streamListBounds,
} from "./desktop-guest-runtime.ts";
import { desktopTextMatches } from "./desktop-ui.ts";

// Drives the pinned Linux client against the actual hosted adapter served by
// desktop-hosted.ts. Every state transition (transfer counts, adapter restart,
// media interruption, revocation) is asserted by the harness through the
// loopback control endpoint; this guest only proves what the UI shows.
const [webText, manifestText, controlText, directoryText, delivery] =
  process.argv.slice(2);
if (!webText || !manifestText || !controlText)
  throw new Error("Expected web, manifest, control origins and a directory");
const directory = requireRunDirectory(directoryText);
const hls = delivery === "hls";
const web = requireLoopback(webText);
const manifest = requireLoopback(manifestText);
const control = requireLoopback(controlText);
const credential = /^\/s\/(v4\.local\.[A-Za-z0-9_-]+)\/manifest\.json$/.exec(
  manifest.pathname,
)?.[1];
if (!credential) throw new Error("Expected a hosted manifest URL");
const guest = await createGuest({ web, directory, secrets: [credential] });
const {
  run,
  wait,
  click,
  screenshot,
  textTarget,
  textVisible,
  selectStream,
  waitForKind,
  startApp,
  stopApp,
  step,
  result,
} = guest;
const encoded = (value: string) => encodeURIComponent(value);
const catalogRoute = (id: string) =>
  `/discover/${encoded(manifest.href)}/movie/${id}`;
const detailRoute = (type: string, id: string) =>
  `/detail/${type}/${encoded(id)}/${encoded(id)}`;
type StageReply = Record<string, unknown>;
const stage = async (name: string, input: StageReply = {}) => {
  const response = await fetch(`${control.href}/stage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: name, ...input }),
    signal: AbortSignal.timeout(60_000),
  });
  const reply: unknown = await response.json();
  if (
    typeof reply !== "object" ||
    reply === null ||
    !("ok" in reply) ||
    reply.ok !== true
  )
    throw new Error(
      `Harness rejected stage ${name}: ${typeof reply === "object" && reply && "error" in reply ? String(reply.error) : response.status}`,
    );
  return reply as StageReply;
};
const requireString = (reply: StageReply, key: string) => {
  const value = reply[key];
  if (typeof value !== "string" || !value)
    throw new Error(`Harness stage reply lacks ${key}`);
  return value;
};
/** The generated status clip shows its headline in white at 1280×720. */
const waitForNotice = async (name: string, word: string) => {
  for (let attempt = 0; attempt < 8; attempt++) {
    run("xdotool", ["mousemove", "640", "300"]);
    await wait(2500);
    const matches = desktopTextMatches(guest.visibleText(name), word, {
      left: 200,
      top: 200,
      right: 1080,
      bottom: 520,
    });
    if (matches.length > 0 && !guest.sampleKind(`${directory}/${name}.png`))
      return;
  }
  throw new Error(`Status clip with ${word} was not rendered`);
};
const previewBounds = { left: 880, top: 90, right: 1270, bottom: 700 };
const routes = {
  movies: catalogRoute("discover-movies"),
  library: catalogRoute("library"),
};
try {
  await guest.trustFixtureCertificate();
  await guest.startAudio();
  await step("software-decoding", guest.configureSoftwareDecoding);
  let app = startApp("/addons");
  await step(
    "ui-installation",
    async () => {
      await guest.installAddon(manifest.href, { retainUrlFrame: false });
      await stage("installed");
    },
    ["software-decoding"],
  );
  await stopApp(app);
  app = startApp(routes.movies);
  let movieId = "";
  await step(
    "movie-discovery",
    async () => {
      const reply = await stage("catalog");
      movieId = requireString(reply, "movieId");
      const card = await textTarget("catalog", "Feature", undefined, 30_000);
      await click(card.x, card.y);
      // The discover view previews the selected card; Show opens its detail page.
      const show = await textTarget("preview", "Show", previewBounds);
      await click(show.x, show.y);
    },
    ["ui-installation"],
  );
  await step(
    "release-detail",
    async () => {
      await textTarget("release-detail", "Download", streamListBounds, 30_000);
      await stage("movie-detail");
    },
    ["movie-discovery"],
  );
  await stopApp(app);
  let episodeRoute = "";
  await step(
    "episode-context",
    async () => {
      const reply = await stage("episode");
      episodeRoute = `/detail/series/${encoded(requireString(reply, "seriesId"))}/${encoded(requireString(reply, "episodeId"))}`;
      app = startApp(episodeRoute);
      await textVisible("episode-context", "Alpha", undefined, 30_000);
      await textTarget("episode-context", "Download", streamListBounds, 30_000);
      await stage("episode-detail");
    },
    ["ui-installation"],
  );
  await stopApp(app);
  app = startApp(detailRoute("movie", movieId));
  await step(
    "selected-download",
    async () => {
      await selectStream("movie-sources", "Download");
      await stage("selected");
      await wait(3000);
      screenshot("pending-loading");
      if (guest.sampleKind(`${directory}/pending-loading.png`))
        throw new Error("Pending download unexpectedly decoded video");
      await stage("complete");
      await waitForKind("automatic-playback", "movie");
      await stage("automatic-playing");
    },
    ["release-detail"],
  );
  await stopApp(app);
  app = startApp(routes.library);
  let libraryId = "";
  await step(
    "library-listing",
    async () => {
      await textVisible("library", "Hosted", undefined, 30_000);
      const reply = await stage("library");
      libraryId = requireString(reply, "libraryId");
    },
    ["selected-download"],
  );
  await stopApp(app);
  await step(
    "library-playback",
    async () => {
      app = startApp(detailRoute("movie", libraryId));
      await selectStream("library-sources", "Fixture");
      await waitForKind("movie", "movie");
      const sampledAt = performance.now();
      await wait(2000);
      screenshot("movie-advancing");
      result.movieSampleIntervalMs = performance.now() - sampledAt;
      await stage("library-playing");
    },
    ["library-listing"],
  );
  await step(
    "library-subtitles",
    async () => {
      run("xdotool", ["mousemove", "640", "300"]);
      await wait(300);
      await click(135, 634);
      run("xdotool", ["key", "space"]);
      await wait(500);
      await click(1040, 680);
      const english = await textTarget("library-subtitle-menu", "English", {
        left: 535,
        top: 265,
        right: 750,
        bottom: 605,
      });
      await click(english.x, english.y);
      await click(500, 400);
      run("xdotool", ["key", "space"]);
      run("xdotool", ["mousemove", "640", "300"]);
      await wait(3500);
      screenshot("library-subtitles");
      await stage("library-subtitles");
    },
    ["library-playback"],
  );
  await step("audio-pcm", async () => guest.capturePcm(), ["library-playback"]);
  if (hls) {
    await stopApp(app);
  } else {
    await step(
      "interrupted-playback-recovery",
      async () => {
        run("xdotool", ["mousemove", "640", "300"]);
        await wait(300);
        await click(135, 634);
        await stage("interrupt");
        await wait(8000);
        run("xdotool", ["mousemove", "640", "301"]);
        await wait(3500);
        screenshot("interrupted");
        await click(32, 36);
        await wait(2000);
        await textTarget(
          "recovery-before-restart",
          "Fixture",
          streamListBounds,
        );
        await stopApp(app);
        app = startApp(detailRoute("movie", libraryId));
        await selectStream("recovery-sources", "Fixture");
        await waitForKind("interrupted-recovered", "movie");
        await stage("recovered");
      },
      ["library-playback"],
    );
    await stopApp(app);
    for (const kind of ["failed", "unknown", "select-file"] as const) {
      const word = kind === "select-file" ? "ready" : kind;
      let fileId = "";
      await step(
        `recovery-${kind}`,
        async () => {
          const target = requireString(
            await stage("recovery-detail", { kind }),
            "movieId",
          );
          app = startApp(detailRoute("movie", target));
          await selectStream(`${kind}-sources`, "Download");
          fileId = requireString(
            await stage("recovery-selected", { kind }),
            "fileId",
          );
          await waitForNotice(`${kind}-notice`, word);
          await stopApp(app);
        },
        ["selected-download"],
      );
      if (kind === "select-file")
        await step(
          "exact-file-playback",
          async () => {
            app = startApp(detailRoute("movie", fileId));
            await selectStream("select-file-sources", "Second");
            await waitForKind("multiple-file-decoded", "episode1");
            await stage("select-file-playing");
            await stopApp(app);
          },
          ["recovery-select-file"],
        );
    }
  }
  await step(
    "reconnect-notice",
    async () => {
      await stage("reject-credential");
      app = startApp(routes.library);
      await textVisible("reconnect", "Reconnect", undefined, 30_000);
      await stage("reconnect-client");
    },
    ["ui-installation"],
  );
} catch (error) {
  guest.failure(error);
} finally {
  await guest.finalize();
}
