import { Scalar } from "yaml";
import type { Range } from "../diagnostics.js";
import { visitJobs, visitSteps } from "../ir.js";
import { type ParseContext, type Path, rangeOfPath } from "../parser.js";

/** Trailing-comment style for a pinned ref. */
export type PinCommentStyle = "tag" | "tag+date" | "none";

/** Resolved pin policy after config + flag merge (every field concrete). */
export interface PinPolicy {
  enabled: boolean;
  thirdParty: boolean;
  github: boolean;
  docker: boolean;
  allow: string[];
  comment: PinCommentStyle;
}

/** A resolved immutable reference, cached in the lockfile. */
export interface PinResolution {
  /** 40-hex commit sha for actions, `sha256:…` digest for docker images. */
  digest: string;
  /** ISO timestamp of resolution; drives the `tag+date` comment deterministically. */
  resolvedAt?: string;
}

/** A pinnable `uses:` reference discovered in the workflow. */
export interface PinTarget {
  /** Canonical cache key: `owner/repo@ref` or `docker://image:tag`. */
  key: string;
  kind: "action" | "docker";
  /** `owner/repo[/path]` for actions, `image` for docker. */
  id: string;
  /** The mutable ref/tag being pinned. */
  ref: string;
  /** Action owner (`actions`, `github`, …); undefined for docker. */
  owner?: string;
  /** Source range of the `uses:` node, for diagnostics that point back at it. */
  range?: Range;
}

export interface PinOptions {
  policy: PinPolicy;
  /** Known resolutions keyed by canonical ref; unresolved targets are surfaced, not rewritten. */
  resolutions?: Record<string, PinResolution>;
}

const SHA_RE = /^[0-9a-f]{40}$/i;
const DOCKER_PREFIX = "docker://";

/**
 * Classify a `uses:` literal into a pinnable target, or null when it is local,
 * untagged, or already immutable (a 40-hex sha / `@sha256:` digest). Returning
 * null on immutable refs is what makes re-pinning a no-op.
 */
export function parseUsesRef(uses: string): PinTarget | null {
  if (uses.startsWith(DOCKER_PREFIX)) {
    const rest = uses.slice(DOCKER_PREFIX.length);
    if (rest.includes("@sha256:")) return null;
    const lastSlash = rest.lastIndexOf("/");
    const colon = rest.indexOf(":", lastSlash + 1);
    if (colon === -1) return null;
    const id = rest.slice(0, colon);
    const ref = rest.slice(colon + 1);
    if (!id || !ref) return null;
    return { key: `${DOCKER_PREFIX}${id}:${ref}`, kind: "docker", id, ref };
  }
  if (uses.startsWith("./") || uses.startsWith("../")) return null;
  const at = uses.lastIndexOf("@");
  if (at === -1) return null;
  const id = uses.slice(0, at);
  const ref = uses.slice(at + 1);
  if (!id.includes("/") || !ref || SHA_RE.test(ref)) return null;
  const owner = id.slice(0, id.indexOf("/"));
  return { key: `${id}@${ref}`, kind: "action", id, ref, owner };
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

function matchesAllow(allow: string[], target: PinTarget): boolean {
  return allow.some((glob) => {
    const re = globToRegExp(glob);
    return re.test(target.id) || re.test(target.key);
  });
}

/**
 * Policy gate: should this target be pinned? Shared with the CLI so the build
 * layer resolves exactly the refs the pass will rewrite.
 */
export function shouldPinTarget(target: PinTarget, policy: PinPolicy): boolean {
  if (!policy.enabled) return false;
  if (matchesAllow(policy.allow, target)) return false;
  if (target.kind === "docker") return policy.docker;
  const firstParty = target.owner === "actions" || target.owner === "github";
  return firstParty ? policy.github : policy.thirdParty;
}

/** Leading-space comment text (so YAML renders `# tag`); empty when style is "none". */
export function pinCommentText(ref: string, style: PinCommentStyle, resolvedAt?: string): string {
  if (style === "none") return "";
  if (style === "tag+date" && resolvedAt) return ` ${ref} (${resolvedAt.slice(0, 10)})`;
  return ` ${ref}`;
}

function pinnedRef(target: PinTarget, digest: string): string {
  return target.kind === "docker"
    ? `${DOCKER_PREFIX}${target.id}@${digest}`
    : `${target.id}@${digest}`;
}

/**
 * Rewrite pinnable `uses:` literals (step- and job-level) to their resolved
 * digest, attaching the original tag as a trailing comment. Targets without a
 * known resolution are collected and returned so the caller can resolve them and
 * re-run. Returns the deduped set of pinnable targets seen.
 */
export function applyPins(ctx: ParseContext, options: PinOptions): PinTarget[] {
  const targets: PinTarget[] = [];
  const seen = new Set<string>();
  const resolutions = options.resolutions ?? {};

  const handle = (container: { uses?: unknown }, path: Path): void => {
    const uses = container.uses;
    if (typeof uses !== "string") return;
    const target = parseUsesRef(uses);
    if (!target || !shouldPinTarget(target, options.policy)) return;
    if (!seen.has(target.key)) {
      seen.add(target.key);
      target.range = rangeOfPath(ctx, [...path, "uses"]);
      targets.push(target);
    }
    const resolution = resolutions[target.key];
    if (!resolution) return;
    const scalar = new Scalar(pinnedRef(target, resolution.digest));
    const comment = pinCommentText(target.ref, options.policy.comment, resolution.resolvedAt);
    if (comment) scalar.comment = comment;
    (container as Record<string, unknown>).uses = scalar;
  };

  visitSteps(ctx, ({ step, path }) => handle(step, path));
  visitJobs(ctx, ({ job, path }) => handle(job, path));
  return targets;
}
