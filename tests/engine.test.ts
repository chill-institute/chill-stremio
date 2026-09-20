import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { test } from "vite-plus/test";
import { Effect } from "effect";
import { Engine, engineLayer } from "../src/engine.ts";

const token = "test-chill-bearer";

async function withEngineServer(
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

test("Engine sends regular bearer RPCs and preserves int64 IDs", async () => {
  const requests: { path: string | undefined; body: string }[] = [];
  await withEngineServer(
    (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        requests.push({ path: request.url, body });
        response.setHeader("content-type", "application/json");
        response.end(
          request.url?.endsWith("GetFolder")
            ? '{"files":[{"id":"9223372036854775807","name":"Movie","fileType":"video"}]}'
            : '{"ready":{"media":{"url":"https://media.example/video?token=opaque","unknownExpiry":true}}}',
        );
      });
    },
    async (baseUrl) => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const engine = yield* Engine;
          const folder = yield* engine.getFolder(9223372036854775807n);
          assert.equal(folder.files[0]?.id, 9223372036854775807n);
          const playback = yield* engine.resolvePlayback(9223372036854775807n);
          assert.equal(playback.result.case, "ready");
        }).pipe(Effect.provide(engineLayer({ baseUrl, token }))),
      );
      assert.deepEqual(requests, [
        {
          path: "/chill.v4.UserService/GetFolder",
          body: '{"id":"9223372036854775807"}',
        },
        {
          path: "/chill.v4.UserService/ResolvePlayback",
          body: '{"fileId":"9223372036854775807","delivery":"PLAYBACK_DELIVERY_HLS"}',
        },
      ]);
    },
  );
});

test("Engine rejects unsafe configuration without retaining credentials", async () => {
  for (const config of [
    { baseUrl: "http://engine.example", token },
    { baseUrl: "https://user:secret@engine.example", token },
    { baseUrl: "https://engine.example?token=secret", token },
    { baseUrl: "https://engine.example#secret", token },
    { baseUrl: "not-a-url", token },
    { baseUrl: "https://engine.example", token: "secret\r\nheader: value" },
    { baseUrl: "https://engine.example", token: "" },
  ]) {
    const error = await Effect.runPromise(
      Engine.pipe(Effect.provide(engineLayer(config)), Effect.flip),
    );
    assert.equal(error.code, "invalid_config");
    assert.equal(error.cause, undefined);
    assert.doesNotMatch(JSON.stringify(error), /secret|test-chill-bearer/);
  }
});

test("Engine sanitizes upstream failures and does not retry", async () => {
  let calls = 0;
  await withEngineServer(
    (_request, response) => {
      calls += 1;
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          code: "unauthenticated",
          message: `secret upstream ${token} https://media.example?token=secret`,
        }),
      );
    },
    async (baseUrl) => {
      const error = await Effect.runPromise(
        Effect.flatMap(Engine, (engine) => engine.getFolder(1n)).pipe(
          Effect.provide(engineLayer({ baseUrl, token })),
          Effect.flip,
        ),
      );
      assert.equal(error.code, "unauthenticated");
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(
        JSON.stringify(error),
        /secret|test-chill-bearer|media/,
      );
      assert.equal(calls, 1);
    },
  );
});

test("Engine refuses redirects before forwarding a bearer", async () => {
  let redirectedCalls = 0;
  await withEngineServer(
    (_request, response) => {
      redirectedCalls += 1;
      response.end("{}");
    },
    async (destination) => {
      await withEngineServer(
        (_request, response) => {
          response.writeHead(307, { location: destination });
          response.end();
        },
        async (baseUrl) => {
          const error = await Effect.runPromise(
            Effect.flatMap(Engine, (engine) => engine.resolvePlayback(1n)).pipe(
              Effect.provide(engineLayer({ baseUrl, token })),
              Effect.flip,
            ),
          );
          assert.equal(error.code, "unavailable");
        },
      );
    },
  );
  assert.equal(redirectedCalls, 0);
});

test("Engine bounds streamed responses and rejects malformed protobuf JSON", async () => {
  for (const [body, expected] of [
    ["x".repeat(1024 * 1024 + 1), "resource_exhausted"],
    ['{"files":[{"id":"invalid-int64"}]}', "unknown"],
  ]) {
    await withEngineServer(
      (_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write(body);
        response.end();
      },
      async (baseUrl) => {
        const error = await Effect.runPromise(
          Effect.flatMap(Engine, (engine) => engine.getFolder(1n)).pipe(
            Effect.provide(engineLayer({ baseUrl, token })),
            Effect.flip,
          ),
        );
        assert.equal(error.code, expected);
      },
    );
  }
});

test("interrupting Engine cancels an in-flight response", async () => {
  let start = () => {};
  let close = () => {};
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  await withEngineServer(
    (_request, response) => {
      response.on("close", () => close());
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"files":[');
      start();
    },
    async (baseUrl) => {
      const controller = new AbortController();
      const running = Effect.runPromise(
        Effect.flatMap(Engine, (engine) => engine.getFolder(1n)).pipe(
          Effect.provide(engineLayer({ baseUrl, token })),
        ),
        { signal: controller.signal },
      );
      const rejected = assert.rejects(running);
      await started;
      controller.abort();
      await rejected;
      await closed;
    },
  );
});

test("Engine stops a stalled response at its ten-second deadline", async () => {
  let calls = 0;
  await withEngineServer(
    (_request, response) => {
      calls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"files":[');
    },
    async (baseUrl) => {
      const started = performance.now();
      const error = await Effect.runPromise(
        Effect.flatMap(Engine, (engine) => engine.getFolder(1n)).pipe(
          Effect.provide(engineLayer({ baseUrl, token })),
          Effect.flip,
        ),
      );
      assert.equal(error.code, "deadline_exceeded");
      assert.ok(performance.now() - started < 12_000);
      assert.equal(calls, 1);
    },
  );
}, 15_000);
