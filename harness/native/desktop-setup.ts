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

if (process.platform !== "linux" || process.arch !== "x64")
  throw new Error(
    "Desktop setup requires Linux x86_64; no native pins exist for this architecture",
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
      `Missing ${executable}; install the Linux packages listed in docs/NATIVE-DESKTOP.md`,
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
for (const [ref, commit] of [
  [versions.runtime, versions.runtimeCommit],
  [versions.client, versions.clientCommit],
] as const) {
  const installed = await run(["info", "--user", "--show-commit", ref]).catch(
    () => undefined,
  );
  if (installed !== commit) {
    if (!installed)
      await run([
        "install",
        "--user",
        "--noninteractive",
        "--assumeyes",
        "flathub",
        ref,
      ]);
    await run([
      "update",
      "--user",
      "--noninteractive",
      "--assumeyes",
      `--commit=${commit}`,
      ref,
    ]);
  }
  if ((await run(["info", "--user", "--show-commit", ref])) !== commit)
    throw new Error(`Flatpak commit verification failed for ${ref}`);
}
await run(["run", "--user", "--command=true", versions.client]);
console.log(JSON.stringify({ status: "ready", platform: "linux", versions }));
