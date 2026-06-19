import { execFileSync } from 'node:child_process';
import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/shared';
import { source } from '@/lib/source';

export const revalidate = false;

// One timestamp per build so pages without their own git history still get a
// stable, monotonic lastModified.
const buildDate = new Date();

// Last commit date for a docs source file. On shallow CI checkouts this may
// resolve to the tip commit for every file, which is acceptable.
function lastModified(sourcePath: string): Date {
  try {
    const iso = execFileSync('git', ['log', '-1', '--format=%cI', '--', sourcePath], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    return iso ? new Date(iso) : buildDate;
  } catch {
    return buildDate;
  }
}

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${siteUrl}/`, lastModified: buildDate },
    ...source.getPages().map((page) => ({
      url: `${siteUrl}${page.url}`,
      lastModified: lastModified(`content/docs/${page.path}`),
    })),
  ];
}
