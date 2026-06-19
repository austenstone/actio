import { getPageImage, getPageMarkdownUrl, source } from '@/lib/source';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { getMDXComponents } from '@/components/mdx';
import type { Metadata } from 'next';
import { createRelativeLink } from 'fumadocs-ui/mdx';
import { appName, gitConfig, siteHost, siteUrl } from '@/lib/shared';

export default async function Page(props: PageProps<'/docs/[[...slug]]'>) {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const MDX = page.data.body;
  const markdownUrl = getPageMarkdownUrl(page).url;

  const canonical = `${siteUrl}${page.url}/`;
  const imageUrl = `${siteUrl}${getPageImage(page).url}`;

  const breadcrumbItems = [
    { name: 'Home', url: `${siteUrl}/` },
    { name: 'Documentation', url: `${siteUrl}/docs/` },
  ];
  if (page.url !== '/docs') {
    breadcrumbItems.push({ name: page.data.title, url: canonical });
  }

  const jsonLd = [
    {
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: page.data.title,
      description: page.data.description,
      url: canonical,
      image: imageUrl,
      inLanguage: 'en',
      isPartOf: { '@type': 'WebSite', name: appName, url: `${siteUrl}/` },
      author: { '@type': 'Person', name: 'Austen Stone', url: 'https://github.com/austenstone' },
      publisher: { '@type': 'Person', name: 'Austen Stone', url: 'https://github.com/austenstone' },
    },
    {
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumbItems.map((item, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        name: item.name,
        item: item.url,
      })),
    },
  ];

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription className="mb-0">{page.data.description}</DocsDescription>
      <div className="flex flex-row gap-2 items-center border-b pb-6">
        <MarkdownCopyButton markdownUrl={markdownUrl} />
        <ViewOptionsPopover
          markdownUrl={markdownUrl}
          githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/${gitConfig.contentRoot}/${page.path}`}
        />
      </div>
      <DocsBody>
        <MDX
          components={getMDXComponents({
            // this allows you to link to other pages with relative file paths
            a: createRelativeLink(source, page),
          })}
        />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: PageProps<'/docs/[[...slug]]'>): Promise<Metadata> {
  const params = await props.params;
  const page = source.getPage(params.slug);
  if (!page) notFound();

  const canonical = `${siteUrl}${page.url}/`;
  const imageUrl = `${siteUrl}${getPageImage(page).url}`;
  const markdownUrl = `${siteHost}${getPageMarkdownUrl(page).url}`;

  return {
    title: page.data.title,
    description: page.data.description,
    alternates: {
      canonical,
      types: {
        'text/markdown': markdownUrl,
      },
    },
    openGraph: {
      type: 'article',
      title: page.data.title,
      description: page.data.description,
      url: canonical,
      images: imageUrl,
    },
    twitter: {
      card: 'summary_large_image',
      title: page.data.title,
      description: page.data.description,
      images: imageUrl,
    },
  };
}
