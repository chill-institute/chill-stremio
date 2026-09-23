import { mkdir, writeFile } from "node:fs/promises";
import { isCredential, redactCredentials } from "../../src/credential.ts";
import { redactLive } from "./redact.ts";

// Read-only proof that the deployed adapter serves the designated account
// through an Engine-issued add-on credential: read its manifest, library and
// release results. No stream is consumed, so no transfer or allowance is used.
const origin = new URL(
  process.env.CHILL_PUBLIC_STREMIO_ORIGIN ?? "https://stremio.chill.institute",
).origin;
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
const asRecord = (value: unknown) =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

let passed = false;
try {
  if (!isCredential(credential))
    fail("configuration", "designated add-on credential absent");
  const health = await read("/health");
  if (health.status !== 200) fail("health", `status ${health.status}`);
  pass("health");
  const publicManifest = await read("/manifest.json");
  const hints = asRecord(asRecord(await publicManifest.json())?.behaviorHints);
  if (publicManifest.status !== 200 || hints?.configurationRequired !== true)
    fail("public-manifest", `status ${publicManifest.status}`);
  pass("public-manifest", "configuration required");
  const base = `/s/${credential}`;
  const manifest = await read(`${base}/manifest.json`);
  if (manifest.status !== 200) fail("manifest", `status ${manifest.status}`);
  const description = asRecord(await manifest.json())?.description;
  if (
    typeof description !== "string" ||
    !description.startsWith("Early access")
  )
    fail("manifest", "missing early-access description");
  pass("manifest", "early-access description");
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
