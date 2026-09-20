import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import {
  removeOwnedAddon,
  installOwnedAddon,
  loginDesignatedAccount,
  isDesignatedStremioAccount,
} from "../harness/live/stremio-account.ts";

const requestUrl = (input: Parameters<typeof fetch>[0]) =>
  input instanceof Request ? input.url : input.toString();

const owned = {
  transportUrl: "http://127.0.0.1:7000/owned/manifest.json",
  manifest: { id: "example" },
};
const other = {
  transportUrl: "http://127.0.0.1:7001/other/manifest.json",
  manifest: { id: "example" },
  flags: { protected: true },
};

test("cleanup preserves unrelated descriptors including the same manifest ID and verifies remote absence", async () => {
  let collection = [owned, other];
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const method = new URL(requestUrl(input)).pathname.split("/").at(-1);
    calls.push(method ?? "");
    assert.equal(options?.redirect, "error");
    assert.ok(typeof options?.body === "string");
    const body = JSON.parse(options.body);
    assert.equal(body.authKey, "private-session");
    if (method === "addonCollectionSet") {
      assert.deepEqual(body.addons, [other]);
      collection = body.addons;
      return Response.json({ result: true });
    }
    return Response.json({ result: { addons: collection } });
  };
  await removeOwnedAddon("private-session", owned.transportUrl, fetcher);
  assert.deepEqual(calls, [
    "addonCollectionGet",
    "addonCollectionSet",
    "addonCollectionGet",
  ]);
});

test("an absent owned addon causes no account write", async () => {
  const fetcher: typeof fetch = async (input) => {
    assert.ok(requestUrl(input).endsWith("addonCollectionGet"));
    return Response.json({ result: { addons: [other] } });
  };
  await removeOwnedAddon("private-session", owned.transportUrl, fetcher);
});

test("HTTP success cannot hide a rejected account write or stale remote collection", async () => {
  for (const rejected of [true, false]) {
    const fetcher: typeof fetch = async (input) => {
      if (requestUrl(input).endsWith("addonCollectionSet"))
        return Response.json(
          rejected
            ? { error: { message: "private-session" } }
            : { result: true },
        );
      return Response.json({ result: { addons: [owned, other] } });
    };
    await assert.rejects(
      () => removeOwnedAddon("private-session", owned.transportUrl, fetcher),
      { message: "Owned addon cleanup failed" },
    );
  }
});

test("oversized or malformed collections stop cleanup before a write and stay redacted", async () => {
  for (const response of [
    Response.json({ result: { addons: [{ secret: "private-session" }] } }),
    new Response("private-session".repeat(100000)),
  ]) {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return response;
    };
    await assert.rejects(
      () => removeOwnedAddon("private-session", owned.transportUrl, fetcher),
      { message: "Owned addon cleanup failed" },
    );
    assert.equal(calls, 1);
  }
});

test("owned installation preserves existing descriptors and checks the fresh remote collection", async () => {
  let collection: unknown[] = [other];
  const descriptor = { ...owned, flags: { protected: false as const } };
  const fetcher: typeof fetch = async (input, options) => {
    if (requestUrl(input).endsWith("addonCollectionSet")) {
      assert.ok(typeof options?.body === "string");
      const body = JSON.parse(options.body);
      assert.deepEqual(body.addons, [other, descriptor]);
      collection = [
        ...body.addons.slice(0, -1),
        { ...body.addons.at(-1), installedAt: "provider-metadata" },
      ];
      return Response.json({ result: true });
    }
    return Response.json({ result: { addons: collection } });
  };
  let attempts = 0;
  const onWrite = () => {
    attempts++;
  };
  await installOwnedAddon("private-session", descriptor, fetcher, onWrite);
  await assert.rejects(
    () => installOwnedAddon("private-session", descriptor, fetcher, onWrite),
    { message: "Owned addon installation failed" },
  );
  assert.equal(attempts, 1);
});

test("account login rejects another identity and never exposes provider failures", async () => {
  vi.stubEnv("STREMIO_TEST_EMAIL", "fixture@example.com");
  try {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json({ error: { message: "private-password" } });
    };
    await assert.rejects(
      () =>
        loginDesignatedAccount(
          "other@example.com",
          "private-password",
          fetcher,
        ),
      { message: "Designated account required" },
    );
    assert.equal(calls, 0);
    await assert.rejects(
      () =>
        loginDesignatedAccount(
          "fixture@example.com",
          "private-password",
          fetcher,
        ),
      { message: "Designated account login failed" },
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

test("installation requires remote persistence and refuses malformed collections", async () => {
  for (const addons of [[other], [{ session: "private-session" }]]) {
    const fetcher: typeof fetch = async (input) =>
      Response.json(
        requestUrl(input).endsWith("addonCollectionSet")
          ? { result: true }
          : { result: { addons } },
      );
    await assert.rejects(
      () =>
        installOwnedAddon(
          "private-session",
          { ...owned, flags: { protected: false } },
          fetcher,
        ),
      { message: "Owned addon installation failed" },
    );
  }
});

test("installation failure stages reveal the failed operation without provider data", async () => {
  for (const failed of ["read", "write", "readback", "verify"]) {
    const stages: string[] = [];
    let reads = 0;
    const fetcher: typeof fetch = async (input) => {
      const writing = requestUrl(input).endsWith("addonCollectionSet");
      const operation = writing ? "write" : ++reads === 1 ? "read" : "readback";
      if (operation === failed)
        return Response.json({
          error: { message: "password=secret https://private.example AB12" },
        });
      return Response.json(
        writing ? { result: true } : { result: { addons: [other] } },
      );
    };
    await assert.rejects(
      () =>
        installOwnedAddon(
          "private-session",
          { ...owned, flags: { protected: false } },
          fetcher,
          () => {},
          (stage) => stages.push(stage),
        ),
      { message: "Owned addon installation failed" },
    );
    assert.equal(stages.at(-1), failed);
    assert.ok(
      stages.every((stage) =>
        ["read", "write", "readback", "verify"].includes(stage),
      ),
    );
  }
});

test("installation diagnosis distinguishes missing address, changed descriptor and lost baseline without payloads", async () => {
  const descriptor = { ...owned, flags: { protected: false as const } };
  const cases = [
    { after: [other], count: 0, manifest: false, flags: false, baseline: true },
    {
      after: [
        other,
        { ...descriptor, manifest: { private: "private-capability" } },
      ],
      count: 1,
      manifest: false,
      flags: true,
      baseline: true,
    },
    {
      after: [other, { ...descriptor, flags: { protected: true } }],
      count: 1,
      manifest: true,
      flags: false,
      baseline: true,
    },
    {
      after: [descriptor],
      count: 1,
      manifest: true,
      flags: true,
      baseline: false,
    },
  ];
  for (const scenario of cases) {
    let reads = 0;
    let observed: unknown;
    const fetcher: typeof fetch = async (input) =>
      Response.json(
        requestUrl(input).endsWith("addonCollectionSet")
          ? { result: true }
          : { result: { addons: ++reads === 1 ? [other] : scenario.after } },
      );
    await assert.rejects(
      () =>
        installOwnedAddon(
          "private-session",
          descriptor,
          fetcher,
          () => {},
          () => {},
          {
            verification: (value) => {
              observed = value;
            },
          },
        ),
      { message: "Owned addon installation failed" },
    );
    assert.deepEqual(observed, {
      descriptorsValid: true,
      ownedAddressCount: scenario.count,
      ownedManifestMatches: scenario.manifest,
      ownedFlagsMatch: scenario.flags,
      ownedDescriptorMatches: scenario.manifest && scenario.flags,
      baselinePreserved: scenario.baseline,
    });
    assert.ok(!JSON.stringify(observed).includes("private-capability"));
  }
});

test("Stremio account checks fail closed without a configured test identity", () => {
  try {
    for (const expected of [undefined, "", "   "]) {
      vi.stubEnv("STREMIO_TEST_EMAIL", expected);
      assert.equal(isDesignatedStremioAccount("fixture@example.com"), false);
      assert.equal(isDesignatedStremioAccount(undefined), false);
    }
  } finally {
    vi.unstubAllEnvs();
  }
});
