import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  sourcemap: true,
  target: "node20",
  // @actio/core is resolved from node_modules (workspace symlink) at runtime.
  external: ["@actio/core"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
