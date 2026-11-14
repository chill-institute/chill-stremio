import assert from "node:assert/strict";
import { request } from "node:http";
import { Schema } from "effect";
import { test, vi } from "vite-plus/test";
import { hostedConfiguration } from "../src/hosted-config.ts";
import { startHostedAdapter } from "../src/hosted.ts";
import { fixture, ownerCredential, target } from "./support/hosted-fixture.ts";

vi.mock("../src/playback-wait.ts", async (original) => {
  const actual = await original<typeof import("../src/playback-wait.ts")>();
  return {
    ...actual,
    playbackWait: { ...actual.playbackWait, pollMs: 20, ownedPollMs: 20 },
  };
});

const chill = {
  publicOrigin: "https://stremio.chill.institute",
  webOrigin: "https://chill.institute",
};
const binge = {
  publicOrigin: "https://stremio.binge.institute",
  webOrigin: "https://binge.institute",
};
const bothSites = {
  CHILL_PUBLIC_ORIGINS: `${binge.publicOrigin}=${binge.webOrigin}, ${chill.publicOrigin}=${chill.webOrigin}`,
};

async function adapterFrom(env: Record<string, string>) {
  const { publicOrigin, webOrigin, additionalOrigins } =
    hostedConfiguration(env);
  return fixture({ origins: { publicOrigin, webOrigin, additionalOrigins } });
}

function send(listenOrigin: string, host: string, path: string) {
  return new Promise<{
    status: number;
    location: string | undefined;
    body: string;
  }>((resolve, reject) => {
    const outgoing = request(
      `${listenOrigin}${path}`,
      { headers: { host } },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => (body += chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            location: response.headers.location,
            body,
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const Manifest = Schema.Struct({ logo: Schema.String });
const Streams = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({
      url: Schema.optional(Schema.String),
      externalUrl: Schema.optional(Schema.String),
    }),
  ),
});
const streamsOf = (body: string) =>
  Schema.decodeUnknownSync(Streams)(JSON.parse(body)).streams;

test("each allowed host builds its own add-on and reconnect URLs", async () => {
  const f = await adapterFrom(bothSites);
  try {
    for (const [site, host] of [
      [binge, "stremio.binge.institute"],
      [chill, "STREMIO.Chill.Institute"],
    ] as const) {
      const manifest = await send(f.listenOrigin, host, "/manifest.json");
      assert.equal(manifest.status, 200);
      assert.equal(
        Schema.decodeUnknownSync(Manifest)(JSON.parse(manifest.body)).logo,
        `${site.publicOrigin}/configure-assets/logo.png`,
      );
      const configure = await send(f.listenOrigin, host, "/configure");
      assert.equal(configure.status, 200);
      assert.ok(configure.body.includes(`${site.webOrigin}/stremio`));
      assert.equal(
        (await send(f.listenOrigin, host, "/")).location,
        `${site.webOrigin}/stremio`,
      );
      const personal = `/s/${ownerCredential}`;
      const streams = await send(
        f.listenOrigin,
        host,
        `${personal}/stream/movie/${encodeURIComponent(target)}.json`,
      );
      assert.equal(streams.status, 200);
      assert.equal(
        streamsOf(streams.body)[0]?.url,
        `${site.publicOrigin}${personal}/play/movie/${encodeURIComponent(target)}/fixture-release.m3u8`,
      );
      f.state.rejection = { status: 401, code: "unauthenticated" };
      const reconnect = await send(
        f.listenOrigin,
        host,
        `${personal}/stream/movie/tt1234567.json`,
      );
      f.state.rejection = undefined;
      assert.deepEqual(
        streamsOf(reconnect.body).map(({ externalUrl }) => externalUrl),
        [`${site.webOrigin}/stremio`],
      );
    }
  } finally {
    await f.close();
  }
});

test("hosts outside the allowlist get 404 and never reach Engine", async () => {
  const f = await adapterFrom(bothSites);
  try {
    for (const host of [
      "stremio.binge.institute.example",
      "evilstremio.binge.institute",
      "stremio.chill.institute:8443",
      "chill.institute",
      "127.0.0.1",
    ])
      for (const path of [
        "/manifest.json",
        "/configure",
        `/s/${ownerCredential}/stream/movie/${encodeURIComponent(target)}.json`,
      ]) {
        const response = await send(f.listenOrigin, host, path);
        assert.equal(response.status, 404, `${host}${path}`);
        assert.ok(!response.body.includes("institute"), `${host}${path}`);
      }
    assert.deepEqual(f.calls, []);
  } finally {
    await f.close();
  }
});

test("a single public origin keeps serving only its own host", async () => {
  const f = await adapterFrom({ CHILL_PUBLIC_ORIGIN: chill.publicOrigin });
  try {
    const manifest = await send(
      f.listenOrigin,
      "stremio.chill.institute",
      "/manifest.json",
    );
    assert.equal(
      Schema.decodeUnknownSync(Manifest)(JSON.parse(manifest.body)).logo,
      `${chill.publicOrigin}/configure-assets/logo.png`,
    );
    assert.equal(
      (await send(f.listenOrigin, "stremio.chill.institute", "/")).location,
      "https://chill.institute/stremio",
    );
    assert.equal(
      (await send(f.listenOrigin, "stremio.binge.institute", "/manifest.json"))
        .status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("a legacy single origin alongside the list must name a listed pair", async () => {
  const f = await adapterFrom({
    ...bothSites,
    CHILL_PUBLIC_ORIGIN: binge.publicOrigin,
    CHILL_WEB_ORIGIN: binge.webOrigin,
  });
  try {
    assert.equal(f.origin, binge.publicOrigin);
    assert.equal(
      (await send(f.listenOrigin, "stremio.chill.institute", "/")).location,
      "https://chill.institute/stremio",
    );
  } finally {
    await f.close();
  }
  for (const env of [
    { ...bothSites, CHILL_PUBLIC_ORIGIN: "https://stremio.example.org" },
    {
      ...bothSites,
      CHILL_PUBLIC_ORIGIN: binge.publicOrigin,
      CHILL_WEB_ORIGIN: chill.webOrigin,
    },
    { ...bothSites, CHILL_WEB_ORIGIN: chill.webOrigin },
    { CHILL_PUBLIC_ORIGINS: binge.publicOrigin },
    {},
  ])
    assert.throws(() => hostedConfiguration(env));
});

test("invalid or repeated public origins refuse to start", async () => {
  for (const CHILL_PUBLIC_ORIGINS of [
    `${binge.publicOrigin}=${binge.webOrigin},${binge.publicOrigin}=${chill.webOrigin}`,
    `http://stremio.binge.institute=${binge.webOrigin}`,
    `${binge.publicOrigin}/=${binge.webOrigin}`,
    `${binge.publicOrigin}=${binge.webOrigin}/stremio`,
  ])
    await assert.rejects(
      startHostedAdapter({
        ...hostedConfiguration({ CHILL_PUBLIC_ORIGINS }),
        port: 0,
        statusMedia: new Map(),
      }),
    );
});
