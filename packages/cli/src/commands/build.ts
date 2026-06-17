import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Diagnostic, type Pass, formatDiagnostic, transpile } from "@actio/core";
import pc from "picocolors";
import { glob } from "tinyglobby";

export interface BuildOptions {
  outDir: string;
  check: boolean;
  stdout: boolean;
  validate: boolean;
  header: boolean;
  sourceMap: boolean;
  cwd?: string;
  /** Extra transform passes (from the config file) merged into the built-in pipeline. */
  passes?: Pass[];
}

const DEFAULT_GLOBS = ["**/*.actio.yml"];
const IGNORE = ["**/node_modules/**", "**/dist/**", "**/.git/**"];

export function outputPathFor(inputFile: string, outDir: string): string {
  const base = path.basename(inputFile).replace(/\.actio\.yml$/, ".yml");
  return path.join(outDir, base);
}

function serializeMap(map: object): string {
  return `${JSON.stringify(map, null, 2)}\n`;
}

export async function discover(patterns: string[], cwd: string): Promise<string[]> {
  const globs = patterns.length > 0 ? patterns : DEFAULT_GLOBS;
  // Allow passing explicit file paths as well as globs.
  const expanded = await glob(globs, { cwd, ignore: IGNORE, dot: false, absolute: false });
  return expanded.sort();
}

export function printDiagnostics(diags: Diagnostic[], source: string): void {
  for (const d of diags) {
    const text = formatDiagnostic(d, source);
    const colored = d.severity === "error" ? colorizeError(text) : pc.yellow(text);
    process.stderr.write(`${colored}\n\n`);
  }
}

function colorizeError(text: string): string {
  return text.replace(/\berror\b/, pc.red("error"));
}

export interface FileResult {
  file: string;
  wrote: boolean;
  drift: boolean;
  errored: boolean;
}

export async function buildOne(file: string, cwd: string, opts: BuildOptions): Promise<FileResult> {
  const abs = path.resolve(cwd, file);
  const source = await readFile(abs, "utf8");
  const result = transpile(source, {
    fileName: file,
    header: opts.header,
    validate: opts.validate,
    passes: opts.passes,
    sourceMap: opts.sourceMap,
  });

  if (result.diagnostics.length > 0) {
    printDiagnostics(result.diagnostics, source);
  }

  if (!result.ok) {
    return { file, wrote: false, drift: false, errored: true };
  }

  if (opts.stdout) {
    process.stdout.write(result.yaml);
    if (!result.yaml.endsWith("\n")) process.stdout.write("\n");
    return { file, wrote: false, drift: false, errored: false };
  }

  const outPath = outputPathFor(file, path.resolve(cwd, opts.outDir));
  const mapPath = `${outPath}.map`;
  const mapText = result.map ? serializeMap(result.map) : null;

  if (opts.check) {
    const existing = existsSync(outPath) ? await readFile(outPath, "utf8") : null;
    let drift = existing !== result.yaml;
    if (!drift && mapText !== null) {
      const existingMap = existsSync(mapPath) ? await readFile(mapPath, "utf8") : null;
      drift = existingMap !== mapText;
    }
    if (drift) {
      process.stderr.write(
        `${pc.yellow("drift")}: ${pc.bold(path.relative(cwd, outPath))} is out of date with ${pc.bold(file)}\n`,
      );
    }
    return { file, wrote: false, drift, errored: false };
  }

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, result.yaml, "utf8");
  if (mapText !== null) await writeFile(mapPath, mapText, "utf8");
  process.stderr.write(`${pc.green("✓")} ${file} ${pc.dim("→")} ${path.relative(cwd, outPath)}\n`);
  return { file, wrote: true, drift: false, errored: false };
}

/** Run the `build` (and `check`) command. Returns a process exit code. */
export async function runBuild(patterns: string[], opts: BuildOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const files = await discover(patterns, cwd);

  if (files.length === 0) {
    process.stderr.write(
      `${pc.yellow("warning")}: no .actio.yml files found${
        patterns.length ? ` for: ${patterns.join(", ")}` : ""
      }\n`,
    );
    return 0;
  }

  const results: FileResult[] = [];
  for (const file of files) {
    try {
      results.push(await buildOne(file, cwd, opts));
    } catch (err) {
      process.stderr.write(`${pc.red("error")}: ${file}: ${(err as Error).message}\n`);
      results.push({ file, wrote: false, drift: false, errored: true });
    }
  }

  const errored = results.filter((r) => r.errored).length;
  const drifted = results.filter((r) => r.drift).length;
  const wrote = results.filter((r) => r.wrote).length;

  if (!opts.stdout) {
    const parts: string[] = [];
    if (wrote) parts.push(`${wrote} written`);
    if (drifted) parts.push(`${drifted} out of date`);
    if (errored) parts.push(`${errored} failed`);
    parts.push(`${results.length} total`);
    process.stderr.write(`\n${pc.bold("Actio")}: ${parts.join(", ")}\n`);
  }

  if (errored > 0) return 1;
  if (opts.check && drifted > 0) return 1;
  return 0;
}
