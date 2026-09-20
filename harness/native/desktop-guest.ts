import {
  createGuest,
  requireLoopback,
  requireRunDirectory,
  streamListBounds,
} from "./desktop-guest-runtime.ts";
import { desktopTextTarget } from "./desktop-ui.ts";

const [webText, fixtureText, directoryText] = process.argv.slice(2);
if (!webText || !fixtureText)
  throw new Error("Expected fixture origins and a task-owned result directory");
const directory = requireRunDirectory(directoryText);
const web = requireLoopback(webText);
const fixture = requireLoopback(fixtureText);
const guest = await createGuest({ web, directory });
const {
  run,
  wait,
  click,
  screenshot,
  textTarget,
  selectStream,
  reloadFromMenu,
  sampleKind,
  waitForKind,
  startApp,
  stopApp,
  step,
  result,
} = guest;
const movieRoute = "/detail/movie/fixture%3Amovie/fixture%3Amovie";
try {
  await guest.startAudio();
  let app = startApp("/addons");
  await step("ui-installation", () =>
    guest.installAddon(`${fixture.origin}/manifest.json`, {
      retainUrlFrame: true,
    }),
  );
  await stopApp(app);
  app = startApp(movieRoute);
  await step(
    "pending-empty",
    async () => {
      await textTarget("pending", "streams");
      await reloadFromMenu("reload-menu");
      await textTarget("sources", "Direct", streamListBounds);
    },
    ["ui-installation"],
  );
  await step(
    "movie-decoded-playback",
    async () => {
      await selectStream("movie-sources", "Direct");
      await waitForKind("movie", "movie");
      const sampledAt = performance.now();
      await wait(2000);
      screenshot("movie-advancing");
      result.movieSampleIntervalMs = performance.now() - sampledAt;
    },
    ["ui-installation", "pending-empty"],
  );
  await step("audio-pcm", async () => guest.capturePcm());
  await step(
    "subtitles-off",
    async () => {
      run("xdotool", ["mousemove", "640", "300"]);
      await wait(3500);
      screenshot("subtitles-on");
      run("xdotool", ["key", "space"]);
      await wait(500);
      await click(1040, 680);
      const deadline = performance.now() + 15_000;
      let off: { x: number; y: number } | undefined;
      while (performance.now() < deadline) {
        screenshot("subtitle-menu");
        run("ffmpeg", [
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          `${directory}/subtitle-menu.png`,
          "-vf",
          "crop=215:340:535:265",
          "-frames:v",
          "1",
          `${directory}/subtitle-languages.png`,
        ]);
        off = desktopTextTarget(
          run("tesseract", [
            `${directory}/subtitle-languages.png`,
            "stdout",
            "--psm",
            "6",
            "tsv",
          ]),
          "Off",
          { left: 0, top: 0, right: 215, bottom: 340 },
        );
        if (off) break;
        await wait(500);
      }
      if (!off)
        throw new Error(
          "Native subtitle languages did not show a unique Off target",
        );
      await click(off.x + 535, off.y + 265);
      await click(500, 400);
      run("xdotool", ["key", "space"]);
      run("xdotool", ["mousemove", "640", "300"]);
      await wait(3500);
      screenshot("subtitles-off");
    },
    ["movie-decoded-playback"],
  );
  await step(
    "seek-rendered-destination",
    async () => {
      run("xdotool", ["mousemove", "640", "300"]);
      await wait(300);
      await click(655, 634);
      run("xdotool", ["mousemove", "640", "301"]);
      await wait(3500);
      screenshot("seek");
      if (sampleKind(`${directory}/seek.png`) !== "movie")
        throw new Error("Seek screenshot did not show movie fixture pixels");
    },
    ["movie-decoded-playback"],
  );
  await step(
    "interrupted-playback-recovery",
    async () => {
      run("xdotool", ["mousemove", "640", "300"]);
      await wait(300);
      await click(135, 634);
      screenshot("interrupted-rewind");
      await click(32, 36);
      await wait(2500);
      await selectStream("interrupted-sources", "Interrupted");
      await wait(7000);
      screenshot("interrupted");
      await click(32, 36);
      await wait(2000);
      await textTarget("recovery-before-restart", "Direct", streamListBounds);
      await stopApp(app);
      app = startApp(movieRoute);
      await selectStream("recovery-sources", "Direct");
      await waitForKind("interrupted-recovered", "movie");
    },
    ["movie-decoded-playback"],
  );
  await stopApp(app);
  startApp("/detail/series/fixture%3Aseries/fixture%3Aseries%3A1%3A1");
  await wait(8000);
  await step(
    "next-episode",
    async () => {
      await selectStream("episode-sources", "Direct");
      await waitForKind("episode1", "episode1");
      run("xdotool", ["key", "--clearmodifiers", "shift+n"]);
      await waitForKind("episode2", "episode2");
    },
    ["ui-installation"],
  );
} catch (error) {
  guest.failure(error);
} finally {
  await guest.finalize();
}
