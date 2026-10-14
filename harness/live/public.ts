import { mkdir, writeFile } from "node:fs/promises";
import { isCredential, redactCredentials } from "../../src/credential.ts";
import { manifestDescriptions } from "../../src/manifest-descriptions.ts";
import { redactLive } from "./redact.ts";

// Read-only proof that the deployed adapter serves the designated account
// through an Engine-issued add-on credential: read its manifest, library and
// release results, and check that Engine lets the credential look up season
// packs and videos already in the account. No stream is consumed, so no
// transfer or allowance is used.
const origin = new URL(
  process.env.CHILL_PUBLIC_STREMIO_ORIGIN ?? "https://stremio.chill.institute",
).origin;
const engineBaseUrl = (
  process.env.CHILL_ENGINE_BASE_URL ?? "https://api.chill.institute/v4"
).replace(/\/+$/, "");
const credential = process.env.CHILL_STREMIO_CREDENTIAL?.trim() ?? "";
const stamp = new Date().toISOString().replaceAll(":", "-");
const artifact = `artifacts/public-${stamp}`;
type Step = { name: string; passed: boolean; detail?: string };
const steps: Step[] = [];
const signal = AbortSignal.timeout(4 * 60 * 1000);
const clean = (detail: string) => redactLive(redactCredentials(detail));
const fail = (name: string, detail: string): never => {
  steps.push({ name, passed: false, detail: clean(detail) });
  throw new Error(`${name}: ${detail}`);
};
const pass = (name: string, detail?: string) =>
  steps.push({ name, passed: true, ...(detail ? { detail } : {}) });
const read = async (path: string) =>
  fetch(`${origin}${path}`, { signal, redirect: "error" });
// Engine admits an add-on credential only to procedures it was granted.
const engineCall = (procedure: string, body: unknown) =>
  fetch(`${engineBaseUrl}/chill.v4.UserService/${procedure}`, {
    method: "POST",
    signal,
    redirect: "error",
    headers: {
      "content-type": "application/json",
      "connect-protocol-version": "1",
      "x-chill-stremio-credential": credential,
    },
    body: JSON.stringify(body),
  });
const refused = (
  response: Response,
  answer: Record<string, unknown> | undefined,
) =>
  [401, 403].includes(response.status) ||
  ["unauthenticated", "permission_denied"].includes(String(answer?.code));
const asRecord = (value: unknown) =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

let passed = false;
try {
  if (!isCredential(credential))
    fail("configuration", "designated add-on credential absent");
  const engine = URL.canParse(engineBaseUrl) ? new URL(engineBaseUrl) : null;
  if (
    engine?.protocol !== "https:" &&
    !(
      engine?.protocol === "http:" &&
      ["127.0.0.1", "[::1]", "localhost"].includes(engine.hostname)
    )
  )
    fail("configuration", "Engine base URL must use HTTPS");
  const health = await read("/health");
  if (health.status !== 200) fail("health", `status ${health.status}`);
  pass("health");
  const publicManifest = await read("/manifest.json");
  const listing = asRecord(await publicManifest.json());
  if (
    publicManifest.status !== 200 ||
    asRecord(listing?.behaviorHints)?.configurationRequired !== true
  )
    fail("public-manifest", `status ${publicManifest.status}`);
  // The canary runs at the published commit, so the copy must match exactly.
  if (listing?.description !== manifestDescriptions.public)
    fail("public-manifest", "description differs from this checkout");
  pass("public-manifest", "configuration required; current description");
  const base = `/s/${credential}`;
  const manifest = await read(`${base}/manifest.json`);
  if (manifest.status !== 200) fail("manifest", `status ${manifest.status}`);
  if (
    asRecord(await manifest.json())?.description !==
    manifestDescriptions.personal
  )
    fail("manifest", "description differs from this checkout");
  pass("manifest", "current description");
  const library = await read(`${base}/catalog/movie/library.json`);
  if (library.status !== 200) fail("library", `status ${library.status}`);
  const videos = asRecord(await library.json())?.metas;
  if (!Array.isArray(videos)) fail("library", "metas missing");
  else if (videos.some((video) => asRecord(video)?.id === "chill:reconnect"))
    fail("library", "Engine rejected the credential");
  else pass("library", `videos ${videos.length}`);
  const sources = await read(`${base}/stream/movie/tt0133093.json`);
  if (sources.status !== 200)
    fail("standard-title", `status ${sources.status}`);
  const streams = asRecord(await sources.json())?.streams;
  if (
    !Array.isArray(streams) ||
    streams.length === 0 ||
    streams.some((stream) => asRecord(stream)?.externalUrl !== undefined)
  )
    fail("standard-title", "no release results for the reference IMDb movie");
  else
    pass(
      "standard-title",
      `release results ${streams.length}; no media consumed`,
    );
  const episode = await read(`${base}/stream/series/tt0903747:1:1.json`);
  if (episode.status !== 200)
    fail("standard-episode", `status ${episode.status}`);
  const episodeStreams = asRecord(await episode.json())?.streams;
  if (!Array.isArray(episodeStreams))
    fail("standard-episode", "streams missing");
  else if (
    episodeStreams.some((stream) => asRecord(stream)?.externalUrl !== undefined)
  )
    fail("standard-episode", "Engine rejected the credential");
  else
    pass(
      "standard-episode",
      `release results ${episodeStreams.length}; no media consumed`,
    );
  const season = await engineCall("GetTVShowSeasonDownloads", {
    imdbId: "tt0903747",
    seasonNumber: 1,
  });
  const answer = asRecord(await season.json().catch(() => undefined));
  if (refused(season, answer))
    fail(
      "season-downloads",
      `Engine refused the lookup: status ${season.status}`,
    );
  pass(
    "season-downloads",
    season.ok
      ? `season pack ${answer?.seasonPack === undefined ? "absent" : "offered"}`
      : `status ${season.status}`,
  );
  // A public-domain film; an empty answer passes.
  const owned = await engineCall("FindOwnedVideos", {
    title: "Night of the Living Dead",
    year: 1968,
  });
  const found = asRecord(await owned.json().catch(() => undefined));
  if (refused(owned, found))
    fail("owned-videos", `Engine refused the lookup: status ${owned.status}`);
  pass(
    "owned-videos",
    owned.ok
      ? `videos ${Array.isArray(found?.videos) ? found.videos.length : 0}`
      : `status ${owned.status}`,
  );
  passed = true;
} catch (error) {
  if (steps.at(-1)?.passed !== false)
    steps.push({
      name: "unexpected",
      passed: false,
      detail: clean(error instanceof Error ? error.message : String(error)),
    });
} finally {
  await mkdir(artifact, { recursive: true });
  await writeFile(
    `${artifact}/results.json`,
    redactCredentials(
      JSON.stringify(
        { origin, passed, steps, credentials: "designated-account" },
        null,
        2,
      ),
    ),
  );
  console.log(`${passed ? "passed" : "failed"} ${artifact}/results.json`);
  process.exitCode = passed ? 0 : 1;
}
