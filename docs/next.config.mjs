import { join } from 'node:path';
import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// The playground imports `actio-core`, which is symlinked from ../packages/core
// (outside the docs project). Turbopack only resolves modules under its root, so
// pin the root to the repo so that sibling package can be bundled.
const turbopackRoot = join(import.meta.dirname, '..');

// On GitHub Pages the site is served from a subpath (e.g. /actio).
// CI sets PAGES_BASE_PATH; locally it stays unset so the site serves from root.
const basePath = process.env.PAGES_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  // actio-core ships as ESM built for node20; let Next transpile it for the browser.
  transpilePackages: ['actio-core'],
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: {
    root: turbopackRoot,
    // actio-core's schema.ts imports node `fs`/`url` for the CLI and lint.ts
    // imports `child_process` to invoke actionlint. The playground never
    // exercises those paths, so stub them for the browser bundle only
    // (server/SSG bundles keep the real builtins).
    resolveAlias: {
      fs: { browser: './lib/browser/fs-stub.ts' },
      url: { browser: './lib/browser/url-stub.ts' },
      child_process: { browser: './lib/browser/child_process-stub.ts' },
    },
  },
  // Inline PAGES_BASE_PATH into client bundles too. Without this, basePath in
  // lib/shared.ts resolves to '' in the browser (Next only auto-inlines
  // NEXT_PUBLIC_* vars), breaking the hand-built static search fetch URL.
  env: { PAGES_BASE_PATH: basePath },
  ...(basePath ? { basePath } : {}),
};

export default withMDX(config);
