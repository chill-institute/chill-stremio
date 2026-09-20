import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toJsonString } from "@bufbuild/protobuf";
import {
  AddTransferResponseSchema,
  UserSettingsSchema,
} from "@chill-institute/contracts/chill/v4/api_pb";
import { test } from "vite-plus/test";
import {
  extendForOneAttempt,
  requestSelectedMedia,
  startFixtureDiscoveryProxy,
} from "../harness/live/hosted.ts";
import { readLedger, utcDay } from "../harness/live/allowance.ts";

test("explicit hosted allowance extension preserves usage and adds only bounded required headroom", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hosted-allowance-fixture-"));
  try {
    const path = join(directory, "allowance.json");
    const initial = {
      day: utcDay(),
      reservedTransfers: 12,
      reservedBytes: 1024 * 1024 * 1024,
      approvedLimits: {
        transferLimit: 12,
        byteLimit: 1024 * 1024 * 1024,
        reason: "Earlier explicit approval",
      },
    };
    await writeFile(path, JSON.stringify(initial), { mode: 0o600 });
    await extendForOneAttempt(
      directory,
      1175984,
      "Single fixture proof approval",
    );
    const ledger = await readLedger(path);
    assert.equal(ledger.reservedTransfers, initial.reservedTransfers);
    assert.equal(ledger.reservedBytes, initial.reservedBytes);
    assert.equal("transferLimit" in (ledger.approvedLimits ?? {}), false);
    assert.equal(
      ledger.approvedLimits?.byteLimit,
      initial.reservedBytes + 1175984,
    );
    assert.equal(
      ledger.approvedLimits?.reason,
      "Earlier explicit approval; Single fixture proof approval",
    );
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(readFile(join(directory, "allowance.lock")), {
      code: "ENOENT",
    });
    await assert.rejects(readFile(`${path}.next`), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function upstream() {
  let submitted = 0;
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer fixture-owner");
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("GetUserSettings"))
      response.end(
        toJsonString(
          UserSettingsSchema,
          create(UserSettingsSchema, { download: { folderId: 0n } }),
        ),
      );
    else if (request.url?.endsWith("AddTransfer")) {
      submitted++;
      response.end(
        toJsonString(
          AddTransferResponseSchema,
          create(AddTransferResponseSchema, {
            transfer: {
              id: 90n,
              saveParentId: 0n,
              fileId: 21n,
              status: "COMPLETED",
              isFinished: true,
            },
          }),
        ),
      );
    } else {
      response.writeHead(404);
      response.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    get submitted() {
      return submitted;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

test("live proxy admits one exact owned source and checkpoints result before responding", async () => {
  const engine = await upstream();
  const source = "https://fixture.example/owned-source?token=fixture-only";
  const observations: bigint[] = [];
  const proxy = await startFixtureDiscoveryProxy(
    "fixture-owner",
    source,
    587992,
    0n,
    async (transfer) => {
      observations.push(transfer.id);
      assert.equal(transfer.saveParentId, 0n);
    },
    engine.origin,
  );
  const post = (method: string, body: unknown, token = "fixture-owner") =>
    fetch(`${proxy.origin}/chill.v4.UserService/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (
        await post("AddTransfer", {
          url: "https://fixture.example/other-source",
        })
      ).status,
      503,
    );
    assert.equal((await post("GetDownloadFolder", {})).status, 503);
    assert.equal(
      (await post("AddTransfer", { url: source }, "wrong-token")).status,
      503,
    );
    assert.equal(engine.submitted, 0);
    const generated = await post("GetMovies", {});
    assert.equal(generated.status, 200);
    assert.equal(engine.submitted, 0);
    const concurrent = await Promise.all([
      post("AddTransfer", { url: source }),
      post("AddTransfer", { url: source }),
    ]);
    assert.deepEqual(
      concurrent
        .map((response) => response.status)
        .sort((left, right) => left - right),
      [200, 503],
    );
    assert.deepEqual(observations, [90n]);
    assert.equal((await post("AddTransfer", { url: source })).status, 503);
    assert.equal(engine.submitted, 1);
  } finally {
    await proxy.close();
    await engine.close();
  }
});

test("failed result checkpoint cannot cause the proxy to submit the source twice", async () => {
  const engine = await upstream();
  const source = "https://fixture.example/owned-source";
  const proxy = await startFixtureDiscoveryProxy(
    "fixture-owner",
    source,
    587992,
    0n,
    async () => {
      throw new Error("fixture checkpoint failure");
    },
    engine.origin,
  );
  try {
    const submit = () =>
      fetch(`${proxy.origin}/chill.v4.UserService/AddTransfer`, {
        method: "POST",
        headers: {
          authorization: "Bearer fixture-owner",
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: source }),
      });
    assert.equal((await submit()).status, 503);
    assert.equal((await submit()).status, 503);
    assert.equal(engine.submitted, 1);
  } finally {
    await proxy.close();
    await engine.close();
  }
});

test("media-selection proof issues read-only HEAD then GET without following credential redirects", async () => {
  const calls: string[] = [];
  let origin = "";
  let destination = "";
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, undefined);
    calls.push(`${request.method} ${request.url}`);
    if (request.method === "HEAD") {
      response.writeHead(200, { "content-type": "video/mp4" }).end();
    } else {
      response.writeHead(302, { location: destination }).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    const path =
      "/i/fixture-capability/play/movie/fixture-target/fixture-release.mp4";
    destination = `${origin}/i/fixture-capability/notice/pending.mp4`;
    await requestSelectedMedia(origin, path, "HEAD");
    await requestSelectedMedia(origin, path, "GET");
    destination = "https://fixture.invalid/media?download-token=fake-only";
    await requestSelectedMedia(origin, path, "GET");
    assert.deepEqual(calls, [`HEAD ${path}`, `GET ${path}`, `GET ${path}`]);
    for (const invalid of [
      "https://fixture.invalid/play.mp4",
      "/api/installations",
      `${path}?token=fake`,
      `${path}#fragment`,
    ]) {
      await assert.rejects(requestSelectedMedia(origin, invalid, "GET"), {
        code: "hosted_probe_failed",
      });
    }
    assert.equal(calls.length, 3);
    destination = `${origin}/unexpected-page`;
    await assert.rejects(requestSelectedMedia(origin, path, "GET"), {
      code: "hosted_probe_failed",
    });
    assert.equal(calls.length, 4);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
