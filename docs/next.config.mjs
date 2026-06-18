import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// On GitHub Pages the site is served from a subpath (e.g. /actio).
// CI sets PAGES_BASE_PATH; locally it stays unset so the site serves from root.
const basePath = process.env.PAGES_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: { root: import.meta.dirname },
  // Inline PAGES_BASE_PATH into client bundles too. Without this, basePath in
  // lib/shared.ts resolves to '' in the browser (Next only auto-inlines
  // NEXT_PUBLIC_* vars), breaking the hand-built static search fetch URL.
  env: { PAGES_BASE_PATH: basePath },
  ...(basePath ? { basePath } : {}),
};

export default withMDX(config);
