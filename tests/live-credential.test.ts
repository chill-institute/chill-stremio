import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { issueCredential } from "../harness/live/credential.ts";

const script = fileURLToPath(
  new URL("../harness/live/credential.ts", import.meta.url),
);
const token = "synthetic-chill-session";
const credential = `v4.local.${randomBytes(300).toString("base64url")}.${Buffer.from('{"kid":"s1"}').toString("base64url")}`;

async function engine(status: number, body: string) {
  const requests: {
    method?: string;
    url?: string;
    headers: IncomingHttpHeaders;
    body: string;
  }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let received = "";
      for await (const chunk of request) received += String(chunk);
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: received,
      });
      response
        .writeHead(status, { "content-type": "application/json" })
        .end(body);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test("mint asks Engine for the download-folder credential with only the chill bearer", async () => {
  const fake = await engine(200, JSON.stringify({ credential }));
  try {
    assert.equal(
      await issueCredential({ token, apiOrigin: fake.origin }),
      credential,
    );
    assert.equal(fake.requests.length, 1);
    const [request] = fake.requests;
    assert.equal(request?.method, "POST");
    assert.equal(request?.url, "/stremio/credential");
    assert.equal(request?.headers.authorization, `Bearer ${token}`);
    assert.equal(request?.headers["x-chill-stremio-credential"], undefined);
    assert.equal(request?.body, "");
  } finally {
    await fake.close();
  }
});

for (const [status, body, reason] of [
  [
    409,
    '{"code":"download_folder_missing","message":"download folder is not set"}',
    "Engine answered 409 download_folder_missing",
  ],
  [
    503,
    `{"code":"stremio_not_configured","message":"${credential}"}`,
    "Engine answered 503 stremio_not_configured",
  ],
  [
    200,
    '{"credential":"v4.local.short"}',
    "Engine returned no add-on credential",
  ],
  [200, "<html>ok</html>", "Engine returned no add-on credential"],
] as const) {
  test(`mint rejects a ${status} response without echoing it: ${reason}`, async () => {
    const fake = await engine(status, body);
    try {
      await assert.rejects(
        issueCredential({ token, apiOrigin: fake.origin }),
        (error: Error) => {
          assert.equal(
            error.message,
            `Add-on credential not minted: ${reason}`,
          );
          return true;
        },
      );
    } finally {
      await fake.close();
    }
  });
}

test("mint refuses an output others can read before signing in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "live-credential-"));
  try {
    for (const [mode, message] of [
      [
        0o644,
        "Add-on credential not minted: stdout must be a pipe or a file with mode 0600",
      ],
      [0o600, "Chill authorization failed: configuration"],
    ] as const) {
      const path = join(directory, `output-${mode.toString(8)}`);
      const output = await open(path, "wx", mode);
      try {
        await output.chmod(mode);
        const child = spawn(process.execPath, [script], {
          cwd: directory,
          env: { HOME: directory },
          stdio: ["ignore", output.fd, "pipe"],
        });
        let stderr = "";
        assert.ok(child.stderr);
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        const [code] = await once(child, "close");
        assert.equal(code, 1);
        assert.equal(stderr.trim(), message);
      } finally {
        await output.close();
      }
      assert.equal(await readFile(path, "utf8"), "");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
