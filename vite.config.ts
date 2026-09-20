import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
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
