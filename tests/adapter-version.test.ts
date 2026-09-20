import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "vite-plus/test";

const script = `import("./src/server.ts").then((m) => process.stdout.write(m.adapterVersion))`;

function versionWith(env: Record<string, string>) {
  return execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "-e", script],
    {
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    },
  );
}

test("manifest version comes from CHILL_ADAPTER_VERSION and falls back to 0.0.0", () => {
  assert.equal(versionWith({ CHILL_ADAPTER_VERSION: "1.4.2" }), "1.4.2");
  assert.equal(versionWith({}), "0.0.0");
  assert.equal(versionWith({ CHILL_ADAPTER_VERSION: "latest" }), "0.0.0");
});
