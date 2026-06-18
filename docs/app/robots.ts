import type { MetadataRoute } from 'next';

// The site is served from a subpath on GitHub Pages (e.g. /actio), so the
// sitemap URL must include that prefix. CI sets PAGES_BASE_PATH; locally it
// stays empty and the site serves from root.
const host = 'https://austenstone.github.io';
const basePath = process.env.PAGES_BASE_PATH ?? '';
const baseUrl = `${host}${basePath}`;

export const revalidate = false;

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
