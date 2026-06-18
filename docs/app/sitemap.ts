import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';

// The site is served from a subpath on GitHub Pages (e.g. /actio), so every
// emitted URL must include that prefix. CI sets PAGES_BASE_PATH; locally it
// stays empty and the site serves from root.
const host = 'https://austenstone.github.io';
const basePath = process.env.PAGES_BASE_PATH ?? '';
const baseUrl = `${host}${basePath}`;

export const revalidate = false;

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${baseUrl}/` },
    ...source.getPages().map((page) => ({
      url: `${baseUrl}${page.url}`,
    })),
  ];
}
