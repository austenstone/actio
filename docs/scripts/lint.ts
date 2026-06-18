import { register } from 'fumadocs-mdx/node';
import { type FileObject, printErrors, scanURLs, validateFiles } from 'next-validate-link';

// `source` reads MDX lazily through the Fumadocs MDX loader, which only works
// once the Node.js loader is registered. See https://www.fumadocs.dev/docs/mdx/loader/node
register();

async function checkLinks() {
  const { source } = await import('@/lib/source');
  type Page = (typeof source)['$inferPage'];

  const pages = source.getPages();

  // TypeDoc-generated API pages cross-link via a relative `.mdx` style that
  // isn't resolvable the same way as hand-written content. We keep them as
  // valid link targets (below) but don't lint their generated internals.
  const isGenerated = (page: Page) => page.slugs[0] === 'api';

  const getHeadings = ({ data }: Page): string[] =>
    data.toc.map((item) => item.url.slice(1));

  const getFiles = () =>
    Promise.all(
      pages.filter((page) => !isGenerated(page)).map(
        async (page): Promise<FileObject> => ({
          path: page.absolutePath ?? page.url,
          content: await page.data.getText('raw'),
          url: page.url,
          data: page.data,
        }),
      ),
    );

  const scanned = await scanURLs({
    preset: 'next',
    populate: {
      'docs/[[...slug]]': pages.map((page) => ({
        value: { slug: page.slugs },
        hashes: getHeadings(page),
      })),
    },
  });

  printErrors(
    await validateFiles(await getFiles(), {
      scanned,
      // check `href` attributes on Fumadocs components used in content
      markdown: {
        components: {
          Card: { attributes: ['href'] },
        },
      },
      // resolve relative paths to their public URL
      checkRelativePaths: 'as-url',
    }),
    true,
  );
}

void checkLinks();
