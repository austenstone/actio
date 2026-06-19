import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/main.ts",
    "config-export": "src/config-export.ts",
  },
  format: ["esm"],
  clean: true,
  sourcemap: true,
  dts: { entry: "src/config-export.ts" },
  target: "node20",
  // actio-core is resolved from node_modules (workspace symlink) at runtime.
  external: ["actio-core"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
