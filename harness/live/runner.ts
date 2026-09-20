import { createHash } from "node:crypto";
import { lstat, readFile, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { AllowanceFailure, readLedger } from "./allowance.ts";
import { liveVersions } from "./versions.ts";

const Registration = Schema.Struct({
  version: Schema.Literal(2),
  account: Schema.NonEmptyString,
  username: Schema.NonEmptyString,
  machineIdSha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  uid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export interface RunnerIdentity {
  platform: string;
  account: string;
  username: string;
  uid: number;
  home: string;
  machineIdSha256: string;
}

export const runnerDirectory = (home: string) =>
  join(home, ".local/state/chill-stremio/live/runner");

const currentIdentity = async (): Promise<RunnerIdentity> => {
  if (process.platform !== "linux")
    throw new AllowanceFailure(
      "Live probes must run on the registered Linux executor",
    );
  const user = userInfo();
  let machineId: string;
  try {
    machineId = Schema.decodeUnknownSync(
      Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
    )((await readFile("/etc/machine-id", "utf8")).trim());
  } catch (cause) {
    throw new AllowanceFailure(
      "Live executor machine identity is unavailable",
      { cause },
    );
  }
  return {
    platform: process.platform,
    account: process.env[liveVersions.accountNameEnv]?.trim() ?? "",
    username: user.username,
    uid: user.uid,
    home: user.homedir,
    machineIdSha256: createHash("sha256").update(machineId).digest("hex"),
  };
};

export async function registeredLiveRunner(
  identity?: RunnerIdentity,
  now = new Date(),
) {
  const current = identity ?? (await currentIdentity());
  if (current.platform !== "linux")
    throw new AllowanceFailure(
      "Live probes must run as the dedicated user on the registered Linux executor",
    );
  const directory = runnerDirectory(current.home);
  try {
    const registrationPath = join(directory, "runner.json");
    const [owner, registrationFile] = await Promise.all([
      lstat(directory),
      lstat(registrationPath),
    ]);
    if (
      !owner.isDirectory() ||
      !registrationFile.isFile() ||
      owner.uid !== current.uid ||
      registrationFile.uid !== current.uid ||
      (owner.mode & 0o077) !== 0 ||
      (registrationFile.mode & 0o077) !== 0
    )
      throw new Error(
        "Runner state must be private, regular and owned by the executor",
      );
    const registration = Schema.decodeUnknownSync(Registration)(
      JSON.parse(await readFile(registrationPath, "utf8")),
    );
    if (
      registration.machineIdSha256 !== current.machineIdSha256 ||
      registration.uid !== current.uid ||
      registration.username !== current.username ||
      registration.account !== current.account
    )
      throw new Error(
        "Executor registration does not match this host and user",
      );
    const ledger = await lstat(join(directory, "allowance.json"));
    if (
      !ledger.isFile() ||
      ledger.uid !== current.uid ||
      (ledger.mode & 0o077) !== 0
    )
      throw new Error(
        "Allowance ledger must be a private regular file owned by the executor",
      );
    await readLedger(join(directory, "allowance.json"), now);
  } catch (cause) {
    throw new AllowanceFailure(
      "Registered live executor state is unavailable or does not match; use the designated executor and reconcile its allowance",
      { cause },
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
