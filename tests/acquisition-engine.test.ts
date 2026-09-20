import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { Effect, Layer } from "effect";
import { test } from "vite-plus/test";
import {
  AcquisitionEngine,
  acquisitionEngineLayer,
  inspectTransferFiles,
  type AcquisitionFolder,
  type AcquisitionTransfer,
} from "../src/acquisition-engine.ts";
import { EngineError } from "../src/engine.ts";

const transfer: AcquisitionTransfer = {
  id: 90n,
  status: "COMPLETED",
  isFinished: true,
  fileId: 20n,
  saveParentId: 10n,
  percentDone: 100,
  failed: false,
};
function files(
  parent: bigint,
  entries: Array<{ id: bigint; fileType: string }>,
): AcquisitionFolder {
  return {
    parent: { id: parent, name: "Folder", fileType: "FOLDER" },
    files: entries.map((entry) => ({ ...entry, name: `File ${entry.id}` })),
  };
}
function fixture(folders: Map<bigint, AcquisitionFolder>) {
  const calls: bigint[] = [];
  const layer = Layer.succeed(
    AcquisitionEngine,
    AcquisitionEngine.of({
      getProfile: () => Effect.succeed({ userId: "123" }),
      getFolder: (id) =>
        Effect.suspend(() => {
          calls.push(id);
          const folder = folders.get(id);
          return folder
            ? Effect.succeed(folder)
            : Effect.fail(new EngineError({ code: "not_found" }));
        }),
      addTransfer: () => Effect.fail(new EngineError({ code: "unknown" })),
      getTransfer: () => Effect.succeed(transfer),
    }),
  );
  return { calls, layer };
}
async function withServer(
  listener: RequestListener,
  run: (baseUrl: string) => Promise<void>,
) {
  const server = createServer(listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

test("acquisition RPCs validate ownership and preserve ids without retaining profile or provider URLs", async () => {
  const calls: string[] = [];
  await withServer(
    (request, response) => {
      assert.equal(request.headers.authorization, "Bearer fixture-chill-token");
      assert.equal(request.method, "POST");
      calls.push(request.url ?? "");
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("GetUserProfile"))
        response.end(
          JSON.stringify({
            userId: "123",
            email: "private@example.test",
            username: "private",
          }),
        );
      else if (request.url?.endsWith("GetFolder"))
        response.end(
          JSON.stringify({
            parent: { id: "10", name: "Folder", fileType: "FOLDER" },
            files: [{ id: "20", name: "Film", fileType: "VIDEO" }],
          }),
        );
      else
        response.end(
          JSON.stringify({
            transfer: {
              id: "90",
              status: "COMPLETED",
              percentDone: 100,
              isFinished: true,
              fileId: "20",
              saveParentId: "10",
              errorMessage: "https://provider.example/?secret=fixture",
            },
          }),
        );
    },
    async (baseUrl) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const engine = yield* AcquisitionEngine;
          const profile = yield* engine.getProfile();
          assert.deepEqual(profile, { userId: "123" });
          const folder = yield* engine.getFolder(10n);
          assert.equal(folder.files[0]?.id, 20n);
          const created = yield* engine.addTransfer(
            "https://api.example/download?token=fixture",
          );
          assert.equal(created.id, 90n);
          assert.equal(created.failed, true);
          assert.equal("errorMessage" in created, false);
          assert.equal((yield* engine.getTransfer(90n)).fileId, 20n);
        }).pipe(
          Effect.provide(
            acquisitionEngineLayer({ baseUrl, token: "fixture-chill-token" }),
          ),
        ),
      );
    },
  );
  assert.deepEqual(
    calls.map((call) => call.split("/").at(-1)),
    ["GetUserProfile", "GetFolder", "AddTransfer", "GetTransfer"],
  );
});

test("ambiguous AddTransfer transport failure stays an error and is never retried", async () => {
  let calls = 0;
  await withServer(
    (_request, response) => {
      calls++;
      response.destroy();
    },
    async (baseUrl) => {
      const error = await Effect.runPromise(
        Effect.flatMap(AcquisitionEngine, (engine) =>
          engine.addTransfer(
            "magnet:?xt=urn:btih:0123456789012345678901234567890123456789",
          ),
        ).pipe(
          Effect.provide(
            acquisitionEngineLayer({ baseUrl, token: "fixture-token" }),
          ),
          Effect.flip,
        ),
      );
      assert.ok(["unknown", "unavailable"].includes(error.code));
      assert.equal(calls, 1);
      assert.equal(error.cause, undefined);
    },
  );
});

test("acquisition rejects malformed transfer input before submitting", async () => {
  let calls = 0;
  await withServer(
    (_request, response) => {
      calls++;
      response.end("{}");
    },
    async (baseUrl) => {
      for (const url of [
        "http://insecure.example/file",
        "https://user:secret@example.test/file",
        "magnet:?xt=garbage",
      ]) {
        const error = await Effect.runPromise(
          Effect.flatMap(AcquisitionEngine, (engine) =>
            engine.addTransfer(url),
          ).pipe(
            Effect.provide(
              acquisitionEngineLayer({ baseUrl, token: "fixture-token" }),
            ),
            Effect.flip,
          ),
        );
        assert.equal(error.code, "invalid_config");
      }
    },
  );
  assert.equal(calls, 0);
});

test("mismatched transfer identity is rejected", async () => {
  await withServer(
    (_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          transfer: { id: "91", status: "DOWNLOADING", percentDone: 20 },
        }),
      );
    },
    async (baseUrl) => {
      const error = await Effect.runPromise(
        Effect.flatMap(AcquisitionEngine, (engine) =>
          engine.getTransfer(90n),
        ).pipe(
          Effect.provide(
            acquisitionEngineLayer({ baseUrl, token: "fixture-token" }),
          ),
          Effect.flip,
        ),
      );
      assert.equal(error.code, "invalid_response");
    },
  );
});

test("inspection returns only transfer-owned videos and exact containing folders", async () => {
  const f = fixture(
    new Map([
      [
        10n,
        files(10n, [
          { id: 20n, fileType: "FOLDER" },
          { id: 999n, fileType: "VIDEO" },
        ]),
      ],
      [
        20n,
        files(20n, [
          { id: 21n, fileType: "VIDEO" },
          { id: 22n, fileType: "FOLDER" },
        ]),
      ],
      [
        22n,
        files(22n, [
          { id: 23n, fileType: "VIDEO" },
          { id: 24n, fileType: "TEXT" },
        ]),
      ],
    ]),
  );
  const result = await Effect.runPromise(
    inspectTransferFiles(transfer).pipe(Effect.provide(f.layer)),
  );
  assert.deepEqual(
    result.map(({ id, parentId }) => ({ id, parentId })),
    [
      { id: 21n, parentId: 20n },
      { id: 23n, parentId: 22n },
    ],
  );
  assert.deepEqual(f.calls, [10n, 20n, 22n]);
});

test("inspection treats a direct completed video separately and skips incomplete or failed transfers", async () => {
  const f = fixture(
    new Map([[10n, files(10n, [{ id: 20n, fileType: "VIDEO" }])]]),
  );
  const result = await Effect.runPromise(
    inspectTransferFiles(transfer).pipe(Effect.provide(f.layer)),
  );
  assert.deepEqual(
    result.map(({ id, parentId }) => ({ id, parentId })),
    [{ id: 20n, parentId: 10n }],
  );
  f.calls.length = 0;
  for (const value of [
    { ...transfer, isFinished: false },
    { ...transfer, failed: true },
    { ...transfer, fileId: undefined },
  ]) {
    assert.deepEqual(
      await Effect.runPromise(
        inspectTransferFiles(value).pipe(Effect.provide(f.layer)),
      ),
      [],
    );
  }
  assert.deepEqual(f.calls, []);
});

test("inspection rejects cyclic or excessive folder trees and never escapes into destination siblings", async () => {
  const folders = new Map([
    [10n, files(10n, [{ id: 20n, fileType: "FOLDER" }])],
    [20n, files(20n, [{ id: 10n, fileType: "FOLDER" }])],
  ]);
  const f = fixture(folders);
  assert.equal(
    (
      await Effect.runPromise(
        inspectTransferFiles(transfer).pipe(
          Effect.provide(f.layer),
          Effect.flip,
        ),
      )
    ).code,
    "invalid_response",
  );
  folders.set(
    20n,
    files(
      20n,
      Array.from({ length: 33 }, (_, i) => ({
        id: BigInt(i + 100),
        fileType: "FOLDER",
      })),
    ),
  );
  for (let i = 0; i < 33; i++)
    folders.set(BigInt(i + 100), files(BigInt(i + 100), []));
  assert.equal(
    (
      await Effect.runPromise(
        inspectTransferFiles(transfer).pipe(
          Effect.provide(f.layer),
          Effect.flip,
        ),
      )
    ).code,
    "resource_exhausted",
  );
});

test("inspection propagates expired authorization instead of presenting missing videos", async () => {
  const layer = Layer.succeed(
    AcquisitionEngine,
    AcquisitionEngine.of({
      getProfile: () =>
        Effect.fail(new EngineError({ code: "unauthenticated" })),
      getFolder: () =>
        Effect.fail(new EngineError({ code: "unauthenticated" })),
      addTransfer: () => Effect.fail(new EngineError({ code: "unknown" })),
      getTransfer: () =>
        Effect.fail(new EngineError({ code: "unauthenticated" })),
    }),
  );
  assert.equal(
    (
      await Effect.runPromise(
        inspectTransferFiles(transfer).pipe(Effect.provide(layer), Effect.flip),
      )
    ).code,
    "unauthenticated",
  );
});
