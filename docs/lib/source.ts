import { docs } from 'collections/server';
import { loader } from 'fumadocs-core/source';
import { basePath, docsContentRoute, docsImageRoute, docsRoute, siteUrl } from './shared';

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  plugins: [],
});

export function getPageImage(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: `${docsImageRoute}/${segments.join('/')}`,
  };
}

export function getPageMarkdownUrl(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'content.md'];

  return {
    segments,
    url: `${basePath}${docsContentRoute}/${segments.join('/')}`,
  };
}

export async function getLLMText(
  page: (typeof source)['$inferPage'],
  { includeSitemap = false }: { includeSitemap?: boolean } = {},
) {
  const processed = await page.data.getText('processed');

  const sitemap = includeSitemap
    ? `\n\n## Sitemap\n\nBrowse the full documentation: [Markdown sitemap](${siteUrl}/sitemap.md) · [XML sitemap](${siteUrl}/sitemap.xml)`
    : '';

  return `# ${page.data.title} (${page.url})

${processed}${sitemap}`;
}
