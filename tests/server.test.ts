import { get } from "node:http";
import { Effect, Layer } from "effect";
import { fromJson } from "@bufbuild/protobuf";
import {
  GetFolderResponseSchema,
  ResolvePlaybackResponseSchema,
} from "@chill-institute/contracts/chill/v4/api_pb";
import { expect, test } from "vite-plus/test";
import { Engine, EngineError } from "../src/engine.ts";
import { startAdapter } from "../src/server.ts";

const folder = fromJson(GetFolderResponseSchema, {
  parent: { id: "0", fileType: "FOLDER" },
  files: [{ id: "1", name: "Test movie", fileType: "VIDEO" }],
});
const noSource = fromJson(ResolvePlaybackResponseSchema, {
  unavailable: { reason: "UNAVAILABLE_REASON_NOT_FOUND" },
});

test("installation capability protects catalog and rejects malformed keys without stopping the server", async () => {
  let calls = 0;
  const layer = Layer.succeed(
    Engine,
    Engine.of({
      getFolder: () =>
        Effect.sync(() => {
          calls++;
          return folder;
        }),
      resolvePlayback: () => Effect.succeed(noSource),
    }),
  );
  const adapter = await startAdapter({ layer, folderId: 0n });
  try {
    const unauthorized = await fetch(`${adapter.origin}/manifest.json`);
    expect(unauthorized.status).toBe(404);
    const forgedHost = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = get(
          adapter.manifestUrl,
          { headers: { host: "untrusted.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on("error", reject);
      },
    );
    expect(forgedHost).toBe(404);
    const malformed = await new Promise<number | undefined>(
      (resolve, reject) => {
        const request = get(
          {
            hostname: "127.0.0.1",
            port: new URL(adapter.origin).port,
            path: `/${"é".repeat(43)}/manifest.json`,
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on("error", reject);
      },
    );
    expect(malformed).toBe(400);
    expect(calls).toBe(0);
    const manifest = await fetch(adapter.manifestUrl);
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await manifest.json())).not.toContain(
      new URL(adapter.manifestUrl).pathname.split("/")[1],
    );
    const catalog = await fetch(
      adapter.manifestUrl.replace(
        "manifest.json",
        "catalog/movie/library.json",
      ),
    );
    expect(catalog.headers.get("cache-control")).toBe("no-store");
    expect(await catalog.json()).toMatchObject({
      metas: [{ id: "chill:file:1", name: "Test movie" }],
    });
    const absent = await fetch(
      adapter.manifestUrl.replace(
        "manifest.json",
        "meta/movie/chill:file:2.json",
      ),
    );
    expect(absent.status).toBe(404);
    expect(absent.headers.get("cache-control")).toBe("no-store");
  } finally {
    await adapter.close();
  }
  await expect(fetch(adapter.manifestUrl)).rejects.toThrow();
});

test("disconnect cancels the active Engine read and cleanup closes its listener", async () => {
  let began: () => void = () => {};
  let canceled: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const cancellation = new Promise<void>((resolve) => {
    canceled = resolve;
  });
  const layer = Layer.succeed(
    Engine,
    Engine.of({
      getFolder: () =>
        Effect.tryPromise({
          try: (signal) =>
            new Promise<typeof folder>((_resolve, reject) => {
              began();
              signal.addEventListener(
                "abort",
                () => {
                  canceled();
                  reject(new Error("canceled"));
                },
                { once: true },
              );
            }),
          catch: () => new EngineError({ code: "canceled" }),
        }),
      resolvePlayback: () => Effect.succeed(noSource),
    }),
  );
  const adapter = await startAdapter({ layer, folderId: 0n });
  const controller = new AbortController();
  try {
    const request = fetch(
      adapter.manifestUrl.replace(
        "manifest.json",
        "catalog/movie/library.json",
      ),
      { signal: controller.signal },
    ).catch(() => undefined);
    await started;
    controller.abort();
    await cancellation;
    await request;
  } finally {
    await adapter.close();
  }
  await expect(fetch(adapter.manifestUrl)).rejects.toThrow();
});

test("CLI writes a private install receipt and removes it on shutdown without printing credentials", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtemp, readFile, stat, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const directory = await mkdtemp(join(tmpdir(), "adapter-cli-"));
  const token = "fixture_cli_token";
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../src/run.ts", import.meta.url))],
    {
      cwd: directory,
      env: {
        ...process.env,
        CHILL_TOKEN: token,
        CHILL_FOLDER_ID: "0",
        CHILL_ADAPTER_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const stopped = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  const receipt = join(directory, ".cache/adapter/install.json");
  try {
    await expect
      .poll(async () => (await stat(receipt)).mode & 0o777, { timeout: 8000 })
      .toBe(0o600);
    const contents = await readFile(receipt, "utf8");
    expect(contents).not.toContain(token);
    child.kill("SIGTERM");
    expect(await stopped).toBe(0);
    await expect(stat(receipt)).rejects.toThrow();
    expect(output).not.toContain(token);
    expect(output).not.toContain("http://");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await stopped;
    await rm(directory, { recursive: true, force: true });
  }
}, 15000);
