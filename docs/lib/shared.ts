export const appName = 'Actio';

// On GitHub Pages the site is served from a subpath (e.g. /actio).
// Must match basePath in next.config.mjs. Next only auto-prefixes basePath for
// next/link, next/image and the router, so hand-built URLs need it applied manually.
export const basePath = process.env.PAGES_BASE_PATH ?? '';

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
