import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      check: { command: "vp check" },
      // Tests write only scratch files, so a cache hit restores nothing.
      test: { command: "vp test", cache: { output: [] } },
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    env: {
      FONTCONFIG_FILE: fileURLToPath(
        new URL("harness/fonts/fonts.conf", import.meta.url),
      ),
    },
  },
  fmt: {
    printWidth: 80,
    ignorePatterns: [".cache/**", "artifacts/**", "pnpm-lock.yaml"],
  },
  lint: {
    ignorePatterns: [".cache/**", "artifacts/**"],
    options: { typeAware: true, typeCheck: true },
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      // Effect.fn generators also defer synchronous work until execution.
      "require-yield": "off",
    },
  },
});
