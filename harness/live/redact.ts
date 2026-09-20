import { stripVTControlCharacters } from "node:util";

import { liveVersions } from "./versions.ts";

export function redactLive(value: string) {
  if (
    /pubkey|public key|token|authorization|password|cookie|secret|jwt|magnet:\?|infohash|otp|@/i.test(
      value,
    )
  )
    return "[redacted]";
  return stripVTControlCharacters(value)
    .replace(/https?:\/\/\S+/g, "[url]")
    .replaceAll(process.cwd(), "[checkout]")
    .replaceAll(process.env.HOME ?? "\u0000", "[home]");
}

const filled = (name: string) => {
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0;
};

export function designatedAccountPresent() {
  return (
    filled(liveVersions.accountNameEnv) &&
    filled(liveVersions.usernameEnv) &&
    filled(liveVersions.passwordEnv) &&
    filled(liveVersions.otpEnv)
  );
}

export function designatedPutioTokenPresent() {
  return filled(liveVersions.putioTokenEnv);
}
