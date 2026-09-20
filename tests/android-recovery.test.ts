import { expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAndroidRecoveryJournal,
  descriptorHash,
  reconcileAndroidRecoveryJournal,
} from "../harness/native/android-recovery.ts";
import {
  installOwnedAddon,
  removeOwnedAddon,
} from "../harness/live/stremio-account.ts";

const requestUrl = (input: Parameters<typeof fetch>[0]) =>
  input instanceof Request ? input.url : input.toString();

const owned = {
  transportUrl: "http://127.0.0.1:43210/manifest.json",
  manifest: { id: "fixture" },
  flags: { protected: false as const },
};
const other = {
  transportUrl: "https://private.example/secret-capability/manifest.json",
  manifest: { id: "other" },
  flags: { protected: true },
};

test("recovery journal is private, contains only baseline hashes, and verifies exact absence", async () => {
  const root = await mkdtemp(join(tmpdir(), "android-recovery-test-"));
  try {
    const journal = await createAndroidRecoveryJournal(
      owned.transportUrl,
      [other],
      root,
    );
    expect((await stat(join(root, journal.id))).mode & 0o777).toBe(0o700);
    expect((await stat(journal.path)).mode & 0o777).toBe(0o600);
    const prepared = await readFile(journal.path, "utf8");
    expect(prepared).not.toContain("secret-capability");
    expect(JSON.parse(prepared).baselineHashes).toEqual([
      descriptorHash(other),
    ]);
    expect(descriptorHash({ b: 1, a: { z: 2, y: 3 } })).toBe(
      descriptorHash({ a: { y: 3, z: 2 }, b: 1 }),
    );
    await expect(
      reconcileAndroidRecoveryJournal(journal, [owned, other]),
    ).rejects.toThrow();
    expect(JSON.parse(await readFile(journal.path, "utf8")).state).toBe(
      "uncertain",
    );
    await expect(
      reconcileAndroidRecoveryJournal(journal, []),
    ).rejects.toThrow();
    await reconcileAndroidRecoveryJournal(journal, [other]);
    expect(JSON.parse(await readFile(journal.path, "utf8")).state).toBe(
      "removal-verified",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline journal completes before mutation and cleanup reports verified readback", async () => {
  let prepared = false;
  let verified = false;
  let collection: unknown[] = [other];
  const fetcher: typeof fetch = async (input, options) => {
    if (requestUrl(input).endsWith("addonCollectionSet")) {
      expect(prepared).toBe(true);
      if (typeof options?.body !== "string")
        throw new Error("Expected account JSON");
      const body = JSON.parse(options.body);
      collection = body.addons;
      return Response.json({ result: true });
    }
    return Response.json({ result: { addons: collection } });
  };
  await installOwnedAddon(
    "private-auth",
    owned,
    fetcher,
    () => {},
    () => {},
    {
      beforeWrite: async (baseline) => {
        expect(baseline).toEqual([other]);
        await Promise.resolve();
        prepared = true;
      },
    },
  );
  await removeOwnedAddon(
    "private-auth",
    owned.transportUrl,
    fetcher,
    async (after) => {
      expect(after).toEqual([other]);
      verified = true;
    },
  );
  expect(verified).toBe(true);
});

test("failed recovery preparation prevents account mutation", async () => {
  const fetcher: typeof fetch = async (input) => {
    expect(requestUrl(input).endsWith("addonCollectionGet")).toBe(true);
    return Response.json({ result: { addons: [other] } });
  };
  await expect(
    installOwnedAddon(
      "private-auth",
      owned,
      fetcher,
      () => {},
      () => {},
      {
        beforeWrite: async () => {
          throw new Error("private path");
        },
      },
    ),
  ).rejects.toThrow("Owned addon installation failed");
});
