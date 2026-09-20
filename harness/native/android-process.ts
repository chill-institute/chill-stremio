import { stripVTControlCharacters } from "node:util";
import { access, realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { constants } from "node:fs";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess } from "effect/unstable/process";

export class AndroidFailure extends Schema.TaggedError<AndroidFailure>()(
  "AndroidFailure",
  {
    stage: Schema.String,
    message: Schema.String,
    code: Schema.optional(Schema.String),
    exitCode: Schema.optional(Schema.Number),
  },
) {}

export const executable = async (name: string) => {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const path = join(directory, name);
    try {
      await access(path, constants.X_OK);
      return await realpath(path);
    } catch {}
  }
  throw new Error(`Install ${name} through the runner's Android SDK tooling`);
};

export function diagnostic(line: string) {
  if (
    /pubkey|public key|token|authorization|password|cookie|secret|jwt|@/i.test(
      line,
    )
  )
    return "[redacted]";
  return stripVTControlCharacters(line)
    .replace(/https?:\/\/\S+/g, "[url]")
    .replaceAll(process.cwd(), "[checkout]")
    .replaceAll(process.env.HOME ?? "\u0000", "[home]");
}

const installFailures = new Set([
  "INSTALL_FAILED_INSUFFICIENT_STORAGE",
  "INSTALL_FAILED_INVALID_APK",
  "INSTALL_FAILED_NO_MATCHING_ABIS",
  "INSTALL_FAILED_OLDER_SDK",
  "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
  "INSTALL_FAILED_VERSION_DOWNGRADE",
  "INSTALL_FAILED_USER_RESTRICTED",
  "INSTALL_FAILED_INTERNAL_ERROR",
  "INSTALL_FAILED_DEXOPT",
  "INSTALL_PARSE_FAILED_NO_CERTIFICATES",
]);

export function packageManagerFailure(output: string) {
  const code = output.match(/Failure \[([A-Z_]+)(?::|\])/)?.[1];
  if (code && installFailures.has(code)) return code;
  if (
    /device offline|device .*not found|transport.*(closed|error)|connection (reset|closed)|broken pipe/i.test(
      output,
    )
  )
    return "install-transport-disconnected";
  if (
    /unexpected eof|failed to read.*(response|status)|end of file/i.test(output)
  )
    return "install-transport-eof";
  if (
    /can't find service: package|package manager.*(not available|unavailable)|service.*package.*not found/i.test(
      output,
    )
  )
    return "install-package-service-unavailable";
  if (
    /user.*(locked|not running)|credential encrypted.*unavailable/i.test(output)
  )
    return "install-user-locked";
  if (
    /exception occurred while executing.*install|java\.[\w.]+Exception/i.test(
      output,
    )
  )
    return "install-package-manager-exception";
  if (!output.trim()) return "install-empty-output";
  if (/adb: failed to install [^\n]+:\s*$/.test(output.trim()))
    return "install-empty-failure-detail";
  return "unclassified-install-failure";
}

export function emulatorAudioDiagnostic(line: string) {
  if (!/audio|pulse|\bpa:/i.test(line)) return undefined;
  if (/disabled|-no-audio|audio.*none/i.test(line)) return "audio-disabled";
  if (!/fail|error|not found|cannot|could not/i.test(line)) return undefined;
  return /pulse|\bpa:/i.test(line)
    ? "pulse-backend-error"
    : "audio-backend-error";
}

export const invoke = Effect.fn("native.android.invoke")(function* (
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  timeoutMs = 20_000,
) {
  const child = yield* ChildProcess.make(command, args, {
    env,
    stdin: "ignore",
    forceKillAfter: "3 seconds",
  });
  const [chunks, code] = yield* Effect.all([
    Stream.runCollect(child.all.pipe(Stream.decodeText())),
    child.exitCode,
  ]).pipe(Effect.timeout(timeoutMs));
  const output = chunks.join("");
  if (code !== 0)
    return yield* new AndroidFailure({
      stage: command.split("/").at(-1) ?? "command",
      message: diagnostic(output).slice(-2000),
      exitCode: Number(code),
      code: args.includes("install")
        ? packageManagerFailure(output)
        : undefined,
    });
  return output.trim();
}, Effect.scoped);

export const invokeBinary = Effect.fn("native.android.invokeBinary")(function* (
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
) {
  const child = yield* ChildProcess.make(command, args, {
    env,
    stdin: "ignore",
    stderr: "ignore",
    forceKillAfter: "3 seconds",
  });
  const [chunks, code] = yield* Effect.all([
    Stream.runCollect(child.stdout),
    child.exitCode,
  ]).pipe(Effect.timeout("20 seconds"));
  if (code !== 0)
    return yield* new AndroidFailure({
      stage: "capture",
      message: "Private frame capture failed",
    });
  return Buffer.concat(chunks);
}, Effect.scoped);
