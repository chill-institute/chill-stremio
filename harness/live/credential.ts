import { fstatSync, writeSync } from "node:fs";
import { Schema } from "effect";
import { credentialPattern } from "../../src/credential.ts";
import { AllowanceFailure } from "./allowance.ts";
import { AuthSessionFailure } from "./auth-session.ts";
import { authorizeChill, ChillAuthorizationFailure } from "./auth.ts";

// Mints the designated account's add-on credential for the post-deploy canary.
// The value goes only to stdout, and only when stdout is a pipe or an
// owner-only file, so it is never printed to a terminal.
const Issued = Schema.Struct({
  credential: Schema.String.check(Schema.isPattern(credentialPattern)),
});
const Rejection = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^[a-z_]{1,64}$/)),
});

export class CredentialMintFailure extends Error {
  constructor(reason: string) {
    super(`Add-on credential not minted: ${reason}`);
    this.name = "CredentialMintFailure";
  }
}

export function privateOutput(fd: number) {
  const output = fstatSync(fd);
  return (
    output.isFIFO() ||
    output.isSocket() ||
    (output.isFile() && (output.mode & 0o077) === 0)
  );
}

/** Engine issues the bearer's account a credential for its download folder. */
export async function issueCredential(options: {
  token: string;
  apiOrigin?: string;
  signal?: AbortSignal;
}) {
  let response: Response;
  try {
    response = await fetch(
      `${options.apiOrigin ?? "https://api.chill.institute"}/stremio/credential`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${options.token}` },
        redirect: "error",
        signal: options.signal ?? AbortSignal.timeout(20_000),
      },
    );
  } catch {
    throw new CredentialMintFailure("Engine unreachable");
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok)
    throw new CredentialMintFailure(
      `Engine answered ${response.status}${Schema.is(Rejection)(body) ? ` ${body.code}` : ""}`,
    );
  if (!Schema.is(Issued)(body))
    throw new CredentialMintFailure("Engine returned no add-on credential");
  return body.credential;
}

if (import.meta.main) {
  try {
    if (!privateOutput(1))
      throw new CredentialMintFailure(
        "stdout must be a pipe or a file with mode 0600",
      );
    writeSync(1, await issueCredential({ token: await authorizeChill() }));
  } catch (error) {
    process.exitCode = 1;
    console.error(
      error instanceof CredentialMintFailure ||
        error instanceof ChillAuthorizationFailure ||
        error instanceof AuthSessionFailure ||
        error instanceof AllowanceFailure
        ? error.message
        : "Add-on credential not minted",
    );
  }
}
