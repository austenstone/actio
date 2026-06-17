import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node20",
  // Bundle workflow-parser in: it ships a bare `import x from "*.json"` without an
  // import attribute, which Node >=20/22 ESM rejects at runtime. esbuild inlines
  // the JSON during bundling, producing a portable build.
  noExternal: ["@actions/workflow-parser"],
});
