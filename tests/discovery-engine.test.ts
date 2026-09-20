import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "vite-plus/test";
import { Effect } from "effect";
import {
  DiscoveryEngine,
  discoveryEngineLayer,
} from "../src/discovery-engine.ts";

test("discovery uses ordinary bearer and only existing read RPCs", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const server = createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, "Bearer fixture-chill-token");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body: JSON.parse(body) });
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* DiscoveryEngine;
        yield* engine.getMovies();
        yield* engine.getTVShows();
        yield* engine.getTVShowDetail("tt1234567");
        yield* engine.getTVShowSeason("tt1234567", 2);
        yield* engine.search("An independent film");
      }).pipe(
        Effect.provide(
          discoveryEngineLayer({
            baseUrl: `http://127.0.0.1:${address.port}`,
            token: "fixture-chill-token",
          }),
        ),
      ),
    );
    assert.deepEqual(requests, [
      { path: "/chill.v4.UserService/GetMovies", body: {} },
      { path: "/chill.v4.UserService/GetTVShows", body: {} },
      {
        path: "/chill.v4.UserService/GetTVShowDetail",
        body: { imdbId: "tt1234567" },
      },
      {
        path: "/chill.v4.UserService/GetTVShowSeason",
        body: { imdbId: "tt1234567", seasonNumber: 2 },
      },
      {
        path: "/chill.v4.UserService/Search",
        body: { query: "An independent film" },
      },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
