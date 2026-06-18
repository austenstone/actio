import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ActioTarget,
  type Diagnostic,
  formatDiagnostic,
  formatGithubAnnotation,
  type NativeDependencies,
  type Pass,
  transpile,
} from "actio-core";
import pc from "picocolors";
import { glob } from "tinyglobby";

export interface BuildOptions {
  outDir: string;
  check: boolean;
  stdout: boolean;
  validate: boolean;
  header: boolean;
  sourceMap: boolean;
  /** Inject the `actio-annotate` runtime failure-mapping job. Requires `sourceMap`. */
  annotate: boolean;
  cwd?: string;
  /** Extra transform passes (from the config file) merged into the built-in pipeline. */
  passes?: Pass[];
  /** Output target capability profile. */
  target: ActioTarget;
  /**
   * Optional override for native dependency resolution (tests inject this to
   * avoid network calls).
   */
  nativeDependencyResolver?: NativeDependencyResolver;
}

const DEFAULT_GLOBS = ["**/*.actio.yml"];
const IGNORE = ["**/node_modules/**", "**/dist/**", "**/.git/**"];
const PINNED_SHA_RE = /^[0-9a-f]{40}$/i;

interface NativeDependencyResolverRequest {
  action: string;
  ref: string;
}

interface NativeDependencyResolver {
  resolveToImmutable(request: NativeDependencyResolverRequest): Promise<string>;
  fetchByImmutable(
    request: NativeDependencyResolverRequest,
    immutableRef: string,
  ): Promise<Uint8Array>;
}

const parseActionRepo = (action: string): { owner: string; repo: string } => {
  const parts = action.split("/");
  if (parts.length < 2) {
    throw new Error(`Invalid action "${action}"`);
  }
  const owner = parts[0];
  const repo = parts[1];
  if (owner === undefined || repo === undefined || owner.length === 0 || repo.length === 0) {
    throw new Error(`Invalid action "${action}"`);
  }
  return { owner, repo };
};

const githubHeaders = (): Record<string, string> => {
  const token = process.env.ACTIO_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "actio-cli/build",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const createGitHubNativeDependencyResolver = (): NativeDependencyResolver => ({
  async resolveToImmutable(request) {
    if (PINNED_SHA_RE.test(request.ref)) return request.ref;
    const { owner, repo } = parseActionRepo(request.action);
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(request.ref)}`,
      { headers: githubHeaders() },
    );
    if (!response.ok) {
      throw new Error(
        `cannot resolve action: ${request.action}@${request.ref} (${response.status} ${response.statusText})`,
      );
    }
    const payload = (await response.json()) as { sha?: string };
    if (!payload.sha || !PINNED_SHA_RE.test(payload.sha)) {
      throw new Error(`GitHub did not return a commit SHA for ${request.action}@${request.ref}`);
    }
    return payload.sha;
  },
  async fetchByImmutable(request, immutableRef) {
    const { owner, repo } = parseActionRepo(request.action);
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/zipball/${immutableRef}`,
      {
        headers: githubHeaders(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `cannot fetch action bytes for ${request.action}@${immutableRef} (${response.status} ${response.statusText})`,
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  },
});

const parseRemoteActionUses = (yaml: string): NativeDependencyResolverRequest[] =>
  yaml.split("\n").flatMap((line) => {
    const match = line.match(
      /^\s*-\s*uses:\s*(?<action>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^\s@#]+)?)@(?<ref>[^\s#]+)(?:\s*#.*)?\s*$/,
    );
    if (!match?.groups) return [];
    const { action, ref } = match.groups;
    if (!action || !ref) return [];
    return [{ action, ref }];
  });

const resolveNativeDependencies = async (
  yaml: string,
  resolver: NativeDependencyResolver,
): Promise<NativeDependencies> => {
  const uses = parseRemoteActionUses(yaml);
  const requestedRefs = new Map<string, string>();
  const dependencies: NativeDependencies = {};

  for (const use of uses) {
    const previousRef = requestedRefs.get(use.action);
    if (previousRef !== undefined && previousRef !== use.ref) {
      throw new Error(
        `native dependencies emission requires a single ref per action; found ${use.action}@${previousRef} and ${use.action}@${use.ref}`,
      );
    }
    requestedRefs.set(use.action, use.ref);
  }

  for (const [action, ref] of [...requestedRefs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const resolvedSha = await resolver.resolveToImmutable({ action, ref });
    const bytes = await resolver.fetchByImmutable({ action, ref }, resolvedSha);
    dependencies[action] = {
      ref,
      sha: resolvedSha,
      integrity: `sha256:${sha256Hex(bytes)}`,
    };
  }

  return dependencies;
};

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

/**
 * Build-time diagnostic annotations should only surface from a real CLI run in
 * CI — never from the test suite, which exercises intentionally-broken fixtures
 * (Vitest sets `VITEST`, so their diagnostics would otherwise leak as real
 * annotations on the run).
 */
export function ciAnnotationsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GITHUB_ACTIONS === "true" && env.VITEST !== "true";
}

export function printDiagnostics(diags: Diagnostic[], source: string): void {
  const ci = ciAnnotationsEnabled();
  for (const d of diags) {
    // In CI, emit a workflow command so the diagnostic highlights inline on the
    // originating .actio.yml source line (schema/syntax errors are the useful ones).
    if (ci) process.stderr.write(`${formatGithubAnnotation(d)}\n`);
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
  let result = transpile(source, {
    fileName: file,
    header: opts.header,
    validate: opts.validate,
    passes: opts.passes,
    sourceMap: opts.sourceMap,
    annotate: opts.annotate,
    target: opts.target,
  });

  if (result.ok && opts.target === "github-actions-native-dependencies-preview") {
    const resolver = opts.nativeDependencyResolver ?? createGitHubNativeDependencyResolver();
    const nativeDependencies = await resolveNativeDependencies(result.yaml, resolver);
    if (Object.keys(nativeDependencies).length > 0) {
      result = transpile(source, {
        fileName: file,
        header: opts.header,
        // TODO(native-deps-schema): re-enable validation once upstream schema includes workflow dependencies.
        validate: false,
        passes: opts.passes,
        sourceMap: opts.sourceMap,
        annotate: opts.annotate,
        target: opts.target,
        // TODO(native-deps-schema): update this payload shape once GitHub finalizes preview docs.
        nativeDependencies,
      });
    }
  }

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
  // GitHub workflows must live flat in one directory, so two sources sharing a
  // basename would silently overwrite each other. Detect and fail loudly instead.
  const collided = new Set<string>();
  if (!opts.stdout) {
    const byOutput = new Map<string, string[]>();
    for (const file of files) {
      const out = outputPathFor(file, opts.outDir);
      const group = byOutput.get(out);
      if (group) group.push(file);
      else byOutput.set(out, [file]);
    }
    for (const [out, group] of byOutput) {
      if (group.length < 2) continue;
      process.stderr.write(
        `${pc.red("error")}: ${group.join(", ")} all map to ${pc.bold(out)}; rename to avoid overwrite\n`,
      );
      for (const f of group) collided.add(f);
    }
  }

  for (const file of files) {
    if (collided.has(file)) {
      results.push({ file, wrote: false, drift: false, errored: true });
      continue;
    }
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
