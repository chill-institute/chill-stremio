import { mkdir, writeFile } from "node:fs/promises";
import { authorizeChill } from "./auth.ts";
import { designatedAccountPresent, redactLive } from "./redact.ts";

// Read-only proof that the deployed adapter serves the designated account:
// create an installation through the public management API, read its manifest
// and its catalogs, revoke it, and require the capability to stop resolving.
// No stream is consumed, so no transfer or allowance is involved.
const origin = new URL(
  process.env.CHILL_PUBLIC_STREMIO_ORIGIN ?? "https://stremio.chill.institute",
).origin;
const webOrigin = "https://chill.institute";
const stamp = new Date().toISOString().replaceAll(":", "-");
const artifact = `artifacts/public-${stamp}`;
type Step = { name: string; passed: boolean; detail?: string };
const steps: Step[] = [];
const signal = AbortSignal.timeout(4 * 60 * 1000);
const failure = (name: string, detail: string) => {
  steps.push({ name, passed: false, detail: redactLive(detail) });
  return new Error(`${name}: ${detail}`);
};
const fail = (name: string, detail: string): never => {
  throw failure(name, detail);
};
const pass = (name: string, detail?: string) =>
  steps.push({ name, passed: true, ...(detail ? { detail } : {}) });
const call = async (token: string, path: string, init: RequestInit = {}) =>
  fetch(`${origin}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      origin: webOrigin,
      "content-type": "application/json",
    },
    signal,
    redirect: "error",
  });
const read = async (path: string) =>
  fetch(`${origin}${path}`, { signal, redirect: "error" });
const asRecord = (value: unknown) =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;

let token: string | undefined;
let installationId: string | undefined;
let base: string | undefined;
let passed = false;
try {
  if (!designatedAccountPresent())
    fail("configuration", "designated account absent");
  const health = await read("/health");
  if (health.status !== 200) fail("health", `status ${health.status}`);
  pass("health");
  token = await authorizeChill({ signal });
  pass("authorize");
  const created = await call(token, "/api/installations", {
    method: "POST",
    body: "{}",
  });
  if (created.status !== 201) fail("create", `status ${created.status}`);
  const installation = asRecord(await created.json());
  const manifestUrl = installation?.manifestUrl;
  if (typeof installation?.id !== "string" || typeof manifestUrl !== "string")
    throw failure("create", "unexpected installation view");
  installationId = installation.id;
  const manifestPath = new URL(manifestUrl);
  if (manifestPath.origin !== origin)
    fail("create", "manifest origin mismatch");
  base = manifestPath.pathname.replace(/\/manifest\.json$/, "");
  if (installation?.folderId !== "0")
    fail("create", "library root not selected");
  pass("create", "whole-library connection without folder selection");
  const manifest = await read(`${base}/manifest.json`);
  if (manifest.status !== 200) fail("manifest", `status ${manifest.status}`);
  const description = asRecord(await manifest.json())?.description;
  if (
    typeof description !== "string" ||
    !description.startsWith("Early access")
  )
    fail("manifest", "missing early-access description");
  pass("manifest", "early-access description");
  const catalog = await read(`${base}/catalog/movie/downloads.json`);
  if (catalog.status !== 200) fail("catalog", `status ${catalog.status}`);
  const metas = asRecord(await catalog.json())?.metas;
  if (!Array.isArray(metas)) throw failure("catalog", "metas missing");
  pass("catalog", `downloads ${metas.length}`);
  const library = await read(`${base}/catalog/movie/library.json`);
  if (library.status !== 200) fail("library", `status ${library.status}`);
  const videos = asRecord(await library.json())?.metas;
  if (!Array.isArray(videos)) throw failure("library", "metas missing");
  pass("library", `videos ${videos.length}`);
  const sources = await read(`${base}/stream/movie/tt0133093.json`);
  if (sources.status !== 200)
    fail("standard-title", `status ${sources.status}`);
  const streams = asRecord(await sources.json())?.streams;
  if (!Array.isArray(streams) || streams.length === 0)
    throw failure(
      "standard-title",
      "no release results for the reference IMDb movie",
    );
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
      detail: redactLive(
        error instanceof Error ? error.message : String(error),
      ),
    });
} finally {
  if (token && installationId) {
    try {
      const revoked = await call(
        token,
        `/api/installations/${installationId}`,
        {
          method: "DELETE",
        },
      );
      const after = base ? await read(`${base}/manifest.json`) : undefined;
      if (revoked.status === 204 && after?.status === 404) pass("revoke");
      else {
        passed = false;
        steps.push({
          name: "revoke",
          passed: false,
          detail: `revoke ${revoked.status}, manifest ${after?.status ?? "unread"}`,
        });
      }
    } catch (error) {
      passed = false;
      steps.push({
        name: "revoke",
        passed: false,
        detail: redactLive(
          error instanceof Error ? error.message : String(error),
        ),
      });
    }
  }
  await mkdir(artifact, { recursive: true });
  await writeFile(
    `${artifact}/results.json`,
    JSON.stringify(
      { origin, passed, steps, credentials: "designated-account" },
      null,
      2,
    ),
  );
  console.log(`${passed ? "passed" : "failed"} ${artifact}/results.json`);
  process.exitCode = passed ? 0 : 1;
}
