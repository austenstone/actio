import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "actio-core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: [
        "packages/core/src/passes/**",
        "packages/core/src/emit.ts",
        "packages/core/src/ir.ts",
        "packages/core/src/transpile.ts",
        "packages/core/src/validate.ts",
        "packages/core/src/diagnostics.ts",
      ],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 93,
        lines: 93,
        "packages/core/src/passes/**": {
          statements: 92,
          branches: 85,
          functions: 95,
          lines: 94,
        },
      },
    },
    server: {
      deps: {
        // workflow-parser has a bare JSON import without an import attribute;
        // inlining lets Vite transform it instead of Node's strict ESM loader.
        inline: ["@actions/workflow-parser"],
      },
    },
  },
});
