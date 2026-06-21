import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { builtinPasses } from "actio-core";
import { describe, expect, it } from "vitest";

// Docs guardrail: a new user-facing feature cannot merge without docs.
// - every built-in pass needs a dedicated macros/<keyword>.mdx page,
// - every ActioConfig key must be named in configuration.mdx,
// - every top-level CLI command must be named in cli.mdx (pins lives in
//   supply-chain.mdx, the one explicit exception below).

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const macrosDir = join(repoRoot, "docs/content/docs/macros");
const docsDir = join(repoRoot, "docs/content/docs");

// Pass name -> macro page slug, when the user-facing keyword differs from the
// internal pass name. `when-compile` ships as the `static-if` keyword.
const passPageSlug: Record<string, string> = {
  "when-compile": "static-if",
};

// Internal-only passes that intentionally ship WITHOUT a user-facing macro page.
// Adding a pass here is an explicit, reviewed decision to leave it undocumented.
// Keep it tiny and justified. `share-matrix-check` is not a keyword: it is the
// deferred half of the `share` macro's clobber guard, re-run after the matrix
// passes settle (#158), and is documented on the share page.
const internalPassAllowlist: ReadonlySet<string> = new Set<string>(["share-matrix-check"]);

const macroPagePath = (passName: string): string =>
  join(macrosDir, `${passPageSlug[passName] ?? passName}.mdx`);

const readDoc = (relPath: string): string => readFileSync(join(docsDir, relPath), "utf8");

const extractActioConfigKeys = (): string[] => {
  const src = readFileSync(join(repoRoot, "packages/core/src/config.ts"), "utf8");
  const marker = "export interface ActioConfig {";
  const start = src.indexOf(marker);
  if (start === -1) throw new Error("ActioConfig interface not found in config.ts");
  const body = src.slice(start + marker.length);
  const end = body.indexOf("\n}");
  const fields = body.slice(0, end);
  const keys = new Set<string>();
  for (const line of fields.split("\n")) {
    // Top-level members are indented exactly two spaces; JSDoc (`   *`) is not.
    const match = /^ {2}(\w+)\??:/.exec(line);
    if (match) keys.add(match[1]);
  }
  return [...keys];
};

const extractCliCommands = (): string[] => {
  const src = readFileSync(join(repoRoot, "packages/cli/src/cli.ts"), "utf8");
  // `.command(` may wrap onto the next line before the string literal.
  const re = /\.command\(\s*["'`]([a-z][\w-]*)/g;
  return [...new Set([...src.matchAll(re)].map((match) => match[1]))];
};

// pins is documented end-to-end on the supply-chain page, not cli.mdx.
const commandDocFile: Record<string, string> = {
  pins: "supply-chain.mdx",
};

describe("docs completeness", () => {
  it("requires a macro page for every user-facing built-in pass", () => {
    const missing = builtinPasses
      .map((pass) => pass.name)
      .filter((name) => !internalPassAllowlist.has(name))
      .filter((name) => !existsSync(macroPagePath(name)));

    const fix = missing
      .map((name) => `${name} -> docs/content/docs/macros/${passPageSlug[name] ?? name}.mdx`)
      .join(", ");
    expect(
      missing,
      `Built-in pass(es) without a macro doc page: ${fix}. ` +
        "Fix: run `npm run docs:new <name>` to scaffold the page (note: the `when-compile` pass " +
        "ships as the `static-if` slug), then add the slug to docs/content/docs/macros/meta.json.",
    ).toEqual([]);
  });

  it("documents every ActioConfig key in configuration.mdx", () => {
    const config = readDoc("configuration.mdx");
    const missing = extractActioConfigKeys().filter((key) => !config.includes(key));

    expect(
      missing,
      `ActioConfig key(s) missing from configuration.mdx: ${missing.join(", ")}. ` +
        "Fix: document each key literally (by name) in docs/content/docs/configuration.mdx.",
    ).toEqual([]);
  });

  it("documents every CLI command in cli.mdx (pins on the supply-chain page)", () => {
    const docCache = new Map<string, string>();
    const docFor = (file: string): string => {
      if (!docCache.has(file)) docCache.set(file, readDoc(file));
      return docCache.get(file) as string;
    };

    const missing = extractCliCommands().filter((command) => {
      const file = commandDocFile[command] ?? "cli.mdx";
      return !docFor(file).includes(command);
    });

    expect(
      missing,
      `CLI command(s) missing from the docs: ${missing.join(", ")}. ` +
        "Fix: document each command in docs/content/docs/cli.mdx (the `pins` command lives in " +
        "docs/content/docs/supply-chain.mdx instead).",
    ).toEqual([]);
  });
});
