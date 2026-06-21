import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import pc from "picocolors";
import { discover, outputPathFor } from "./build.js";
import { type ImportLockEntry, readLock, serializeLock, writeLock } from "./lock.js";

export type { ActioLock, ActionLockEntry, ImportLockEntry } from "./lock.js";

export type PinsExitCode = 0 | 1 | 2;

interface ActionUseLine {
  action: string;
  ref: string;
  line: number;
  raw: string;
  prefix: string;
}

interface ImportUseLine {
  spec: string;
  line: number;
  raw: string;
  prefix: string;
  trailingComment: string;
}

interface ParsedImportSpec {
  scheme: "git" | "oci" | "hub";
  host: string;
  owner: string;
  repo: string;
  filePath: string;
  fragment?: string;
  ref: string;
}

type ResolverKind = "action" | "import";

interface ResolverRequest {
  kind: ResolverKind;
  id: string;
  ref: string;
}

export interface PinResolver {
  resolveToImmutable(request: ResolverRequest): Promise<string>;
  fetchByImmutable(request: ResolverRequest, immutableRef: string): Promise<Uint8Array>;
}

export interface ImportResolutionHooks {
  parseImport?: (content: string) => void;
  record?: (entry: ImportLockEntry) => void;
}

interface FileChangeSet {
  path: string;
  after: string;
}

interface SingleBumpDelta {
  version: 1;
  action: string;
  sourceFile: string;
  generatedFile: string;
  lockFile: string;
  fromRef: string;
  toRef: string;
  fromDigest: string;
  toDigest: string;
  sourceEdit: {
    search: string;
    replace: string;
  };
  generatedEdit: {
    search: string;
    replace: string;
  };
}

export interface PinsCheckOptions {
  cwd?: string;
  outDir?: string;
  lockPath?: string;
  resolver?: PinResolver;
}

export interface PinsUpdateOptions extends PinsCheckOptions {
  noExec?: boolean;
  deltaOut?: string;
  runBuild?: (patterns: string[], cwd: string) => Promise<void>;
}

export interface PinsApplyOptions {
  cwd?: string;
  lockPath?: string;
  resolver?: PinResolver;
}

const DEFAULT_OUT_DIR = ".github/workflows";
const DEFAULT_DELTA_PATH = path.join(".actio", "pins-delta.json");
const PINNED_SHA_RE = /^[0-9a-f]{40}$/i;
const parseActionUseLine = (line: string): ActionUseLine | null => {
  const match = line.match(
    /^(?<prefix>\s*-\s*uses:\s*)(?<action>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^\s@#]+)?)@(?<ref>[^\s#]+)(?:\s*#.*)?\s*$/,
  );
  if (!match?.groups) return null;
  const { action, ref, prefix } = match.groups;
  if (!action || !ref || !prefix) return null;
  return {
    action,
    ref,
    prefix,
    line: -1,
    raw: line,
  };
};

const parseImportUseLine = (line: string): ImportUseLine | null => {
  const match = line.match(/^(?<prefix>\s*-\s*import:\s*)(?<spec>[^\s#]+)(?<comment>\s+#.*)?\s*$/);
  if (!match?.groups) return null;
  const { spec, prefix } = match.groups;
  if (!spec || !prefix) return null;
  return {
    spec,
    prefix,
    trailingComment: match.groups.comment ?? "",
    line: -1,
    raw: line,
  };
};

const parseActionUses = (content: string): ActionUseLine[] =>
  content.split("\n").flatMap((line, index) => {
    const parsed = parseActionUseLine(line);
    if (!parsed) return [];
    return [{ ...parsed, line: index }];
  });

const parseImportUses = (content: string): ImportUseLine[] =>
  content.split("\n").flatMap((line, index) => {
    const parsed = parseImportUseLine(line);
    if (!parsed) return [];
    return [{ ...parsed, line: index }];
  });

const normalizeCommentRef = (line: string): string | null => {
  const commentMatch = line.match(/\s+#\s*(?<ref>[^\s#]+)\s*$/);
  return commentMatch?.groups?.ref ?? null;
};

const withTrailingNewline = (text: string, hadTrailingNewline: boolean): string => {
  if (hadTrailingNewline) {
    return text.endsWith("\n") ? text : `${text}\n`;
  }
  return text.endsWith("\n") ? text.slice(0, -1) : text;
};

const replaceLine = (
  content: string,
  line: number,
  newLine: string,
): {
  changed: boolean;
  content: string;
  previous: string;
  next: string;
} => {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  const previous = lines[line] ?? "";
  if (previous === newLine) return { changed: false, content, previous, next: newLine };
  lines[line] = newLine;
  const rebuilt = withTrailingNewline(lines.join("\n"), hadTrailingNewline);
  return { changed: true, content: rebuilt, previous, next: newLine };
};

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const parseImportSpec = (spec: string): ParsedImportSpec => {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    throw new Error(`Invalid import spec "${spec}" (expected @<ref>)`);
  }
  const locator = spec.slice(0, at);
  const ref = spec.slice(at + 1);
  const locatorMatch = locator.match(
    /^(?:(?<scheme>git|oci|hub):\/\/)?(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/(?<path>[^#]+?)(?:#(?<fragment>[^@#]+))?$/,
  );
  if (!locatorMatch?.groups) {
    throw new Error(`Invalid import locator "${locator}"`);
  }
  const { host, owner, repo, path: filePath, fragment } = locatorMatch.groups;
  if (!host || !owner || !repo || !filePath) {
    throw new Error(`Invalid import locator "${locator}"`);
  }
  const scheme = (locatorMatch.groups.scheme ?? "git") as "git" | "oci" | "hub";
  return {
    scheme,
    host,
    owner,
    repo,
    filePath,
    fragment,
    ref,
  };
};

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
    "User-Agent": "actio-cli/pins",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

const isImmutableRef = (ref: string): boolean => PINNED_SHA_RE.test(ref);

export const createGitHubResolver = (): PinResolver => ({
  async resolveToImmutable(request) {
    if (isImmutableRef(request.ref)) return request.ref;
    const { owner, repo } =
      request.kind === "action"
        ? parseActionRepo(request.id)
        : (() => {
            const parsed = parseImportSpec(request.id);
            if (parsed.host !== "github.com") {
              throw new Error(`unsupported import host "${parsed.host}" for ${request.id}`);
            }
            return { owner: parsed.owner, repo: parsed.repo };
          })();
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(request.ref)}`,
      { headers: githubHeaders() },
    );
    if (!response.ok) {
      throw new Error(
        `cannot resolve ${request.kind}: ${request.id}@${request.ref} (${response.status} ${response.statusText})`,
      );
    }
    const payload = (await response.json()) as { sha?: string };
    if (!payload.sha || !isImmutableRef(payload.sha)) {
      throw new Error(`GitHub did not return a commit SHA for ${request.id}@${request.ref}`);
    }
    return payload.sha;
  },

  async fetchByImmutable(request, immutableRef) {
    if (request.kind === "action") {
      const { owner, repo } = parseActionRepo(request.id);
      const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/zipball/${immutableRef}`,
        { headers: githubHeaders() },
      );
      if (!response.ok) {
        throw new Error(
          `cannot fetch action bytes for ${request.id}@${immutableRef} (${response.status} ${response.statusText})`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    }
    const parsed = parseImportSpec(request.id);
    if (parsed.host !== "github.com") {
      throw new Error(`unsupported import host "${parsed.host}" for ${request.id}`);
    }
    const response = await fetch(
      `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${immutableRef}/${parsed.filePath}`,
      { headers: githubHeaders() },
    );
    if (!response.ok) {
      throw new Error(
        `cannot fetch import bytes for ${request.id}@${immutableRef} (${response.status} ${response.statusText})`,
      );
    }
    return new TextEncoder().encode(await response.text());
  },
});

const resolveAndHashAction = async (
  resolver: PinResolver,
  action: string,
  ref: string,
): Promise<{ digest: string; integrity: string }> => {
  const request: ResolverRequest = { kind: "action", id: action, ref };
  const digest = await resolver.resolveToImmutable(request);
  const bytes = await resolver.fetchByImmutable(request, digest);
  return { digest, integrity: `sha256:${sha256Hex(bytes)}` };
};

export const resolveImportToImmutable = async (
  resolver: PinResolver,
  spec: string,
  resolvedAt: string,
  hooks: ImportResolutionHooks = {},
): Promise<ImportLockEntry> => {
  const request: ResolverRequest = { kind: "import", id: spec, ref: parseImportSpec(spec).ref };
  const immutableRef = await resolver.resolveToImmutable(request);
  const bytes = await resolver.fetchByImmutable(request, immutableRef);
  const integrity = `sha256:${sha256Hex(bytes)}`;
  const entry: ImportLockEntry = {
    source: spec,
    immutableRef,
    integrity,
    resolvedAt,
  };
  hooks.record?.(entry);
  hooks.parseImport?.(new TextDecoder().decode(bytes));
  return entry;
};

const verifyIntegrity = async (
  resolver: PinResolver,
  request: ResolverRequest,
  digest: string,
  expectedIntegrity: string,
): Promise<boolean> => {
  const bytes = await resolver.fetchByImmutable(request, digest);
  const actual = `sha256:${sha256Hex(bytes)}`;
  return actual === expectedIntegrity;
};

const resolveSourceFiles = async (patterns: string[], cwd: string): Promise<string[]> =>
  discover(patterns, cwd);

const emitPinnedLine = (prefix: string, action: string, digest: string, ref: string): string =>
  `${prefix}${action}@${digest} # ${ref}`;

const emitImportLine = (prefix: string, spec: string, integrity: string): string =>
  `${prefix}${spec}  # ${integrity}`;

const buildDelta = (args: {
  action: string;
  fromRef: string;
  toRef: string;
  fromDigest: string;
  toDigest: string;
  sourceFile: string;
  generatedFile: string;
  lockFile: string;
  sourceEdit: { search: string; replace: string };
  generatedEdit: { search: string; replace: string };
}): SingleBumpDelta => ({
  version: 1,
  action: args.action,
  fromRef: args.fromRef,
  toRef: args.toRef,
  fromDigest: args.fromDigest,
  toDigest: args.toDigest,
  sourceFile: args.sourceFile,
  generatedFile: args.generatedFile,
  lockFile: args.lockFile,
  sourceEdit: args.sourceEdit,
  generatedEdit: args.generatedEdit,
});

const writeDelta = async (
  cwd: string,
  deltaPath: string,
  delta: SingleBumpDelta,
): Promise<void> => {
  const fullPath = path.resolve(cwd, deltaPath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(delta, null, 2)}\n`, "utf8");
  process.stderr.write(
    `${pc.green("✓")} wrote constrained delta ${path.relative(cwd, fullPath)}\n`,
  );
};

const parseDelta = async (cwd: string, deltaPath: string): Promise<SingleBumpDelta> => {
  const fullPath = path.resolve(cwd, deltaPath);
  const parsed = JSON.parse(await readFile(fullPath, "utf8")) as SingleBumpDelta;
  return parsed;
};

const validateConstrainedDelta = (delta: SingleBumpDelta): string | null => {
  if (delta.version !== 1) return "unsupported delta version";
  if (!delta.action) return "delta action is required";
  if (!delta.sourceFile.endsWith(".actio.yml")) return "sourceFile must point to a .actio.yml file";
  if (!delta.generatedFile.endsWith(".yml"))
    return "generatedFile must point to a generated workflow";
  if (!delta.lockFile.endsWith("actio.lock")) return "lockFile must point to actio.lock";
  if (!PINNED_SHA_RE.test(delta.fromDigest) || !PINNED_SHA_RE.test(delta.toDigest)) {
    return "fromDigest and toDigest must be full commit SHAs";
  }
  const sourceLine = parseActionUseLine(delta.sourceEdit.search);
  const sourceNext = parseActionUseLine(delta.sourceEdit.replace);
  if (!sourceLine || !sourceNext) return "source edit must be a uses: action ref bump";
  if (sourceLine.action !== delta.action || sourceNext.action !== delta.action) {
    return "source edit action must match delta action";
  }
  if (sourceLine.ref !== delta.fromRef || sourceNext.ref !== delta.toRef) {
    return "source edit refs must match delta refs";
  }
  const generatedLine = parseActionUseLine(delta.generatedEdit.search);
  const generatedNext = parseActionUseLine(delta.generatedEdit.replace);
  if (!generatedLine || !generatedNext) return "generated edit must be a uses: digest substitution";
  if (generatedLine.action !== delta.action || generatedNext.action !== delta.action) {
    return "generated edit action must match delta action";
  }
  if (generatedNext.ref !== delta.toDigest) {
    return "generated edit replacement digest must match toDigest";
  }
  if (generatedLine.ref !== delta.fromDigest && generatedLine.ref !== delta.toDigest) {
    return "generated edit search digest must match fromDigest or already-equal toDigest";
  }
  const fromComment = normalizeCommentRef(delta.generatedEdit.search);
  const toComment = normalizeCommentRef(delta.generatedEdit.replace);
  if (toComment !== delta.toRef) {
    return "generated edit replacement comment must match toRef";
  }
  if (fromComment !== delta.fromRef && fromComment !== delta.toRef) {
    return "generated edit search comment must match fromRef or already-equal toRef";
  }
  return null;
};

const replaceExactlyOnce = (
  content: string,
  search: string,
  replacement: string,
): { ok: boolean; content: string } => {
  const first = content.indexOf(search);
  if (first < 0) return { ok: false, content };
  const second = content.indexOf(search, first + search.length);
  if (second >= 0) return { ok: false, content };
  return {
    ok: true,
    content: `${content.slice(0, first)}${replacement}${content.slice(first + search.length)}`,
  };
};

const updateSingleFile = async (
  cwd: string,
  relativePath: string,
  search: string,
  replacement: string,
): Promise<boolean> => {
  if (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
    return false;
  }
  const full = path.resolve(cwd, relativePath);
  const relative = path.relative(cwd, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const current = await readFile(full, "utf8");
  const next = replaceExactlyOnce(current, search, replacement);
  if (!next.ok) return false;
  await writeFile(full, next.content, "utf8");
  return true;
};

export const runPinsCheck = async (
  patterns: string[],
  options: PinsCheckOptions = {},
): Promise<PinsExitCode> => {
  const cwd = options.cwd ?? process.cwd();
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const resolver = options.resolver ?? createGitHubResolver();
  const lock = await readLock(cwd, options.lockPath);
  const files = await resolveSourceFiles(patterns, cwd);
  let hasResolvableDrift = false;

  for (const file of files) {
    const sourcePath = path.resolve(cwd, file);
    const generatedPath = outputPathFor(file, path.resolve(cwd, outDir));
    const source = await readFile(sourcePath, "utf8");
    const sourceUses = parseActionUses(source);
    const generated = existsSync(generatedPath) ? await readFile(generatedPath, "utf8") : "";
    const generatedUses = parseActionUses(generated);
    const generatedByAction = new Map(generatedUses.map((entry) => [entry.action, entry]));

    for (const entry of sourceUses) {
      const lockEntry = lock.data.actions[entry.action];
      if (lockEntry) {
        const lockRequest: ResolverRequest = {
          kind: "action",
          id: entry.action,
          ref: lockEntry.digest,
        };
        const valid = await verifyIntegrity(
          resolver,
          lockRequest,
          lockEntry.digest,
          lockEntry.integrity,
        );
        if (!valid) {
          process.stderr.write(
            `${pc.red("error")}: integrity mismatch for ${entry.action} (${lockEntry.digest})\n`,
          );
          return 2;
        }
      }

      const resolved = await resolveAndHashAction(resolver, entry.action, entry.ref);
      const generatedEntry = generatedByAction.get(entry.action);
      if (!generatedEntry) {
        hasResolvableDrift = true;
        continue;
      }
      const generatedComment = normalizeCommentRef(generatedEntry.raw);
      if (generatedEntry.ref !== resolved.digest || generatedComment !== entry.ref) {
        hasResolvableDrift = true;
      }
      if (
        !lockEntry ||
        lockEntry.digest !== resolved.digest ||
        lockEntry.sourceRef !== entry.ref ||
        lockEntry.integrity !== resolved.integrity
      ) {
        hasResolvableDrift = true;
      }
    }

    const imports = parseImportUses(source);
    for (const importLine of imports) {
      const parsedSpec = parseImportSpec(importLine.spec);
      if (parsedSpec.scheme !== "git") {
        process.stderr.write(
          `${pc.red("error")}: ${parsedSpec.scheme}:// imports are reserved and not implemented\n`,
        );
        return 2;
      }
      const integrityMatch = importLine.trailingComment.match(/sha256:[0-9a-f]{64}/i);
      if (!integrityMatch) {
        hasResolvableDrift = true;
        continue;
      }
      const expectedIntegrity = integrityMatch[0];
      const request: ResolverRequest = { kind: "import", id: importLine.spec, ref: parsedSpec.ref };
      const immutableRef = await resolver.resolveToImmutable(request);
      const bytes = await resolver.fetchByImmutable(request, immutableRef);
      const computed = `sha256:${sha256Hex(bytes)}`;
      if (computed !== expectedIntegrity) {
        process.stderr.write(
          `${pc.red("error")}: integrity mismatch for import ${importLine.spec} (expected ${expectedIntegrity}, got ${computed})\n`,
        );
        return 2;
      }
      const lockEntry = lock.data.imports[importLine.spec];
      if (
        !lockEntry ||
        lockEntry.immutableRef !== immutableRef ||
        lockEntry.integrity !== computed
      ) {
        hasResolvableDrift = true;
      }
    }
  }

  return hasResolvableDrift ? 1 : 0;
};

export const runPinsUpdate = async (
  patterns: string[],
  options: PinsUpdateOptions = {},
): Promise<PinsExitCode> => {
  const cwd = options.cwd ?? process.cwd();
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;
  const resolver = options.resolver ?? createGitHubResolver();
  const files = await resolveSourceFiles(patterns, cwd);
  if (files.length === 0) {
    process.stderr.write(
      `${pc.yellow("warning")}: no .actio.yml files found${
        patterns.length ? ` for: ${patterns.join(", ")}` : ""
      }\n`,
    );
    return 0;
  }
  const lock = await readLock(cwd, options.lockPath);
  const lockBefore = serializeLock(lock);
  const nowIso = new Date().toISOString();
  const sourceChanges: FileChangeSet[] = [];
  const generatedChanges: FileChangeSet[] = [];
  let singleBumpDelta: SingleBumpDelta | null = null;
  let bumpCount = 0;

  for (const file of files) {
    const sourcePath = path.resolve(cwd, file);
    const generatedPath = outputPathFor(file, path.resolve(cwd, outDir));
    const source = await readFile(sourcePath, "utf8");
    let nextSource = source;
    const sourceUses = parseActionUses(source);
    const generated = existsSync(generatedPath) ? await readFile(generatedPath, "utf8") : "";
    let nextGenerated = generated;
    const generatedUses = parseActionUses(generated);
    const generatedByAction = new Map(generatedUses.map((entry) => [entry.action, entry]));

    for (const entry of sourceUses) {
      const oldLock = lock.data.actions[entry.action];
      if (oldLock) {
        const valid = await verifyIntegrity(
          resolver,
          { kind: "action", id: entry.action, ref: oldLock.digest },
          oldLock.digest,
          oldLock.integrity,
        );
        if (!valid) {
          process.stderr.write(
            `${pc.red("error")}: integrity mismatch for ${entry.action} (${oldLock.digest}); refusing to update\n`,
          );
          return 2;
        }
      }

      const generatedEntry = generatedByAction.get(entry.action);
      const targetRef = entry.ref;
      const resolved = await resolveAndHashAction(resolver, entry.action, targetRef);
      const actionChanged =
        !oldLock ||
        oldLock.digest !== resolved.digest ||
        oldLock.sourceRef !== targetRef ||
        oldLock.integrity !== resolved.integrity;
      if (actionChanged) {
        lock.data.actions[entry.action] = {
          ...oldLock,
          action: entry.action,
          sourceRef: targetRef,
          digest: resolved.digest,
          integrity: resolved.integrity,
          resolvedAt: nowIso,
        };
      }

      if (generatedEntry) {
        const pinnedGenerated = emitPinnedLine(
          generatedEntry.prefix,
          entry.action,
          resolved.digest,
          targetRef,
        );
        const generatedEdit = replaceLine(nextGenerated, generatedEntry.line, pinnedGenerated);
        nextGenerated = generatedEdit.content;

        if (
          actionChanged &&
          oldLock &&
          oldLock.sourceRef !== targetRef &&
          bumpCount === 0 &&
          PINNED_SHA_RE.test(generatedEntry.ref)
        ) {
          bumpCount += 1;
          singleBumpDelta = buildDelta({
            action: entry.action,
            fromRef: oldLock.sourceRef,
            toRef: targetRef,
            fromDigest: oldLock.digest,
            toDigest: resolved.digest,
            sourceFile: file,
            generatedFile: path.relative(cwd, generatedPath),
            lockFile: path.relative(cwd, lock.path),
            sourceEdit: {
              search: `${entry.prefix}${entry.action}@${oldLock.sourceRef}`,
              replace: `${entry.prefix}${entry.action}@${targetRef}`,
            },
            generatedEdit: {
              search: emitPinnedLine(
                generatedEntry.prefix,
                entry.action,
                oldLock.digest,
                oldLock.sourceRef,
              ),
              replace: emitPinnedLine(
                generatedEntry.prefix,
                entry.action,
                resolved.digest,
                targetRef,
              ),
            },
          });
        } else if (actionChanged && oldLock && oldLock.sourceRef !== targetRef) {
          bumpCount += 1;
          singleBumpDelta = null;
        }
      } else if (actionChanged && oldLock && oldLock.sourceRef !== targetRef) {
        bumpCount += 1;
        singleBumpDelta = null;
      }
    }

    const imports = parseImportUses(nextSource);
    for (const importLine of imports) {
      const parsed = parseImportSpec(importLine.spec);
      if (parsed.scheme !== "git") {
        process.stderr.write(
          `${pc.red("error")}: ${parsed.scheme}:// imports are reserved and not implemented\n`,
        );
        return 2;
      }
      const entry = await resolveImportToImmutable(resolver, importLine.spec, nowIso, {
        parseImport: () => undefined,
      });
      const existingPinned = importLine.trailingComment.match(/sha256:[0-9a-f]{64}/i)?.[0];
      if (existingPinned && existingPinned !== entry.integrity) {
        process.stderr.write(
          `${pc.red("error")}: integrity mismatch for import ${importLine.spec}; refusing to update\n`,
        );
        return 2;
      }
      const existingLock = lock.data.imports[importLine.spec];
      const importChanged =
        !existingLock ||
        existingLock.source !== entry.source ||
        existingLock.immutableRef !== entry.immutableRef ||
        existingLock.integrity !== entry.integrity;
      if (importChanged) {
        lock.data.imports[importLine.spec] = existingLock ? { ...existingLock, ...entry } : entry;
      }
      if (existingPinned !== entry.integrity) {
        const replacement = emitImportLine(importLine.prefix, importLine.spec, entry.integrity);
        const sourceEdit = replaceLine(nextSource, importLine.line, replacement);
        nextSource = sourceEdit.content;
      }
    }

    if (nextSource !== source) {
      sourceChanges.push({ path: sourcePath, after: nextSource });
    }
    if (nextGenerated !== generated) {
      generatedChanges.push({ path: generatedPath, after: nextGenerated });
    }
  }

  for (const change of sourceChanges) {
    await writeFile(change.path, change.after, "utf8");
  }
  for (const change of generatedChanges) {
    await mkdir(path.dirname(change.path), { recursive: true });
    await writeFile(change.path, change.after, "utf8");
  }
  const lockAfter = serializeLock(lock);
  const lockChanged = lockBefore !== lockAfter;
  if (lockChanged) {
    await writeLock(lock);
  }

  if (singleBumpDelta && bumpCount === 1) {
    await writeDelta(cwd, options.deltaOut ?? DEFAULT_DELTA_PATH, singleBumpDelta);
  }

  if (!options.noExec) {
    await options.runBuild?.(patterns, cwd);
  }

  if (!lockChanged && sourceChanges.length === 0 && generatedChanges.length === 0) {
    process.stderr.write(`${pc.bold("pins")}: no changes\n`);
  } else {
    const updated = [`${sourceChanges.length} source`, `${generatedChanges.length} generated`];
    if (lockChanged) updated.push("lockfile");
    process.stderr.write(`${pc.bold("pins")}: updated ${updated.join(", ")}\n`);
  }
  return 0;
};

export const runPinsApplyConstrained = async (
  deltaFile: string,
  options: PinsApplyOptions = {},
): Promise<PinsExitCode> => {
  const cwd = options.cwd ?? process.cwd();
  const resolver = options.resolver ?? createGitHubResolver();
  try {
    const delta = await parseDelta(cwd, deltaFile);
    const deltaError = validateConstrainedDelta(delta);
    if (deltaError) {
      process.stderr.write(`${pc.red("error")}: constrained delta rejected: ${deltaError}\n`);
      return 2;
    }

    const sourceApplied = await updateSingleFile(
      cwd,
      delta.sourceFile,
      delta.sourceEdit.search,
      delta.sourceEdit.replace,
    );
    if (!sourceApplied) {
      process.stderr.write(`${pc.red("error")}: constrained apply rejected source change shape\n`);
      return 2;
    }

    const generatedApplied = await updateSingleFile(
      cwd,
      delta.generatedFile,
      delta.generatedEdit.search,
      delta.generatedEdit.replace,
    );
    if (!generatedApplied) {
      process.stderr.write(
        `${pc.red("error")}: constrained apply rejected generated change shape\n`,
      );
      return 2;
    }

    const lock = await readLock(cwd, options.lockPath ?? delta.lockFile);
    const actionEntry = lock.data.actions[delta.action];
    if (
      !actionEntry ||
      actionEntry.digest !== delta.fromDigest ||
      actionEntry.sourceRef !== delta.fromRef
    ) {
      process.stderr.write(
        `${pc.red("error")}: constrained apply rejected lockfile state for ${delta.action}\n`,
      );
      return 2;
    }
    const request: ResolverRequest = { kind: "action", id: delta.action, ref: delta.toRef };
    const immutable = await resolver.resolveToImmutable(request);
    if (immutable !== delta.toDigest) {
      process.stderr.write(
        `${pc.red("error")}: constrained apply rejected digest mismatch for ${delta.action} (${delta.toRef} resolved to ${immutable})\n`,
      );
      return 2;
    }
    const bytes = await resolver.fetchByImmutable(request, immutable);
    actionEntry.digest = immutable;
    actionEntry.sourceRef = delta.toRef;
    actionEntry.integrity = `sha256:${sha256Hex(bytes)}`;
    actionEntry.resolvedAt = new Date().toISOString();
    await writeLock(lock);

    process.stderr.write(`${pc.green("✓")} constrained pin delta applied\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${pc.red("error")}: constrained apply failed: ${message}\n`);
    return 2;
  }
};
