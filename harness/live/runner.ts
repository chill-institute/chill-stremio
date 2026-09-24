import type { Stats } from "node:fs";
import { lstat, mkdir, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  AllowanceFailure,
  createMissingLedger,
  readLedger,
} from "./allowance.ts";

export const liveRunnerPath = (home: string) =>
  join(home, ".local/state/chill-stremio/live/runner");

const isPrivate = (file: Stats, uid: number | undefined) =>
  file.uid === uid && (file.mode & 0o077) === 0;

export async function liveRunnerDirectory(
  home = userInfo().homedir,
  now = new Date(),
) {
  const directory = liveRunnerPath(home);
  const uid = process.getuid?.();
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const owner = await lstat(directory);
    if (!owner.isDirectory() || !isPrivate(owner, uid))
      throw new AllowanceFailure(
        `${directory} must be a directory owned by this user with mode 0700`,
      );
    await createMissingLedger(directory, now);
    const path = join(directory, "allowance.json");
    const ledger = await lstat(path);
    if (!ledger.isFile() || !isPrivate(ledger, uid))
      throw new AllowanceFailure(
        `${path} must be a regular file owned by this user with mode 0600`,
      );
    await readLedger(path, now);
  } catch (cause) {
    if (cause instanceof AllowanceFailure) throw cause;
    throw new AllowanceFailure(
      `Live runner state in ${directory} is unavailable`,
      {
        cause,
      },
    );
  }
  return directory;
}

export async function measureLivePayloads(paths: {
  media: string;
  srt: string;
  vtt: string;
}) {
  const [media, srt, vtt] = await Promise.all([
    stat(paths.media),
    stat(paths.srt),
    stat(paths.vtt),
  ]);
  for (const file of [media, srt, vtt])
    if (!file.isFile() || !Number.isSafeInteger(file.size) || file.size < 1)
      throw new AllowanceFailure(
        "Every live payload must be a nonempty regular file",
      );
  const bytes = media.size * 2 + srt.size + vtt.size;
  if (!Number.isSafeInteger(bytes))
    throw new AllowanceFailure(
      "Live payload bytes exceed safe accounting limits",
    );
  return { transfers: 4, bytes };
}
