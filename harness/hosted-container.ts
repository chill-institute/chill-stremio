import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const image = process.argv[2] ?? "chill-stremio:release-candidate";
const suffix = randomBytes(8).toString("hex");
const container = `chill-stremio-proof-${suffix}`;
const volume = `${container}-data`;
const backup = `${volume}-backup`;
const key = randomBytes(32).toString("hex");
const directory = `artifacts/container-${new Date().toISOString().replaceAll(":", "-")}`;
const env = { ...process.env, CHILL_INSTALLATION_KEY_HEX: key };
const docker = async (args: string[]) =>
  (
    await execute("docker", args, {
      env,
      timeout: 40_000,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
const common = [
  "--name",
  container,
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--memory=256m",
  "--cpus=1",
  "--mount",
  `type=volume,src=${volume},dst=/data`,
  "--env",
  "CHILL_INSTALLATION_KEY_HEX",
  "--env",
  "CHILL_PUBLIC_ORIGIN=http://127.0.0.1:7000",
];
const health =
  'const r=await fetch("http://127.0.0.1:7000/health"); if(r.status!==200 || (await r.json()).status!=="ok")process.exit(1)';
const store =
  'const {InstallationStore}=await import("./src/installations.ts"); const s=await InstallationStore.open("/data/installations.sqlite",Buffer.from(process.env.CHILL_INSTALLATION_KEY_HEX,"hex"));';
let passed = false;
let cleanupPassed = false;
async function ready() {
  const deadline = performance.now() + 15_000;
  while (performance.now() < deadline) {
    try {
      await docker([
        "exec",
        container,
        "node",
        "--input-type=module",
        "-e",
        health,
      ]);
      return;
    } catch {
      await delay(250);
    }
  }
  throw new Error("Container readiness failed");
}
try {
  await docker(["volume", "create", volume]);
  await docker(["run", "--detach", ...common, image]);
  await ready();
  await docker([
    "exec",
    container,
    "node",
    "--input-type=module",
    "-e",
    `${store}
    if(process.getuid()===0)process.exit(1);
    const i=s.create({owner:"container-fixture",token:"fake-container-bearer",folderId:"0"});
    s.claim(i.id,"chill:movie:MQ","fixture-release");s.close();`,
  ]);
  await docker(["stop", "--time", "10", container]);
  assert.equal(
    await docker(["inspect", "--format", "{{.State.ExitCode}}", container]),
    "0",
  );
  await docker(["start", container]);
  await ready();
  await docker([
    "exec",
    container,
    "node",
    "--input-type=module",
    "-e",
    `${store}
    const records=s.list("container-fixture");
    if(records.length!==1 || s.operations(records[0].id)[0]?.state!=="unknown")process.exit(1);
    const {statSync}=await import("node:fs");
    if((statSync("/data/installations.sqlite").mode&511)!==384)process.exit(1);s.close();`,
  ]);
  await docker(["stop", "--time", "10", container]);
  await docker(["rm", container]);
  env.CHILL_INSTALLATION_KEY_HEX = randomBytes(32).toString("hex");
  await assert.rejects(docker(["run", ...common, image]));
  assert.equal(
    await docker(["inspect", "--format", "{{.State.ExitCode}}", container]),
    "1",
  );
  await docker(["rm", container]);
  env.CHILL_INSTALLATION_KEY_HEX = key;
  await docker(["volume", "create", backup]);
  await docker([
    "run",
    "--rm",
    "--read-only",
    "--cap-drop=ALL",
    "--network=none",
    "--mount",
    `type=volume,src=${volume},dst=/source,readonly`,
    "--mount",
    `type=volume,src=${backup},dst=/data`,
    image,
    "node",
    "-e",
    'require("node:fs").cpSync("/source/.","/data",{recursive:true})',
  ]);
  const restore = common.map((value) =>
    value === `type=volume,src=${volume},dst=/data`
      ? `type=volume,src=${backup},dst=/data`
      : value,
  );
  await docker(["run", "--detach", ...restore, image]);
  await ready();
  await docker([
    "exec",
    container,
    "node",
    "--input-type=module",
    "-e",
    `${store}
    const records=s.list("container-fixture");
    if(records.length!==1 || s.operations(records[0].id).length!==1)process.exit(1);s.close();`,
  ]);
  await docker(["stop", "--time", "10", container]);
  passed = true;
} catch {
  process.exitCode = 1;
} finally {
  await docker(["rm", "--force", container]).catch(() => {});
  try {
    await docker(["volume", "rm", volume, backup]);
    cleanupPassed = true;
  } catch {
    process.exitCode = 1;
  }
  await mkdir(directory, { recursive: true });
  await writeFile(
    `${directory}/results.json`,
    JSON.stringify(
      {
        status: passed && cleanupPassed ? "passed" : "failed",
        credentials: "generated-fake-only",
        nonRoot: passed,
        readOnlyRoot: passed,
        health: passed,
        restartPreservedInstallationAndClaim: passed,
        wrongKeyRejected: passed,
        stoppedBackupRestoredInIsolation: passed,
        cleanSigterm: passed,
        cleanupPassed,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: passed && cleanupPassed ? "passed" : "failed",
      results: `${directory}/results.json`,
    }),
  );
}
