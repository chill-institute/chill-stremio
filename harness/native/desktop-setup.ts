import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { desktopVersions as versions } from "./desktop-versions.ts";

const execute = promisify(execFile);
const installation = join(homedir(), ".local/share/chill-stremio/flatpak");
const env = { ...process.env, FLATPAK_USER_DIR: installation };
const run = async (args: string[]) => {
  const { stdout } = await execute("flatpak", args, {
    env,
    timeout: 15 * 60_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
};

if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch))
  throw new Error(
    "Desktop setup requires Linux x86_64 or ARM64; no native pins exist for this architecture",
  );

for (const executable of [
  "flatpak",
  "bwrap",
  "pulseaudio",
  "pactl",
  "xdotool",
  "xclip",
  "Xvfb",
  "xvfb-run",
  "xauth",
  "dbus-run-session",
  "ffmpeg",
  "tesseract",
  "timeout",
])
  await execute("which", [executable], { timeout: 5000 }).catch(() => {
    throw new Error(
      `Missing ${executable}; install the Linux packages listed in docs/native-desktop.md`,
    );
  });
await mkdir(installation, { recursive: true });
await run([
  "remote-add",
  "--user",
  "--if-not-exists",
  "flathub",
  "https://dl.flathub.org/repo/flathub.flatpakrepo",
]);
const commitOf = (ref: string) => run(["info", "--user", "--show-commit", ref]);
await run([
  "install",
  "--user",
  "--noninteractive",
  "--assumeyes",
  "--or-update",
  "flathub",
  versions.runtime,
]);
const installed = await commitOf(versions.client).catch(() => undefined);
if (installed !== versions.clientCommit) {
  if (!installed)
    await run([
      "install",
      "--user",
      "--noninteractive",
      "--assumeyes",
      "flathub",
      versions.client,
    ]);
  await run([
    "update",
    "--user",
    "--noninteractive",
    "--assumeyes",
    `--commit=${versions.clientCommit}`,
    versions.client,
  ]).catch((cause: unknown) => {
    if (String(cause).includes("no signatures found"))
      throw new Error(
        `Flathub no longer signs ${versions.client} commit ${versions.clientCommit}; pin a signed commit that passes both desktop modes`,
        { cause },
      );
    throw cause;
  });
}
if ((await commitOf(versions.client)) !== versions.clientCommit)
  throw new Error(`Flatpak commit verification failed for ${versions.client}`);
await run(["run", "--user", "--command=true", versions.client]);
console.log(
  JSON.stringify({
    status: "ready",
    platform: "linux",
    versions: { ...versions, runtimeCommit: await commitOf(versions.runtime) },
  }),
);
