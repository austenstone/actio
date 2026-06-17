import { defineConfig } from "tsup";

// GitHub Actions run the committed `dist/index.js` with no node_modules, so the
// whole dependency tree is bundled into one self-contained CJS file.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  clean: true,
  target: "node20",
  noExternal: [/.*/],
});
