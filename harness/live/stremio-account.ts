import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";

const Collection = Schema.Struct({ addons: Schema.Array(Schema.Unknown) });
const Descriptor = Schema.Struct({ transportUrl: Schema.String });
const Envelope = Schema.Struct({ result: Schema.Unknown });

async function accountCall(
  method: "addonCollectionGet" | "addonCollectionSet" | "login",
  body: Record<string, unknown>,
  fetcher: typeof fetch,
) {
  const response = await fetcher(`https://api.strem.io/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (response.status !== 200 || !response.body)
    throw new Error("Account request failed");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new Error("Account response exceeded limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const error = Schema.decodeUnknownSync(
    Schema.Struct({ error: Schema.optional(Schema.Unknown) }),
  )(raw);
  if (error.error) throw new Error("Account request rejected");
  return Schema.decodeUnknownSync(Envelope)(raw).result;
}

export async function removeOwnedAddon(
  authKey: string,
  manifestUrl: string,
  fetcher: typeof fetch = fetch,
  onVerified?: (addons: readonly unknown[]) => Promise<void>,
) {
  try {
    const read = async () =>
      Schema.decodeUnknownSync(Collection)(
        await accountCall("addonCollectionGet", { authKey }, fetcher),
      ).addons;
    const address = (item: unknown) =>
      Schema.decodeUnknownSync(Descriptor)(item).transportUrl;
    const before = await read();
    const desired = before.filter((item) => address(item) !== manifestUrl);
    if (before.length !== desired.length)
      await accountCall(
        "addonCollectionSet",
        { authKey, addons: desired },
        fetcher,
      );
    const after = await read();
    if (
      after.some((item) => address(item) === manifestUrl) ||
      !desired.every((item) =>
        after.some((other) => isDeepStrictEqual(item, other)),
      )
    )
      throw new Error("Account cleanup was not confirmed");
    await onVerified?.(after);
  } catch {
    throw new Error("Owned addon cleanup failed");
  }
}

export interface AddonInstallationVerification {
  descriptorsValid: boolean;
  ownedAddressCount: number;
  ownedManifestMatches: boolean;
  ownedFlagsMatch: boolean;
  ownedDescriptorMatches: boolean;
  baselinePreserved: boolean;
}

export async function installOwnedAddon(
  authKey: string,
  descriptor: {
    transportUrl: string;
    manifest: unknown;
    flags: { protected: false };
  },
  fetcher: typeof fetch = fetch,
  onWrite: () => void = () => {},
  onStage: (stage: "read" | "write" | "readback" | "verify") => void = () => {},
  observer?: {
    beforeWrite?: (baseline: readonly unknown[]) => Promise<void>;
    verification?: (result: AddonInstallationVerification) => void;
  },
) {
  try {
    const read = async () =>
      Schema.decodeUnknownSync(Collection)(
        await accountCall("addonCollectionGet", { authKey }, fetcher),
      ).addons;
    onStage("read");
    const before = await read();
    if (
      before.some(
        (item) =>
          Schema.decodeUnknownSync(Descriptor)(item).transportUrl ===
          descriptor.transportUrl,
      )
    )
      throw new Error("Owned address already installed");
    await observer?.beforeWrite?.(before);
    onStage("write");
    onWrite();
    await accountCall(
      "addonCollectionSet",
      { authKey, addons: [...before, descriptor] },
      fetcher,
    );
    onStage("readback");
    const after = await read();
    onStage("verify");
    const verification: AddonInstallationVerification = {
      descriptorsValid: false,
      ownedAddressCount: 0,
      ownedManifestMatches: false,
      ownedFlagsMatch: false,
      ownedDescriptorMatches: false,
      baselinePreserved: before.every((item) =>
        after.some((other) => isDeepStrictEqual(item, other)),
      ),
    };
    const Installed = Schema.Struct({
      transportUrl: Schema.String,
      manifest: Schema.Unknown,
      flags: Schema.Unknown,
    });
    let installed: readonly (typeof Installed.Type)[];
    try {
      installed = after.map((item) =>
        Schema.decodeUnknownSync(Installed)(item),
      );
    } catch {
      observer?.verification?.(verification);
      throw new Error("Installation verification failed");
    }
    verification.descriptorsValid = true;
    const owned = installed.filter(
      (item) => item.transportUrl === descriptor.transportUrl,
    );
    verification.ownedAddressCount = owned.length;
    verification.ownedManifestMatches = owned.some((item) =>
      isDeepStrictEqual(item.manifest, descriptor.manifest),
    );
    verification.ownedFlagsMatch = owned.some((item) =>
      isDeepStrictEqual(item.flags, descriptor.flags),
    );
    verification.ownedDescriptorMatches = owned.some(
      (item) =>
        isDeepStrictEqual(item.manifest, descriptor.manifest) &&
        isDeepStrictEqual(item.flags, descriptor.flags),
    );
    observer?.verification?.(verification);
    if (!verification.ownedDescriptorMatches || !verification.baselinePreserved)
      throw new Error("Installation verification failed");
  } catch {
    throw new Error("Owned addon installation failed");
  }
}

export function isDesignatedStremioAccount(email: string | undefined): boolean {
  const expected = process.env.STREMIO_TEST_EMAIL?.trim();
  return !!expected && email === expected;
}

export async function loginDesignatedAccount(
  email: string,
  password: string,
  fetcher: typeof fetch = fetch,
) {
  if (!isDesignatedStremioAccount(email))
    throw new Error("Designated account required");
  try {
    const result = Schema.decodeUnknownSync(
      Schema.Struct({
        authKey: Schema.NonEmptyString,
        user: Schema.Struct({ email: Schema.String }),
      }),
    )(await accountCall("login", { email, password }, fetcher));
    if (result.user.email !== email) throw new Error("Account mismatch");
    return result.authKey;
  } catch {
    throw new Error("Designated account login failed");
  }
}
