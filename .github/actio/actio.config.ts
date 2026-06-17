import { defineConfig } from "@actio/core";

export default defineConfig({
  files: [".github/actio/**/*.actio.yml"],
  outDir: ".github/workflows",
});
