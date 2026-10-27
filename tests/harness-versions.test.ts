import { readFileSync } from "node:fs";
import { test, expect } from "vite-plus/test";
import { versions } from "../harness/versions.ts";

// Setup refuses to run when an installed package differs from its harness pin,
// so a dependency update that misses versions.ts breaks publish, not verify.
test("harness pins match the declared dependency versions", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const declared = { ...manifest.dependencies, ...manifest.devDependencies };
  expect({
    effect: declared["effect"],
    "@effect/platform-node": declared["@effect/platform-node"],
    "@playwright/test": declared["@playwright/test"],
    "stremio-addon-sdk": declared["stremio-addon-sdk"],
    "stremio-addon-client": declared["stremio-addon-client"],
    "stremio-addon-linter": declared["stremio-addon-linter"],
  }).toEqual({
    effect: versions.effect,
    "@effect/platform-node": versions.effect,
    "@playwright/test": versions.playwright,
    "stremio-addon-sdk": versions.sdk,
    "stremio-addon-client": versions.client,
    "stremio-addon-linter": versions.linter,
  });
});
