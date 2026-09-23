import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { redactCredentials } from "../src/credential.ts";

const execute = promisify(execFile);
const image = process.argv[2] ?? "chill-stremio:release-candidate";
const container = `chill-stremio-proof-${randomBytes(8).toString("hex")}`;
const directory = `artifacts/container-${new Date().toISOString().replaceAll(":", "-")}`;
const credential = `v4.local.${randomBytes(300).toString("base64url")}`;
const env = { ...process.env, CHILL_FAKE_CREDENTIAL: credential };
const docker = async (args: string[]) => {
  const { stdout, stderr } = await execute("docker", args, {
    env,
    timeout: 40_000,
    maxBuffer: 1024 * 1024,
  });
  return `${stdout}${stderr}`.trim();
};
const run = [
  "--name",
  container,
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--memory=256m",
  "--cpus=1",
  "--env",
  "CHILL_PUBLIC_ORIGIN=http://127.0.0.1:7000",
  // A closed loopback port stands in for Engine; no request leaves the container.
  "--env",
  "CHILL_ENGINE_BASE_URL=http://127.0.0.1:9",
];
const inside = (script: string) =>
  docker([
    "exec",
    "--env",
    "CHILL_FAKE_CREDENTIAL",
    container,
    "node",
    "--input-type=module",
    "-e",
    script,
  ]);
const health =
  'const r=await fetch("http://127.0.0.1:7000/health"); if(r.status!==200 || (await r.json()).status!=="ok")process.exit(1)';
const checks = {
  nonRoot: false,
  readOnlyRoot: false,
  noStateDirectory: false,
  health: false,
  credentialManifest: false,
  removedRoutesAbsent: false,
  engineFailureSanitized: false,
  credentialAbsentFromLogs: false,
  cleanSigterm: false,
  statelessRestart: false,
};
let cleanupPassed = false;
async function ready() {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    try {
      await inside(health);
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error("Container readiness failed");
}
try {
  await docker(["run", "--detach", ...run, image]);
  await ready();
  checks.health = true;
  await inside("if(process.getuid()===0)process.exit(1)");
  checks.nonRoot = true;
  await inside(
    'const {writeFileSync}=await import("node:fs"); try{writeFileSync("/app/probe","x")}catch{process.exit(0)} process.exit(1)',
  );
  checks.readOnlyRoot = true;
  await inside(
    'const {existsSync}=await import("node:fs"); if(existsSync("/data"))process.exit(1)',
  );
  checks.noStateDirectory = true;
  await inside(`
    const base="http://127.0.0.1:7000/s/"+process.env.CHILL_FAKE_CREDENTIAL;
    const r=await fetch(base+"/manifest.json");
    if(r.status!==200 || (await r.json()).id!=="institute.chill.library")process.exit(1);`);
  checks.credentialManifest = true;
  await inside(`
    for (const path of ["/i/${"x".repeat(43)}/manifest.json","/api/installations","/s/not-a-credential/manifest.json"]) {
      if((await fetch("http://127.0.0.1:7000"+path)).status!==404)process.exit(1);
    }`);
  checks.removedRoutesAbsent = true;
  await inside(`
    const r=await fetch("http://127.0.0.1:7000/s/"+process.env.CHILL_FAKE_CREDENTIAL+"/catalog/movie/library.json");
    const body=await r.text();
    if(r.status<500 || body.includes(process.env.CHILL_FAKE_CREDENTIAL) || !/^\\{"error":"[a-z_]+"\\}$/.test(body))process.exit(1);`);
  checks.engineFailureSanitized = true;
  await docker(["stop", "--time", "10", container]);
  assert.equal(
    await docker(["inspect", "--format", "{{.State.ExitCode}}", container]),
    "0",
  );
  checks.cleanSigterm = true;
  await docker(["start", container]);
  await ready();
  await inside(`
    const r=await fetch("http://127.0.0.1:7000/s/"+process.env.CHILL_FAKE_CREDENTIAL+"/manifest.json");
    if(r.status!==200)process.exit(1);`);
  checks.statelessRestart = true;
  await docker(["stop", "--time", "10", container]);
  const logs = await docker(["logs", container]);
  assert.ok(!logs.includes(credential));
  assert.ok(!logs.includes("v4.local."));
  checks.credentialAbsentFromLogs = true;
} catch {
  process.exitCode = 1;
} finally {
  try {
    await docker(["rm", "--force", container]);
    cleanupPassed = true;
  } catch {
    process.exitCode = 1;
  }
  const passed = Object.values(checks).every(Boolean) && cleanupPassed;
  if (!passed) process.exitCode = 1;
  await mkdir(directory, { recursive: true });
  const receipt = redactCredentials(
    JSON.stringify(
      {
        status: passed ? "passed" : "failed",
        credentials: "generated-fake-only",
        ...checks,
        cleanupPassed,
      },
      null,
      2,
    ),
  );
  await writeFile(`${directory}/results.json`, receipt);
  console.log(
    JSON.stringify({
      status: passed ? "passed" : "failed",
      results: `${directory}/results.json`,
    }),
  );
}
