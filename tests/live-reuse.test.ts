import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import * as proto from "@chill-institute/contracts/chill/v4/api_pb";
import { Effect, Exit, Schema } from "effect";
import { test } from "vite-plus/test";
import { readLedger, utcDay } from "../harness/live/allowance.ts";
import {
  carriesInfoHash,
  runTransferReuse,
  type ReuseProvider,
} from "../harness/live/reuse.ts";
import { reuseSource, singleFileInfoHash } from "../harness/live/source.ts";
import { liveVersions } from "../harness/live/versions.ts";

const credential = `v4.local.${"R".repeat(300)}`;
const nonce = "0".repeat(32);
const source = reuseSource(nonce);
const foreignHash = "a".repeat(40);

type Listed = Parameters<typeof carriesInfoHash>[0];

function fakePutio() {
  const transfers = new Map<number, Listed>([
    [
      7,
      {
        id: 7,
        status: "COMPLETED",
        source: `magnet:?xt=urn:btih:${foreignHash}`,
      },
    ],
    [8, { id: 8, status: "ERROR", hash: "b".repeat(40) }],
  ]);
  const cancelled: number[][] = [];
  let next = 4242;
  const provider: ReuseProvider = {
    accountInfo: () => Effect.succeed({ username: "fixture" }),
    listFolderIds: () => Effect.succeed([101, 102]),
    getTransfer: (id) => {
      const transfer = transfers.get(id);
      return transfer
        ? Effect.succeed(transfer)
        : Effect.fail(new Error("put.io HTTP 404"));
    },
    listTransfers: () => Effect.sync(() => [...transfers.values()]),
    cancelTransfers: (ids) =>
      Effect.sync(() => {
        cancelled.push([...ids]);
        for (const id of ids) transfers.delete(id);
      }),
  };
  return {
    provider,
    transfers,
    cancelled,
    add(url: string) {
      const id = next++;
      transfers.set(id, { id, status: "IN_QUEUE", hash: null, source: url });
      return id;
    },
  };
}

type Mode = "reuse" | "fresh" | "overlap" | "foreign";

async function fakeEngine(
  putio: ReturnType<typeof fakePutio>,
  mode: Mode,
  options: { root?: bigint[]; onAdd?: () => Promise<void> } = {},
) {
  let adds = 0;
  let inFlight = 0;
  const existing = (url: string) => {
    const infoHash = /urn:btih:([0-9a-f]{40})/.exec(url)?.[1] ?? "";
    return [...putio.transfers.values()].find(
      (transfer) =>
        transfer.status !== "ERROR" && carriesInfoHash(transfer, infoHash),
    )?.id;
  };
  const server = createServer((request, response) => {
    void (async () => {
      if (
        request.method !== "POST" ||
        request.headers.authorization !== undefined ||
        request.headers["x-chill-stremio-credential"] !== credential
      )
        throw new Error("rejected");
      let body = "";
      for await (const chunk of request) body += String(chunk);
      response.setHeader("content-type", "application/json");
      if (request.url === "/v4/chill.v4.UserService/GetFolder") {
        const input = fromJsonString(proto.GetFolderRequestSchema, body);
        assert.equal(input.id, 0n);
        response.end(
          toJsonString(
            proto.GetFolderResponseSchema,
            create(proto.GetFolderResponseSchema, {
              parent: { id: 0n },
              files: (options.root ?? [102n, 101n]).map((id) => ({ id })),
            }),
          ),
        );
        return;
      }
      assert.equal(request.url, "/v4/chill.v4.UserService/AddTransfer");
      const { url } = fromJsonString(proto.AddTransferRequestSchema, body);
      adds++;
      await options.onAdd?.();
      const order = inFlight++;
      await setTimeout(20);
      let id: number;
      if (mode === "foreign") id = 7;
      else if (mode === "fresh" || (mode === "overlap" && order > 0))
        id = putio.add(url);
      else id = existing(url) ?? putio.add(url);
      inFlight--;
      response.end(
        toJsonString(
          proto.AddTransferResponseSchema,
          create(proto.AddTransferResponseSchema, {
            status: "OK",
            transfer: { id: BigInt(id), status: "IN_QUEUE", source: url },
          }),
        ),
      );
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end('{"code":"internal"}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v4`,
    get adds() {
      return adds;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

const Receipt = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    proof: Schema.Struct({
      calls: Schema.Array(
        Schema.Struct({ phase: Schema.String, transfer: Schema.String }),
      ),
      distinctTransfers: Schema.Number,
      providerTransfers: Schema.optional(Schema.Number),
      providerStatus: Schema.optional(Schema.String),
      failureStage: Schema.optional(Schema.String),
      reservation: Schema.optional(
        Schema.Struct({ creations: Schema.Number, bytes: Schema.Number }),
      ),
    }),
    cleanup: Schema.Struct({
      status: Schema.String,
      pendingAcquisitions: Schema.Number,
    }),
  }),
);

async function runLane(
  mode: Mode,
  options: {
    reservedBytes?: number;
    root?: bigint[];
    onAdd?: (directory: string) => Promise<void>;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "live-reuse-"));
  const putio = fakePutio();
  const { onAdd } = options;
  const engine = await fakeEngine(putio, mode, {
    root: options.root,
    onAdd: onAdd && (() => onAdd(directory)),
  });
  try {
    await writeFile(
      join(directory, "allowance.json"),
      JSON.stringify({
        day: utcDay(),
        reservedTransfers: 2,
        reservedBytes: options.reservedBytes ?? 100,
      }),
      { mode: 0o600 },
    );
    const exit = await Effect.runPromiseExit(
      runTransferReuse({
        credential,
        engineBaseUrl: engine.baseUrl,
        username: "fixture",
        ledgerDirectory: async () => directory,
        provider: putio.provider,
        artifact: join(directory, "artifact"),
        journal: join(directory, "recovery", "reuse.json"),
        nonce,
      }),
    );
    const receiptText = await readFile(
      join(directory, "artifact", "results.json"),
      "utf8",
    );
    const journalPath = join(directory, "recovery", "reuse.json");
    const journal = await readFile(journalPath, "utf8").catch(() => "");
    return {
      exit,
      putio,
      adds: engine.adds,
      receiptText,
      receipt: Schema.decodeUnknownSync(Receipt)(receiptText),
      journal,
      journalMode: journal ? (await stat(journalPath)).mode & 0o777 : 0,
      ledger: await readLedger(join(directory, "allowance.json")),
    };
  } finally {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  }
}

const assertPrivateReceipt = (text: string) => {
  for (const secret of [credential, source.infoHash, source.name, "4242"])
    assert.ok(!text.includes(secret));
  assert.ok(!text.includes("magnet:"));
};

test("info hashes match an independent bencode reference", () => {
  const payload = Uint8Array.from(
    { length: 40_000 },
    (_, index) => index % 251,
  );
  assert.equal(
    singleFileInfoHash("chill-stremio-fixture.bin", payload),
    "b77a601743d89800ac4244ba555a5e2a2bbc76dc",
  );
  assert.equal(source.infoHash, "3cb1ef2e5e3cf442b6e40cc077e839196c4727ff");
  assert.equal(
    source.magnet,
    `magnet:?xt=urn:btih:${source.infoHash}&dn=${source.name}`,
  );
  assert.notEqual(reuseSource("1".repeat(32)).infoHash, source.infoHash);
});

test("one reused put.io transfer passes and only it is cancelled", async () => {
  const run = await runLane("reuse");
  assert.ok(Exit.isSuccess(run.exit));
  assert.equal(run.receipt.status, "passed");
  assert.equal(run.adds, 5);
  assert.deepEqual(
    run.receipt.proof.calls.map((call) => call.transfer),
    ["t1", "t1", "t1", "t1", "t1"],
  );
  assert.equal(run.receipt.proof.distinctTransfers, 1);
  assert.equal(run.receipt.proof.providerTransfers, 1);
  assert.equal(run.receipt.proof.providerStatus, "IN_QUEUE");
  assert.deepEqual(run.putio.cancelled, [[4242]]);
  assert.deepEqual([...run.putio.transfers.keys()], [7, 8]);
  assert.equal(run.receipt.cleanup.status, "acknowledged");
  assertPrivateReceipt(run.receiptText);
  assert.equal(run.journalMode, 0o600);
  assert.ok(run.journal.includes(source.infoHash));
});

test("an Engine that adds again on a repeated request fails", async () => {
  const run = await runLane("fresh");
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.status, "failed");
  assert.equal(run.receipt.proof.failureStage, "sequential-reuse");
  assert.equal(run.adds, 2);
  assert.deepEqual(run.putio.cancelled, [[4242, 4243]]);
  assert.deepEqual([...run.putio.transfers.keys()], [7, 8]);
  assert.equal(run.receipt.cleanup.status, "acknowledged");
  assertPrivateReceipt(run.receiptText);
});

test("concurrent requests that create separate transfers fail", async () => {
  const run = await runLane("overlap");
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "concurrent-reuse");
  assert.equal(run.adds, 5);
  assert.deepEqual(
    run.putio.cancelled.map((ids) => ids.toSorted((a, b) => a - b)),
    [[4242, 4243, 4244]],
  );
  assert.deepEqual([...run.putio.transfers.keys()], [7, 8]);
  assert.equal(run.receipt.proof.distinctTransfers, 3);
});

test("a reported transfer without the run's info hash is never cancelled", async () => {
  const run = await runLane("foreign");
  assert.ok(Exit.isFailure(run.exit));
  assert.equal(run.receipt.proof.failureStage, "attribution");
  assert.deepEqual(run.putio.cancelled, []);
  assert.deepEqual([...run.putio.transfers.keys()], [7, 8]);
  assert.equal(run.receipt.cleanup.status, "uncertain");
  assert.equal(run.receipt.cleanup.pendingAcquisitions, 1);
  assert.match(run.journal, /"engineTransferIds": \[\s*"7"\s*\]/);
});

test("the allowance covers every possible creation before the first add", async () => {
  const seen: number[] = [];
  const run = await runLane("reuse", {
    onAdd: async (directory) => {
      seen.push(
        (await readLedger(join(directory, "allowance.json"))).reservedTransfers,
      );
    },
  });
  assert.equal(run.receipt.status, "passed");
  assert.deepEqual(seen, [7, 7, 7, 7, 7]);
  assert.deepEqual(run.receipt.proof.reservation, {
    creations: 5,
    bytes: 5 * source.bytes,
  });
  assert.equal(run.ledger.reservedBytes, 100 + 5 * source.bytes);
});

for (const refusal of [
  { name: "an exhausted allowance", stage: "reservation" },
  { name: "a credential for another account", stage: "account-binding" },
] as const)
  test(`${refusal.name} stops before any add`, async () => {
    const run = await runLane(
      "reuse",
      refusal.stage === "reservation"
        ? { reservedBytes: liveVersions.byteLimit }
        : { root: [101n, 103n] },
    );
    assert.ok(Exit.isFailure(run.exit));
    assert.equal(run.receipt.proof.failureStage, refusal.stage);
    assert.equal(run.adds, 0);
    assert.deepEqual(run.putio.cancelled, []);
    assert.equal(run.ledger.reservedTransfers, 2);
  });
