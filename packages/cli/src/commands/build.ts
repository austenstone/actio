import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type ActioTarget,
  type CoercionMode,
  type Diagnostic,
  formatDiagnostic,
  formatGithubAnnotation,
  type LintMode,
  type NativeDependencies,
  type Pass,
  type PinPolicy,
  type PinResolution,
  type PinTarget,
  transpile,
} from "actio-core";
import pc from "picocolors";
import { glob } from "tinyglobby";
import { type LockState, type PinCacheEntry, readLock, writeLock } from "./lock.js";

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
  /** Severity for dead-code diagnostics on unused params/fragments/executors. Default "warn". */
  unusedSymbols?: "off" | "warn" | "error";
  /** Opt-in strict YAML 1.2.2 lint flagging `<<` merge keys in source. Default false. */
  strict?: boolean;
  /** Inline `artifacts:` macro config; `uploader` is the upload action ref to emit. */
  artifacts?: { uploader?: string };
  /** YAML type-coercion guard mode (`off | warn | fix`). Default `fix`. */
  coercion: CoercionMode;
  /** actionlint output-lint severity (`off | warn | error`). Default `off`. */
  lint: LintMode;
  /**
   * Optional override for native dependency resolution (tests inject this to
   * avoid network calls).
   */
  nativeDependencyResolver?: NativeDependencyResolver;
  /**
   * Optional override for remote import integrity resolution (tests inject this
   * to avoid network calls).
   */
  importIntegrityResolver?: ImportIntegrityResolver;
  /**
   * Resolved pin policy. When `enabled`, tag/branch `uses:` refs are rewritten
   * to their immutable sha/digest at build time. Absent means pinning is off.
   */
  pin?: PinPolicy;
  /** Resolve pins from the lock only; error (exit 2) on a cache miss. */
  offline?: boolean;
  /** Injectable digest resolver (tests provide this to avoid network calls). */
  pinResolver?: PinRefResolver;
  /** Lockfile path for the pin cache (defaults to `actio.lock`). */
  lockPath?: string;
}

const DEFAULT_GLOBS = ["**/*.actio.yml"];
const IGNORE = ["**/node_modules/**", "**/dist/**", "**/.git/**"];
// When no patterns are given we recurse the whole tree, so also skip test and
// fixture trees: they commonly hold many `input.actio.yml` files that all
// flatten to `input.yml` and collide. An explicit pattern opts back in.
const DEFAULT_IGNORE = [
  ...IGNORE,
  "**/tests/**",
  "**/test/**",
  "**/__tests__/**",
  "**/fixtures/**",
];

const PINNED_SHA_RE = /^[0-9a-f]{40}$/i;
const DOCKER_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;
const IMPORT_INTEGRITY_RE = /sha256:[0-9a-f]{64}/i;

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

interface ImportIntegrityResolverRequest {
  spec: string;
  ref: string;
}

interface ParsedImportSpec {
  scheme: "git" | "oci" | "hub";
  host: string;
  owner: string;
  repo: string;
  filePath: string;
  ref: string;
}

interface ImportIntegrityResolver {
  resolveToImmutable(request: ImportIntegrityResolverRequest): Promise<string>;
  fetchByImmutable(
    request: ImportIntegrityResolverRequest,
    immutableRef: string,
  ): Promise<Uint8Array>;
}

class ImportIntegrityMismatchError extends Error {
  constructor(
    readonly spec: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`integrity mismatch for import ${spec} (expected ${expected}, got ${actual})`);
    this.name = "ImportIntegrityMismatchError";
  }
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
  const { host, owner, repo, path: filePath } = locatorMatch.groups;
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
    ref,
  };
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

const createGitHubImportIntegrityResolver = (): ImportIntegrityResolver => ({
  async resolveToImmutable(request) {
    if (PINNED_SHA_RE.test(request.ref)) return request.ref;
    const parsed = parseImportSpec(request.spec);
    if (parsed.host !== "github.com") {
      throw new Error(`unsupported import host "${parsed.host}" for ${request.spec}`);
    }
    const response = await fetch(
      `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/commits/${encodeURIComponent(request.ref)}`,
      { headers: githubHeaders() },
    );
    if (!response.ok) {
      throw new Error(
        `cannot resolve import: ${request.spec}@${request.ref} (${response.status} ${response.statusText})`,
      );
    }
    const payload = (await response.json()) as { sha?: string };
    if (!payload.sha || !PINNED_SHA_RE.test(payload.sha)) {
      throw new Error(`GitHub did not return a commit SHA for ${request.spec}@${request.ref}`);
    }
    return payload.sha;
  },
  async fetchByImmutable(request, immutableRef) {
    const parsed = parseImportSpec(request.spec);
    if (parsed.host !== "github.com") {
      throw new Error(`unsupported import host "${parsed.host}" for ${request.spec}`);
    }
    const response = await fetch(
      `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/${immutableRef}/${parsed.filePath}`,
      {
        headers: githubHeaders(),
      },
    );
    if (!response.ok) {
      throw new Error(
        `cannot fetch import bytes for ${request.spec}@${immutableRef} (${response.status} ${response.statusText})`,
      );
    }
    return new TextEncoder().encode(await response.text());
  },
});

interface PinRefResolver {
  /** Resolve a pinnable target to its immutable digest (40-hex sha / `sha256:…`). */
  resolve(target: PinTarget): Promise<string>;
}

class PinUnresolvedError extends Error {
  constructor(readonly keys: string[]) {
    super(`cannot pin offline; lock is missing entries for: ${keys.join(", ")}`);
    this.name = "PinUnresolvedError";
  }
}

/**
 * A docker image lives on a registry we structurally cannot auto-resolve — i.e. a
 * host other than Docker Hub (ghcr.io, private/internal). Per #96 this is the only
 * skip-with-warning case: the image is left on its tag and the build still exits 0.
 *
 * Every other failure is a real failure and throws a plain Error so it propagates
 * and hard-fails (exit 1): auth/manifest/missing-digest HTTP errors on a registry
 * we DO support (401/403/404/429/5xx), connection/TLS blips (already a bare fetch
 * rejection), and a *malformed* digest from a registry that responded. Narrowing
 * to the structural case keeps a Docker Hub 429 from silently shipping unpinned and
 * restores symmetry with the connection-error path, which has always failed closed.
 */
export class DockerRegistryUnresolvableError extends Error {
  constructor(
    readonly target: string,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "DockerRegistryUnresolvableError";
  }
}

const pinUnresolvableWarning = (target: PinTarget, reason: string, file?: string): Diagnostic => ({
  severity: "warning",
  source: "actio",
  code: "pin-unresolvable-registry",
  message: `left ${target.key} unpinned: ${reason}`,
  file,
  range: target.range,
});

const DOCKER_MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// Only Docker Hub is auto-resolvable. A registry host (dot/port in the first path
// segment) is structurally out of scope and is skip-with-warning; every failure on
// Docker Hub itself (auth/manifest/missing/malformed digest) is a hard error so a
// transient 429 can never silently ship the image unpinned.
export const resolveDockerDigest = async (id: string, ref: string): Promise<string> => {
  const firstSegment = id.split("/")[0] ?? "";
  if (firstSegment.includes(".") || firstSegment.includes(":")) {
    throw new DockerRegistryUnresolvableError(
      `docker://${id}:${ref}`,
      `unsupported docker registry "${firstSegment}"; only Docker Hub auto-resolves, so pin the digest manually`,
    );
  }
  const repo = id.includes("/") ? id : `library/${id}`;
  const tokenResponse = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`,
  );
  if (!tokenResponse.ok) {
    throw new Error(`cannot authenticate to Docker Hub for ${id} (${tokenResponse.status})`);
  }
  const { token } = (await tokenResponse.json()) as { token?: string };
  const manifestResponse = await fetch(
    `https://registry-1.docker.io/v2/${repo}/manifests/${encodeURIComponent(ref)}`,
    {
      headers: {
        Accept: DOCKER_MANIFEST_ACCEPT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    },
  );
  if (!manifestResponse.ok) {
    throw new Error(
      `cannot resolve docker digest for ${id}:${ref} (${manifestResponse.status} ${manifestResponse.statusText})`,
    );
  }
  const digest = manifestResponse.headers.get("docker-content-digest");
  if (!digest) {
    throw new Error(`Docker Hub returned no digest for ${id}:${ref}`);
  }
  // The header is used verbatim in `uses:`; reject a malformed digest rather than emit a bad pin.
  // This is corruption from a registry that DID respond — a hard error, not a skip-with-warning.
  if (!DOCKER_DIGEST_RE.test(digest)) {
    throw new Error(`Docker Hub returned a malformed digest for ${id}:${ref}: ${digest}`);
  }
  return digest;
};

const createGitHubPinResolver = (): PinRefResolver => ({
  async resolve(target) {
    if (target.kind === "docker") return resolveDockerDigest(target.id, target.ref);
    const { owner, repo } = parseActionRepo(target.id);
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(target.ref)}`,
      { headers: githubHeaders() },
    );
    if (!response.ok) {
      throw new Error(
        `cannot resolve action: ${target.id}@${target.ref} (${response.status} ${response.statusText})`,
      );
    }
    const payload = (await response.json()) as { sha?: string };
    if (!payload.sha || !PINNED_SHA_RE.test(payload.sha)) {
      throw new Error(`GitHub did not return a commit SHA for ${target.id}@${target.ref}`);
    }
    return payload.sha;
  },
});

const pinResolutionsFromLock = (lock: LockState): Record<string, PinResolution> => {
  const cache = lock.data.pins ?? {};
  const resolutions: Record<string, PinResolution> = {};
  for (const [key, entry] of Object.entries(cache)) {
    // The lock is the trust anchor: a corrupt or hand-edited digest would be concatenated
    // straight into `uses:` as a *wrong* pin (worse than no pin), so reject by kind instead
    // of substituting blind — docker keys carry a `sha256:` digest, action keys a 40-hex SHA.
    const expected = key.startsWith("docker://") ? DOCKER_DIGEST_RE : PINNED_SHA_RE;
    if (!expected.test(entry.digest)) {
      throw new Error(`corrupt pin in ${lock.path}: ${key} → ${entry.digest}`);
    }
    resolutions[key] = { digest: entry.digest, resolvedAt: entry.resolvedAt };
  }
  return resolutions;
};

type TranspileResult = ReturnType<typeof transpile>;

/**
 * Two-pass pin resolution: transpile with the lock's known digests, discover any
 * still-unresolved targets, fetch them (unless offline/check), persist the cache,
 * and re-transpile so every pinnable `uses:` lands on its digest.
 */
const pinBuild = async (
  source: string,
  baseOptions: Parameters<typeof transpile>[1],
  policy: PinPolicy,
  opts: BuildOptions,
  cwd: string,
): Promise<TranspileResult> => {
  const lock = await readLock(cwd, opts.lockPath);
  const resolutions = pinResolutionsFromLock(lock);
  const result = transpile(source, { ...baseOptions, pin: { policy, resolutions } });
  if (!result.ok) return result;

  const unresolved = (result.pinTargets ?? []).filter((t) => !resolutions[t.key]);
  if (unresolved.length === 0) return result;

  // check mode never reaches the network: an unresolved target simply means the
  // committed output/lock is stale, which the drift compare reports.
  if (opts.check) return result;
  if (opts.offline) throw new PinUnresolvedError(unresolved.map((t) => t.key));

  const resolver = opts.pinResolver ?? createGitHubPinResolver();
  const resolvedAt = new Date().toISOString();
  const pins: Record<string, PinCacheEntry> = { ...(lock.data.pins ?? {}) };
  const warnings: Diagnostic[] = [];
  let resolvedAny = false;
  for (const target of unresolved) {
    let digest: string;
    try {
      digest = await resolver.resolve(target);
    } catch (err) {
      // Austen's call (#96), narrowed: skip-with-warning applies ONLY to a structurally
      // unsupported registry (non-Docker-Hub, private, ghcr.io) — that's the typed
      // DockerRegistryUnresolvableError. Every other failure (auth/manifest/missing/
      // malformed digest or a 429/5xx on Docker Hub, connection blips, and all action-ref
      // failures) throws a plain Error and propagates so it hard-fails: a registry we
      // support failing to resolve must never silently ship the image unpinned.
      if (err instanceof DockerRegistryUnresolvableError) {
        warnings.push(pinUnresolvableWarning(target, err.reason, baseOptions?.fileName));
        continue;
      }
      throw err;
    }
    resolutions[target.key] = { digest, resolvedAt };
    pins[target.key] = { ref: target.ref, digest, resolvedAt };
    resolvedAny = true;
  }
  if (!resolvedAny) {
    result.diagnostics.push(...warnings);
    return result;
  }
  lock.data.pins = pins;
  await writeLock(lock);
  const final = transpile(source, { ...baseOptions, pin: { policy, resolutions } });
  final.diagnostics.push(...warnings);
  return final;
};

const parseImportUseLine = (line: string): { spec: string; trailingComment: string } | null => {
  const match = line.match(/^\s*-\s*import:\s*(?<spec>[^\s#]+)(?<comment>\s+#.*)?\s*$/);
  if (!match?.groups?.spec) return null;
  return {
    spec: match.groups.spec,
    trailingComment: match.groups.comment ?? "",
  };
};

const verifyRemoteImportIntegrities = async (
  source: string,
  resolver: ImportIntegrityResolver,
): Promise<void> => {
  for (const line of source.split("\n")) {
    const parsedLine = parseImportUseLine(line);
    if (!parsedLine) continue;
    const expectedIntegrity = parsedLine.trailingComment.match(IMPORT_INTEGRITY_RE)?.[0];
    if (!expectedIntegrity) continue;
    const parsedSpec = parseImportSpec(parsedLine.spec);
    if (parsedSpec.scheme !== "git") continue;
    const request: ImportIntegrityResolverRequest = {
      spec: parsedLine.spec,
      ref: parsedSpec.ref,
    };
    const immutableRef = await resolver.resolveToImmutable(request);
    const bytes = await resolver.fetchByImmutable(request, immutableRef);
    const computed = `sha256:${sha256Hex(bytes)}`;
    if (computed !== expectedIntegrity) {
      throw new ImportIntegrityMismatchError(parsedLine.spec, expectedIntegrity, computed);
    }
  }
};

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
  const explicit = patterns.length > 0;
  const globs = explicit ? patterns : DEFAULT_GLOBS;
  // Allow passing explicit file paths as well as globs. A bare `actio build`
  // also skips test/fixture trees to avoid flatten-collisions (DEFAULT_IGNORE).
  const ignore = explicit ? IGNORE : DEFAULT_IGNORE;
  const expanded = await glob(globs, { cwd, ignore, dot: false, absolute: false });
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
    const colored =
      d.severity === "error"
        ? colorizeError(text)
        : d.severity === "warning"
          ? pc.yellow(text)
          : pc.cyan(text);
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
  const importIntegrityResolver =
    opts.importIntegrityResolver ?? createGitHubImportIntegrityResolver();
  await verifyRemoteImportIntegrities(source, importIntegrityResolver);
  const baseOptions = {
    fileName: file,
    header: opts.header,
    validate: opts.validate,
    passes: opts.passes,
    sourceMap: opts.sourceMap,
    annotate: opts.annotate,
    target: opts.target,
    unusedSymbols: opts.unusedSymbols,
    strict: opts.strict,
    artifacts: opts.artifacts,
    coercion: opts.coercion,
    lint: opts.lint,
  };
  let result = transpile(source, baseOptions);

  if (result.ok && opts.target === "github-actions-native-dependencies-preview") {
    const resolver = opts.nativeDependencyResolver ?? createGitHubNativeDependencyResolver();
    const nativeDependencies = await resolveNativeDependencies(result.yaml, resolver);
    if (Object.keys(nativeDependencies).length > 0) {
      result = transpile(source, {
        ...baseOptions,
        // TODO(native-deps-schema): re-enable validation once upstream schema includes workflow dependencies.
        validate: false,
        // actionlint doesn't understand the preview `dependencies:` lockfile; skip it here too.
        lint: "off",
        // TODO(native-deps-schema): update this payload shape once GitHub finalizes preview docs.
        nativeDependencies,
      });
    }
    // `else if`: the native-deps preview target emits its own top-level `dependencies:`
    // lockfile, which supersedes uses:-level pinning — so pinning is intentionally skipped there.
  } else if (result.ok && opts.pin?.enabled) {
    result = await pinBuild(source, baseOptions, opts.pin, opts, cwd);
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
      if (err instanceof ImportIntegrityMismatchError) return 2;
      if (err instanceof PinUnresolvedError) return 2;
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
