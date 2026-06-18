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
  ...(basePath ? { basePath } : {}),
};

export default withMDX(config);
