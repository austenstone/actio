import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@actio/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    environment: "node",
    server: {
      deps: {
        // workflow-parser has a bare JSON import without an import attribute;
        // inlining lets Vite transform it instead of Node's strict ESM loader.
        inline: ["@actions/workflow-parser"],
      },
    },
  },
});
