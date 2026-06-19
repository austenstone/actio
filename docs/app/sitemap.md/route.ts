import { appName, basePath } from '@/lib/shared';
import { getPageMarkdownUrl, source } from '@/lib/source';

export const revalidate = false;

// A human- and agent-readable Markdown sitemap, complementing sitemap.xml.
// Each entry links to the page and its Markdown mirror so agents can fetch
// clean content directly.
export function GET() {
  const lines: string[] = [
    `# ${appName} Documentation Sitemap`,
    '',
    `> Every page in the ${appName} docs, with a link to its Markdown mirror.`,
    '',
    `- [Home](${basePath || '/'})`,
    '',
    '## Documentation',
    '',
  ];

  for (const page of source.getPages()) {
    const title = page.data.title ?? page.url;
    const description = page.data.description ? ` — ${page.data.description}` : '';
    const mdUrl = getPageMarkdownUrl(page).url;
    lines.push(`- [${title}](${basePath}${page.url})${description} ([Markdown](${mdUrl}))`);
  }

  lines.push('');

  return new Response(`${lines.join('\n')}\n`, {
    headers: { 'Content-Type': 'text/markdown;charset=UTF-8' },
  });
}
