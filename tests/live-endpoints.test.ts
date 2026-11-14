import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "vite-plus/test";
import {
  type ProductionEndpoints,
  reachableProduction,
  resolveLiveEndpoints,
} from "../harness/live/endpoints.ts";

async function serve(status: number) {
  const server = createServer((_, response) =>
    response.writeHead(status).end(),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closedOrigin() {
  const { server, origin } = await serve(200);
  await close(server);
  return origin;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

const candidate = (domain: string, origin: string): ProductionEndpoints => ({
  domain,
  stremio: origin,
  web: origin,
  api: origin,
  engine: `${origin}/v4`,
});

test("an unreachable first domain falls through to the next and is named", async () => {
  const down = await closedOrigin();
  const up = await serve(200);
  const warnings: string[] = [];
  try {
    const chosen = await reachableProduction(undefined, {
      candidates: [
        candidate("first.test", down),
        candidate("second.test", up.origin),
      ],
      warn: (message) => warnings.push(message),
    });
    assert.equal(chosen.domain, "second.test");
    assert.ok(warnings.length > 0);
    assert.ok(warnings.every((warning) => warning.includes(down)));
  } finally {
    await close(up.server);
  }
});

test("a reachable domain answering an HTTP failure is still chosen", async () => {
  const failing = await serve(503);
  const healthy = await serve(200);
  const warnings: string[] = [];
  try {
    const chosen = await reachableProduction(undefined, {
      candidates: [
        candidate("first.test", failing.origin),
        candidate("second.test", healthy.origin),
      ],
      warn: (message) => warnings.push(message),
    });
    assert.equal(chosen.domain, "first.test");
    assert.deepEqual(warnings, []);
  } finally {
    await close(failing.server);
    await close(healthy.server);
  }
});

test("no reachable domain fails naming every unreachable host", async () => {
  const first = await closedOrigin();
  const second = await closedOrigin();
  await assert.rejects(
    reachableProduction(undefined, {
      candidates: [
        candidate("first.test", first),
        candidate("second.test", second),
      ],
      warn: () => {},
    }),
    (error: Error) =>
      error.message.includes(first) && error.message.includes(second),
  );
});

test("the default order probes binge.institute before chill.institute", async () => {
  const probed: string[] = [];
  const chosen = await resolveLiveEndpoints(
    {},
    {
      reach: async (origin) => {
        probed.push(origin);
        return !origin.endsWith("binge.institute");
      },
      warn: () => {},
    },
  );
  assert.equal(probed[0], "https://stremio.binge.institute");
  assert.deepEqual(chosen, {
    domain: "chill.institute",
    web: "https://chill.institute",
    stremio: "https://stremio.chill.institute",
    api: "https://api.chill.institute",
    engine: "https://api.chill.institute/v4",
  });
});

test("an explicit origin pins its host without probing", async () => {
  const reach = async () => assert.fail("pinned endpoints are not probed");
  assert.deepEqual(
    await resolveLiveEndpoints(
      {
        CHILL_PUBLIC_STREMIO_ORIGIN: "http://127.0.0.1:9/",
        CHILL_ENGINE_BASE_URL: "http://127.0.0.1:9/v4/",
      },
      { reach },
    ),
    {
      stremio: "http://127.0.0.1:9",
      api: "http://127.0.0.1:9",
      engine: "http://127.0.0.1:9/v4",
    },
  );
  assert.deepEqual(
    await resolveLiveEndpoints(
      { CHILL_PUBLIC_STREMIO_ORIGIN: "https://stremio.chill.institute" },
      { reach },
    ),
    {
      domain: "chill.institute",
      web: "https://chill.institute",
      stremio: "https://stremio.chill.institute",
      api: "https://api.chill.institute",
      engine: "https://api.chill.institute/v4",
    },
  );
});

test("a non-production adapter origin pairs with a reachable production Engine", async () => {
  const probed: string[] = [];
  const chosen = await resolveLiveEndpoints(
    { CHILL_PUBLIC_STREMIO_ORIGIN: "http://127.0.0.1:7000" },
    {
      reach: async (origin) => {
        probed.push(origin);
        return true;
      },
    },
  );
  assert.deepEqual(probed, ["https://api.binge.institute"]);
  assert.equal(chosen.stremio, "http://127.0.0.1:7000");
  assert.equal(chosen.engine, "https://api.binge.institute/v4");
});
