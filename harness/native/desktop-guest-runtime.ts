import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, openSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import {
  desktopInstallStage,
  desktopTextMatches,
  desktopTextTarget,
  type DesktopInstallStage,
} from "./desktop-ui.ts";

// Shared native guest runtime: it runs inside the owned Xvfb/D-Bus session
// without Effect, and each flow script decides which scenarios it proves.
export interface Scenario {
  name: string;
  status: "passed" | "failed" | "blocked";
  error?: string;
}
export type TextBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};
export const streamListBounds: TextBounds = {
  left: 800,
  top: 90,
  right: 1260,
  bottom: 640,
};
export const requireLoopback = (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
    throw new Error("Only loopback fixture origins are allowed");
  return url;
};
export const requireRunDirectory = (value: string | undefined) => {
  if (!value?.match(/^\/tmp\/chill-desktop-[a-zA-Z0-9-]+\/run-[12]$/))
    throw new Error("Expected a task-owned result directory");
  return value;
};

export async function createGuest(options: {
  web: URL;
  directory: string;
  /** Values that must never reach retained logs, results or errors. */
  secrets?: string[];
}) {
  const { web, directory } = options;
  await mkdir(directory, { recursive: true });
  const profile = await mkdtemp("/tmp/chill-desktop-profile-");
  const children: ChildProcess[] = [];
  let sandboxWrapper: string | undefined;
  let logs = "";
  const scenarios: Scenario[] = [];
  const failed = new Set<string>();
  const result = {
    status: "blocked",
    boundary: "native-startup",
    freshState: false,
    cleanup: false,
    movieSampleIntervalMs: 0,
    error: "",
    scenarios,
  };
  const redact = (value: string) => {
    let text = stripVTControlCharacters(value).replace(
      /https?:\/\/[^\s"<>]+/g,
      "[fixture-url]",
    );
    for (const secret of options.secrets ?? [])
      if (secret) text = text.replaceAll(secret, "[secret]");
    return text;
  };
  const run = (command: string, args: string[], timeout = 15_000) =>
    execFileSync(command, args, {
      timeout,
      encoding: "utf8",
      env: process.env,
    });
  const launch = (command: string, args: string[], instanceFile?: string) => {
    const descriptor = instanceFile
      ? openSync(instanceFile, "wx", 0o600)
      : undefined;
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        env:
          sandboxWrapper && command === "flatpak"
            ? { ...process.env, FLATPAK_BWRAP: sandboxWrapper }
            : process.env,
        stdio:
          descriptor === undefined
            ? ["ignore", "pipe", "pipe"]
            : ["ignore", "pipe", "pipe", descriptor],
      });
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    child.stdout?.on("data", (data: Buffer) => {
      logs += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      logs += data.toString();
    });
    child.on("error", (error) => {
      logs += error.message;
    });
    children.push(child);
    return child;
  };
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill("SIGTERM");
    await Promise.race([exited, wait(2000, undefined, { ref: false })]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exited, wait(5000, undefined, { ref: false })]);
    }
  };
  const click = async (x: number, y: number) => {
    run("xdotool", ["mousemove", String(x), String(y)]);
    await wait(250);
    run("xdotool", ["mousedown", "1"]);
    await wait(120);
    run("xdotool", ["mouseup", "1"]);
    await wait(900);
  };
  // While set, every retained frame gets this box blacked out before it is
  // written: the installation dialog prints the private manifest URL.
  let secretBox:
    | { left: number; top: number; width: number; height: number }
    | undefined;
  const screenshot = (name: string) => {
    const display = process.env.DISPLAY;
    if (!display) throw new Error("Missing isolated display");
    run("ffmpeg", [
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "x11grab",
      "-draw_mouse",
      "0",
      "-video_size",
      "1280x720",
      "-i",
      display,
      "-frames:v",
      "1",
      ...(secretBox
        ? [
            "-vf",
            `drawbox=x=${secretBox.left}:y=${secretBox.top}:w=${secretBox.width}:h=${secretBox.height}:color=black:t=fill`,
          ]
        : []),
      `${directory}/${name}.png`,
    ]);
  };
  const waitForInstallStage = async (
    name: string,
    expected: DesktopInstallStage,
  ) => {
    const deadline = performance.now() + 20_000;
    while (performance.now() < deadline) {
      screenshot(name);
      const rgb = execFileSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          `${directory}/${name}.png`,
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { timeout: 10_000, maxBuffer: 1280 * 720 * 3 },
      );
      if (desktopInstallStage(rgb, 1280, 720) === expected) return;
      await wait(250);
    }
    throw new Error(`Native installation did not reach ${expected}`);
  };
  const visibleText = (name: string) => {
    screenshot(name);
    return run("tesseract", [`${directory}/${name}.png`, "stdout", "tsv"]);
  };
  /**
   * Recognized words equal to `label` in screen coordinates. Bounded lookups
   * OCR a doubled crop: the pinned client's small stream rows merge adjacent
   * words at native scale.
   */
  const readLabel = (name: string, label: string, bounds?: TextBounds) => {
    if (!bounds) return desktopTextMatches(visibleText(name), label);
    screenshot(name);
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;
    run("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-i",
      `${directory}/${name}.png`,
      "-vf",
      `crop=${width}:${height}:${bounds.left}:${bounds.top},scale=${width * 2}:${height * 2}`,
      "-frames:v",
      "1",
      `${directory}/${name}-region.png`,
    ]);
    return desktopTextMatches(
      run("tesseract", [
        `${directory}/${name}-region.png`,
        "stdout",
        "--psm",
        "11",
        "tsv",
      ]),
      label,
      { left: 0, top: 0, right: width * 2, bottom: height * 2 },
    ).map((match) => ({
      x: Math.round(bounds.left + match.x / 2),
      y: Math.round(bounds.top + match.y / 2),
    }));
  };
  const textTarget = async (
    name: string,
    label: string,
    bounds?: TextBounds,
    timeoutMs = 15_000,
  ) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const matches = readLabel(name, label, bounds);
      if (matches.length === 1) return matches[0]!;
      await wait(500);
    }
    throw new Error(`Native UI did not show a unique ${label} target`);
  };
  const textVisible = async (
    name: string,
    label: string,
    bounds?: TextBounds,
    timeoutMs = 15_000,
  ) => {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const matches = readLabel(name, label, bounds);
      if (matches.length > 0) return matches.length;
      await wait(500);
    }
    throw new Error(`Native UI did not show ${label}`);
  };
  const selectStream = async (name: string, label: string) => {
    const target = await textTarget(name, label, streamListBounds);
    await click(target.x, target.y);
  };
  const reloadFromMenu = async (name: string) => {
    run("xdotool", ["mousemove", "600", "400", "click", "3"]);
    const deadline = performance.now() + 15_000;
    while (performance.now() < deadline) {
      await wait(300);
      screenshot(name);
      run("ffmpeg", [
        "-y",
        "-v",
        "error",
        "-i",
        `${directory}/${name}.png`,
        "-vf",
        "crop=140:160:595:395,scale=280:320",
        "-frames:v",
        "1",
        `${directory}/${name}-menu.png`,
      ]);
      const target = desktopTextTarget(
        run("tesseract", [
          `${directory}/${name}-menu.png`,
          "stdout",
          "--psm",
          "11",
          "tsv",
        ]),
        "Reload",
        { left: 0, top: 0, right: 280, bottom: 320 },
      );
      if (target) {
        await click(
          Math.round(target.x / 2 + 595),
          Math.round(target.y / 2 + 395),
        );
        return;
      }
    }
    throw new Error("Native context menu did not show a unique Reload target");
  };
  const sampleKind = (file: string) => {
    try {
      const rgb = execFileSync(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          file,
          "-vf",
          "scale=160:90",
          "-frames:v",
          "1",
          "-f",
          "rawvideo",
          "-pix_fmt",
          "rgb24",
          "pipe:1",
        ],
        { timeout: 10_000, maxBuffer: 50_000 },
      );
      const counts = { movie: 0, episode1: 0, episode2: 0 };
      for (let index = 0; index + 2 < rgb.length; index += 3) {
        const r = rgb[index] ?? 0;
        const g = rgb[index + 1] ?? 0;
        const b = rgb[index + 2] ?? 0;
        if (r > 140 && g < 100 && b < 100) counts.movie++;
        else if (g > 140 && r < 100 && b < 100) counts.episode1++;
        else if (b > 140 && r < 100 && g < 100) counts.episode2++;
      }
      const [kind, count] = Object.entries(counts).sort(
        (left, right) => right[1] - left[1],
      )[0] ?? ["movie", 0];
      return count > 400 ? kind : undefined;
    } catch {
      return undefined;
    }
  };
  const waitForKind = async (
    name: string,
    expected: "movie" | "episode1" | "episode2",
  ) => {
    for (let attempt = 0; attempt < 12; attempt++) {
      run("xdotool", ["mousemove", "640", "300"]);
      await wait(3500);
      screenshot(name);
      if (name === "automatic-playback")
        copyFileSync(
          `${directory}/${name}.png`,
          `${directory}/${name}-${attempt}.png`,
        );
      if (sampleKind(`${directory}/${name}.png`) === expected) {
        run("xdotool", ["mousemove", "640", "301"]);
        await wait(6000);
        if (expected !== "movie") {
          screenshot(`${name}-overlay`);
          run("ffmpeg", [
            "-y",
            "-v",
            "error",
            "-i",
            `${directory}/${name}-overlay.png`,
            "-vf",
            "crop=125:40:915:545,scale=375:120",
            "-frames:v",
            "1",
            `${directory}/${name}-popup.png`,
          ]);
          const dismiss = desktopTextTarget(
            run("tesseract", [
              `${directory}/${name}-popup.png`,
              "stdout",
              "--psm",
              "7",
              "tsv",
            ]),
            "Dismiss",
            { left: 0, top: 0, right: 375, bottom: 120 },
          );
          if (dismiss) {
            await click(
              Math.round(dismiss.x / 3 + 915),
              Math.round(dismiss.y / 3 + 545),
            );
            run("xdotool", ["mousemove", "640", "301"]);
            await wait(3500);
          }
        }
        screenshot(name);
        if (sampleKind(`${directory}/${name}.png`) === expected) return;
      }
    }
    throw new Error(`Native window did not show ${expected} fixture pixels`);
  };
  const instances = new Map<ChildProcess, string>();
  const startApp = (route: string) => {
    const instanceFile = `${profile}/instance-${instances.size}`;
    const child = launch(
      "flatpak",
      [
        "run",
        "--user",
        "--die-with-parent",
        "--instance-id-fd=3",
        "--nofilesystem=home",
        "--nofilesystem=host",
        `--filesystem=${profile}`,
        "--command=env",
        "--env=GDK_BACKEND=x11",
        "--env=LC_ALL=C",
        "--env=LANG=C",
        "--env=GTK_A11Y=none",
        "--env=LIBGL_ALWAYS_SOFTWARE=1",
        "--env=MALLOC_PERTURB_=255",
        "--env=GSK_RENDERER=cairo",
        "--env=GDK_DISABLE=vulkan,dmabuf",
        "--env=WEBKIT_DMABUF_RENDERER_FORCE_SHM=1",
        `--env=PULSE_SERVER=unix:${profile}/pulse.sock`,
        "--env=RUST_LOG=info",
        "com.stremio.Stremio",
        `HOME=${profile}`,
        `XDG_DATA_HOME=${profile}/data`,
        `XDG_CONFIG_HOME=${profile}/config`,
        `XDG_CACHE_HOME=${profile}/cache`,
        "/app/bin/stremio",
        "--no-window-decorations",
        "--url",
        `${web.origin}/#${route}`,
      ],
      instanceFile,
    );
    instances.set(child, instanceFile);
    return child;
  };
  const trustFixtureCertificate = async () => {
    const anchors = `${profile}/anchors`;
    run("flatpak", [
      "run",
      "--user",
      "--die-with-parent",
      `--filesystem=${profile}`,
      "--command=cp",
      "com.stremio.Stremio",
      "-rL",
      "/etc/pki/ca-trust/source/anchors",
      anchors,
    ]);
    copyFileSync(`${directory}/fixture.pem`, `${anchors}/chill-fixture.pem`);
    sandboxWrapper = `${profile}/bwrap`;
    // GnuTLS uses system trust. Mount the fixture certificate only in the owned
    // app sandbox; its D-Bus proxy and the host keep their original settings.
    await writeFile(
      sandboxWrapper,
      `#!/bin/sh
if [ "$1" = --args ] && [ "$3" = -- ] && [ "$4" = env ]; then
  args_fd=$2
  shift 2
  exec /usr/bin/bwrap --args "$args_fd" --ro-bind ${anchors} /etc/pki/ca-trust/source/anchors "$@"
fi
exec /usr/bin/bwrap "$@"
`,
      { mode: 0o700 },
    );
  };
  const stopApp = async (child: ChildProcess) => {
    const path = instances.get(child);
    const instance = path ? readFileSync(path, "utf8").trim() : "";
    if (instance && !/^[0-9]+$/.test(instance))
      throw new Error("Invalid owned Flatpak instance ID");
    if (instance) {
      try {
        run("flatpak", ["kill", instance]);
      } catch {
        /* An exited instance needs no signal. */
      }
    }
    await stop(child);
    const deadline = performance.now() + 10_000;
    while (
      instance &&
      run("flatpak", ["ps", "--columns=instance"], 2000)
        .split(/\s+/)
        .includes(instance)
    ) {
      if (performance.now() >= deadline)
        throw new Error("Owned Flatpak instance remained after termination");
      await wait(250);
    }
  };
  const step = async (
    name: string,
    runStep: () => Promise<void>,
    depends: string[] = [],
  ) => {
    if (depends.some((item) => failed.has(item))) {
      scenarios.push({
        name,
        status: "blocked",
        error: "Skipped; a required earlier step failed",
      });
      failed.add(name);
      return;
    }
    result.boundary = name;
    try {
      await runStep();
      scenarios.push({ name, status: "passed" });
    } catch (error) {
      const message = redact(
        error instanceof Error ? error.message : String(error),
      );
      scenarios.push({ name, status: "failed", error: message });
      failed.add(name);
      result.error = result.error || message;
      try {
        screenshot(`${name}-failure`);
      } catch {
        /* Display capture may already have failed. */
      }
    }
  };
  const failure = (error: unknown) => {
    result.error = redact(
      error instanceof Error ? error.message : String(error),
    );
    try {
      screenshot("failure");
    } catch {
      /* The display may have failed before capture. */
    }
  };
  let finished = false;
  const finalize = async () => {
    if (finished) return;
    finished = true;
    let instancesClosed = true;
    for (const child of instances.keys()) {
      try {
        await stopApp(child);
      } catch (cause) {
        instancesClosed = false;
        result.error ||= String(cause);
      }
    }
    for (const child of children.toReversed()) await stop(child);
    result.cleanup =
      instancesClosed &&
      children.every(
        (child) => child.exitCode !== null || child.signalCode !== null,
      );
    await rm(profile, { recursive: true, force: true }).catch(
      (error: unknown) => {
        result.cleanup = false;
        result.error ||= error instanceof Error ? error.message : String(error);
      },
    );
    result.error = redact(result.error);
    result.status = failed.has("ui-installation")
      ? "failed"
      : !result.error &&
          result.freshState &&
          result.cleanup &&
          scenarios.length > 0 &&
          scenarios.every((item) => item.status === "passed")
        ? "passed"
        : "blocked";
    await writeFile(`${directory}/native.log`, redact(logs));
    await writeFile(
      `${directory}/result.json`,
      JSON.stringify(result, null, 2),
    );
  };
  process.on("SIGTERM", () => {
    result.error ||= "Guest interrupted";
    void finalize().finally(() => process.exit(1));
  });
  const startAudio = async () => {
    await mkdir(`${profile}/data`, { recursive: true });
    await mkdir(`${profile}/config`, { recursive: true });
    await mkdir(`${profile}/cache`, { recursive: true });
    result.freshState = true;
    await writeFile(
      `${profile}/pulse.pa`,
      [
        `load-module module-native-protocol-unix socket=${profile}/pulse.sock auth-anonymous=1`,
        "load-module module-null-sink sink_name=fixture channels=2 rate=48000",
        "set-default-sink fixture",
      ].join("\n"),
    );
    launch("pulseaudio", [
      "--daemonize=no",
      "--exit-idle-time=-1",
      "--use-pid-file=no",
      "-n",
      `--file=${profile}/pulse.pa`,
    ]);
    process.env.PULSE_SERVER = `unix:${profile}/pulse.sock`;
    await wait(1500);
    run("pactl", ["info"]);
  };
  const capturePcm = () => {
    run(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "pulse",
        "-i",
        "fixture.monitor",
        "-t",
        "2",
        `${directory}/audio.wav`,
      ],
      20_000,
    );
  };
  /**
   * Installs an addon through the pinned 1280×720 add-URL dialog. The typed
   * URL is verified through the trial's isolated X11 clipboard; the typed-URL
   * frame is retained only for public fixture URLs.
   */
  const installAddon = async (
    manifestUrl: string,
    options: { retainUrlFrame: boolean },
  ) => {
    if (!options.retainUrlFrame)
      secretBox = { left: 340, top: 340, width: 600, height: 56 };
    try {
      await installThroughDialog(manifestUrl, options);
    } finally {
      secretBox = undefined;
    }
  };
  const installThroughDialog = async (
    manifestUrl: string,
    options: { retainUrlFrame: boolean },
  ) => {
    await waitForInstallStage("startup", "addons");
    await click(908, 124);
    await waitForInstallStage("add-url", "add-url");
    await click(550, 369);
    run("xdotool", ["type", "--clearmodifiers", "--delay", "150", manifestUrl]);
    run("xdotool", ["key", "--clearmodifiers", "ctrl+a", "ctrl+c"]);
    if (options.retainUrlFrame) screenshot("installation-url");
    const clipboardDeadline = performance.now() + 5000;
    let copied = false;
    while (performance.now() < clipboardDeadline) {
      try {
        copied =
          run("xclip", ["-selection", "clipboard", "-out"], 1000) ===
          manifestUrl;
      } catch {
        /* WebKit may not have published the selection yet. */
      }
      if (copied) break;
      await wait(250);
    }
    if (!copied)
      throw new Error("Typed installation URL differs from expected URL");
    await click(747, 472);
    await waitForInstallStage("manifest", "manifest");
    await click(782, 532);
    await waitForInstallStage("installed", "addons");
    if (!options.retainUrlFrame)
      execFileSync("xclip", ["-selection", "clipboard", "-in"], {
        input: "",
        timeout: 5000,
        stdio: ["pipe", "ignore", "ignore"],
      });
  };
  const configureSoftwareDecoding = async () => {
    const app = startApp("/settings");
    try {
      const player = await textTarget(
        "software-settings",
        "Player",
        {
          left: 70,
          top: 80,
          right: 350,
          bottom: 650,
        },
        30_000,
      );
      await click(player.x, player.y);
      let target: { x: number; y: number } | undefined;
      for (let attempt = 0; attempt < 14; attempt++) {
        const text = visibleText("software-settings");
        for (const label of ["Hardware-accelerated", "Hardware", "decoding"]) {
          const matches = desktopTextMatches(text, label, {
            left: 350,
            top: 100,
            right: 850,
            bottom: 650,
          });
          if (matches.length === 1) {
            target = matches[0];
            break;
          }
        }
        if (target) break;
        run("xdotool", [
          "mousemove",
          "1050",
          "450",
          "click",
          "--repeat",
          "3",
          "5",
        ]);
        await wait(500);
      }
      if (!target) throw new Error("Hardware decoding setting was not visible");
      const rowY = target.y;
      const readToggle = (name: string) => {
        screenshot(name);
        const width = 235;
        const height = 48;
        const top = rowY - 24;
        const rgb = execFileSync(
          "ffmpeg",
          [
            "-v",
            "error",
            "-i",
            `${directory}/${name}.png`,
            "-vf",
            `crop=${width}:${height}:640:${top}`,
            "-frames:v",
            "1",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
          ],
          { timeout: 10000, maxBuffer: 100000 },
        );
        let white = 0;
        let sumX = 0;
        let sumY = 0;
        let green = 0;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const index = (y * width + x) * 3;
            const r = rgb[index] ?? 0;
            const g = rgb[index + 1] ?? 0;
            const b = rgb[index + 2] ?? 0;
            if (r > 180 && g > 180 && b > 180) {
              white++;
              sumX += x;
              sumY += y;
            }
            if (g > 120 && g > r * 1.5 && g > b * 1.2) green++;
          }
        }
        if (white < 50 || white > 600)
          throw new Error("Hardware decoding toggle was not identifiable");
        return { x: 640 + sumX / white, y: top + sumY / white, green };
      };
      const before = readToggle("software-decoding-before");
      if (before.green < 80)
        throw new Error("Fresh hardware decoding toggle was not enabled");
      await click(Math.round(before.x), Math.round(before.y));
      run("xdotool", ["mousemove", "400", "80"]);
      await wait(500);
      const after = readToggle("software-decoding-off");
      if (
        after.green >= 30 ||
        before.x - after.x < 8 ||
        Math.abs(before.y - after.y) > 5
      )
        throw new Error("Hardware decoding toggle did not switch off");
    } finally {
      await stopApp(app);
    }
  };
  return {
    directory,
    result,
    scenarios,
    run,
    wait,
    click,
    screenshot,
    visibleText,
    textTarget,
    textVisible,
    selectStream,
    reloadFromMenu,
    sampleKind,
    waitForKind,
    startApp,
    trustFixtureCertificate,
    stopApp,
    step,
    failure,
    finalize,
    startAudio,
    capturePcm,
    installAddon,
    configureSoftwareDecoding,
    redact,
  };
}
