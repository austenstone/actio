// @ts-check
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RendererEvent } from "typedoc";
import { MarkdownPageEvent } from "typedoc-plugin-markdown";

/**
 * @param {{ url: string, model?: { name?: string } }} page
 */
function titleFor(page) {
  const isIndex = /(^|\/)index\.mdx$/.test(page.url);
  return isIndex ? "API Reference" : (page.model?.name ?? page.url);
}

/**
 * Bridges TypeDoc's markdown output to Fumadocs:
 * - prepends a `title` frontmatter (Fumadocs `pageSchema` requires it)
 * - writes a `meta.json` so the generated folder slots into the sidebar
 *
 * @param {import("typedoc").Application} app
 */
export function load(app) {
  app.renderer.on(MarkdownPageEvent.END, (page) => {
    const title = titleFor(page).replace(/"/g, '\\"');
    page.contents = `---\ntitle: "${title}"\n---\n\n${page.contents ?? ""}`;
  });

  app.renderer.on(RendererEvent.END, (event) => {
    const meta = { title: "API Reference", pages: ["index", "..."] };
    writeFileSync(
      join(event.outputDirectory, "meta.json"),
      `${JSON.stringify(meta, null, 2)}\n`,
    );
  });
}
