export const appName = 'Actio';

export const appDescription =
  'Actio is a transpiler that compiles a clean .actio.yml source — a strict superset of GitHub Actions YAML — into the verbose standard workflow YAML you would otherwise hand-write. Macros expand at compile time, so there is no runtime and no lock-in.';

// On GitHub Pages the site is served from a subpath (e.g. /actio).
// Must match basePath in next.config.mjs. Next only auto-prefixes basePath for
// next/link, next/image and the router, so hand-built URLs need it applied manually.
export const basePath = process.env.PAGES_BASE_PATH ?? '';

// Absolute origin + base path, used for canonical URLs, Open Graph, robots and
// sitemaps. Locally basePath is empty so the site serves from root.
export const siteHost = 'https://austenstone.github.io';
export const siteUrl = `${siteHost}${basePath}`;

export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

export const gitConfig = {
  user: 'austenstone',
  repo: 'actio',
  branch: 'main',
  // The Next docs app lives in the repo's `docs/` subfolder, so MDX sources are
  // at `docs/content/docs/...`. This prefix maps a page path back to its file.
  contentRoot: 'docs/content/docs',
};
