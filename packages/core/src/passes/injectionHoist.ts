import { type Job, type Step, transformSteps, visitJobs } from "../ir.js";
import { type ParseContext, type Path, setKeyOrder } from "../parser.js";
import { isObject, pushDiagnostic } from "./helpers.js";
import type { Pass } from "./registry.js";

/**
 * injection-hoist security pass: defuse `${{ }}` script-injection in `run:`
 * blocks. Untrusted interpolations are hoisted into a step-level `env:` var and
 * the body is rewritten to reference the (shell-quoted) variable, so attacker-
 * controlled values can never be evaluated as shell.
 *
 * This is a LATE pass: it runs after the steps are fully expanded so it sees the
 * final `run:` bodies. The TaintFacet shape from keystone (#17) describes the
 * trusted/untrusted boundary; the runtime classification here is the pass's own
 * (keystone's `conservativeTaint` is for compile-time params only).
 *
 * TODO(injection-hoist-share-ordering): once #18 (share) merges, add "share" to
 * `runsAfter` so we observe the share macro's sanctioned `share.*` rewrites. The
 * pass already defensively skips `share.*` tokens so it is safe to run today.
 */

type HoistMode = "fix" | "warn" | "error" | "off";
type ShellFamily = "posix" | "pwsh" | "python";
type Classification = "untrusted" | "trusted" | "share";
type QuoteState = "none" | "single" | "double";

const MODES: ReadonlySet<string> = new Set(["fix", "warn", "error", "off"]);

/** Readable env-var names for the well-known untrusted context paths. */
const VAR_NAME_TABLE: Record<string, string> = {
  "github.event.pull_request.title": "PR_TITLE",
  "github.event.pull_request.body": "PR_BODY",
  "github.event.pull_request.head.ref": "PR_HEAD_REF",
  "github.event.pull_request.head.label": "PR_HEAD_LABEL",
  "github.event.pull_request.user.login": "PR_AUTHOR",
  "github.event.issue.title": "ISSUE_TITLE",
  "github.event.issue.body": "ISSUE_BODY",
  "github.event.comment.body": "COMMENT_BODY",
  "github.event.review.body": "REVIEW_BODY",
  "github.event.review_comment.body": "REVIEW_COMMENT_BODY",
  "github.event.discussion.title": "DISCUSSION_TITLE",
  "github.event.discussion.body": "DISCUSSION_BODY",
  "github.event.head_commit.message": "HEAD_COMMIT_MESSAGE",
  "github.event.head_commit.author.name": "HEAD_COMMIT_AUTHOR",
  "github.event.head_commit.author.email": "HEAD_COMMIT_EMAIL",
  "github.event.pages.0.page_name": "PAGE_NAME",
  "github.head_ref": "HEAD_REF",
  "github.ref_name": "REF_NAME",
  "github.ref": "GITHUB_REF_NAME",
};

/** `github.event.*` leaf segments that are structural (numeric/enum) and safe inline. */
const STRUCTURAL_LEAVES: ReadonlySet<string> = new Set([
  "number",
  "id",
  "sha",
  "node_id",
  "state",
  "action",
  "created_at",
  "updated_at",
]);

/** A single `${{ ... }}` occurrence located inside a `run:` body. */
interface Occurrence {
  start: number;
  end: number;
  raw: string;
  inner: string;
  quote: QuoteState;
}

function readModeKey(ctx: ParseContext, value: unknown, path: Path): HoistMode | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && MODES.has(value)) return value as HoistMode;
  pushDiagnostic(
    ctx,
    "warning",
    `injectionHoist must be one of "fix" | "warn" | "error" | "off" (got ${
      value === null ? "null" : typeof value
    }); using inherited mode`,
    path,
    { code: "injection-hoist-mode-invalid" },
  );
  return undefined;
}

function shellFamily(shell: unknown): ShellFamily {
  if (typeof shell !== "string") return "posix";
  const s = shell.toLowerCase();
  if (s === "pwsh" || s === "powershell") return "pwsh";
  if (s.startsWith("python")) return "python";
  return "posix";
}

/**
 * Canonicalize a context path for classification/lookup. Bracket-quoted and
 * numeric index access is rewritten to its dotted equivalent
 * (`github['event']['issue']['title']` → `github.event.issue.title`,
 * `github.event.pages[0]` → `github.event.pages.0`) so taint classification sees
 * the same canonical path regardless of access syntax. A dynamic index that
 * cannot be statically resolved (`github[foo]`) is left intact so callers can
 * detect it via `isUnanalyzablePath` and warn instead of silently failing open.
 */
function normalizePath(path: string): string {
  return path
    .replace(/\[\s*'([^']*)'\s*\]/g, ".$1")
    .replace(/\[\s*"([^"]*)"\s*\]/g, ".$1")
    .replace(/\[\s*(\d+)\s*\]/g, ".$1")
    .toLowerCase();
}

/**
 * True when a canonicalized path still carries an unresolved dynamic index
 * (e.g. `github[foo]`), meaning taint cannot be statically classified.
 */
function isUnanalyzablePath(normalized: string): boolean {
  return normalized.includes("[");
}

function classifyPath(path: string): Classification {
  const p = normalizePath(path);
  if (p.startsWith("share.") || p === "share") return "share";
  if (p.startsWith("secrets.") || p === "secrets") return "trusted";
  if (p === "github.head_ref" || p === "github.ref_name" || p === "github.ref") return "untrusted";
  if (p === "github.event" || p.startsWith("github.event.")) {
    const leaf = p.split(".").at(-1) ?? "";
    return STRUCTURAL_LEAVES.has(leaf) ? "trusted" : "untrusted";
  }
  return "trusted";
}

/** Extract root-anchored dotted context paths referenced inside an expression. */
function extractContextPaths(expr: string): string[] {
  const roots = "github|env|inputs|secrets|vars|matrix|runner|steps|needs|job|strategy|share";
  const re = new RegExp(`\\b(?:${roots})(?:\\.[A-Za-z0-9_-]+|\\[[^\\]]*\\])+`, "g");
  return expr.match(re) ?? [];
}

/**
 * Scan a `run:` body for `${{ ... }}` occurrences, tracking the shell quoting
 * context at each one (so the rewrite can avoid breaking existing quotes).
 */
function scanInterpolations(run: string): { occurrences: Occurrence[]; nested: boolean } {
  const occurrences: Occurrence[] = [];
  let quote: QuoteState = "none";
  let nested = false;
  for (let i = 0; i < run.length; i++) {
    const ch = run[i];
    if (quote === "double" && ch === "\\") {
      i++;
      continue;
    }
    if (quote === "none" && (ch === '"' || ch === "'")) {
      quote = ch === '"' ? "double" : "single";
      continue;
    }
    if (quote === "double" && ch === '"') {
      quote = "none";
      continue;
    }
    if (quote === "single" && ch === "'") {
      quote = "none";
      continue;
    }
    if (ch === "$" && run[i + 1] === "{" && run[i + 2] === "{") {
      const close = run.indexOf("}}", i + 3);
      if (close === -1) break;
      const raw = run.slice(i, close + 2);
      const inner = run.slice(i + 3, close).trim();
      if (inner.includes("${{")) nested = true;
      occurrences.push({ start: i, end: close + 2, raw, inner, quote });
      i = close + 1;
    }
  }
  return { occurrences, nested };
}

/** Build the shell reference for a hoisted var, honoring the existing quote context. */
function shellRef(name: string, family: ShellFamily, quote: QuoteState): string {
  const bare = family === "pwsh" ? `$env:${name}` : `$${name}`;
  if (quote === "double") return bare;
  if (quote === "single") return `'"${bare}"'`;
  return `"${bare}"`;
}

function fallbackVarName(path: string): string {
  const segs = normalizePath(path)
    .split(".")
    .filter((s) => s && s !== "github" && s !== "event");
  const raw = (segs.length > 0 ? segs : [normalizePath(path)]).join("_");
  const upper = raw.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  return /^[A-Za-z_]/.test(upper) ? upper : `VAR_${upper}`;
}

/**
 * Resolve the env-var name for a hoisted path. Reuses an existing entry with an
 * identical value; on a name collision with a different value, falls back to a
 * fully-qualified `ACTIO_...` name and then numeric suffixes.
 */
function resolveVarName(
  path: string,
  rawValue: string,
  reserved: Map<string, string>,
): { name: string; reuse: boolean } {
  const preferred = VAR_NAME_TABLE[normalizePath(path)] ?? fallbackVarName(path);
  const existing = reserved.get(preferred);
  if (existing === undefined) return { name: preferred, reuse: false };
  if (existing === rawValue) return { name: preferred, reuse: true };

  const qualified = `ACTIO_${fallbackVarName(path)}`;
  const qExisting = reserved.get(qualified);
  if (qExisting === undefined) return { name: qualified, reuse: false };
  if (qExisting === rawValue) return { name: qualified, reuse: true };

  for (let n = 2; ; n++) {
    const candidate = `${qualified}_${n}`;
    const cExisting = reserved.get(candidate);
    if (cExisting === undefined) return { name: candidate, reuse: false };
    if (cExisting === rawValue) return { name: candidate, reuse: true };
  }
}

interface StepKnobs {
  mode: HoistMode;
  trust: Set<string>;
  force: Set<string>;
}

function readStringList(ctx: ParseContext, value: unknown, key: string, path: Path): Set<string> {
  const out = new Set<string>();
  if (value === undefined) return out;
  if (!Array.isArray(value)) {
    pushDiagnostic(ctx, "warning", `${key} must be a list of context paths; ignoring`, path, {
      code: "injection-hoist-knob-invalid",
    });
    return out;
  }
  for (const entry of value) {
    if (typeof entry === "string") out.add(normalizePath(entry));
  }
  return out;
}

/** Reorder a step so its `env:` key is emitted before `run:` (matches authored idiom). */
function envBeforeRun(step: Step): void {
  const keys = Object.keys(step);
  const runIdx = keys.indexOf("run");
  const envIdx = keys.indexOf("env");
  if (runIdx === -1 || envIdx === -1 || envIdx < runIdx) return;
  keys.splice(envIdx, 1);
  keys.splice(keys.indexOf("run"), 0, "env");
  setKeyOrder(step, keys);
}

/** Hoist untrusted interpolations out of one step's `run:` body. */
function processStep(
  ctx: ParseContext,
  step: Step,
  knobs: StepKnobs,
  job: Job,
  root: Record<string, unknown>,
  path: Path,
): void {
  if (knobs.mode === "off") return;
  if (typeof step.run !== "string") return;

  const run = step.run;
  const { occurrences, nested } = scanInterpolations(run);
  if (occurrences.length === 0) return;

  if (nested) {
    pushDiagnostic(
      ctx,
      "error",
      "Nested `${{ ... ${{ ... }} ... }}` interpolation cannot be safely hoisted; rewrite the expression",
      [...path, "run"],
      { code: "injection-hoist-nested" },
    );
    return;
  }

  // A dynamic bracket index (`github[foo]`) can't be statically classified for
  // taint. Warn loudly rather than letting the path normalize to a trusted root
  // and silently pass an untrusted value through to the shell.
  const unanalyzable = occurrences.filter((occ) =>
    extractContextPaths(occ.inner).map(normalizePath).some(isUnanalyzablePath),
  );
  if (unanalyzable.length > 0) {
    pushDiagnostic(
      ctx,
      "warning",
      `Dynamic bracket indexing can't be statically analyzed for taint (${
        unanalyzable.length
      } occurrence${
        unanalyzable.length === 1 ? "" : "s"
      }); rewrite to dotted access (e.g. github.event.issue.title) or hoist manually`,
      [...path, "run"],
      { code: "injection-hoist-unanalyzable-path" },
    );
  }

  // Decide, per occurrence, whether it carries an untrusted (or forced) value.
  const hoistable = occurrences.filter((occ) => {
    const paths = extractContextPaths(occ.inner).map(normalizePath);
    const forced = paths.some((p) => knobs.force.has(p));
    if (forced) return true;
    return paths.some((p) => classifyPath(p) === "untrusted" && !knobs.trust.has(p));
  });
  if (hoistable.length === 0) return;

  const quotedHeredoc = /<<-?\s*(['"])[A-Za-z_][A-Za-z0-9_]*\1/.test(run);
  if (quotedHeredoc) {
    pushDiagnostic(
      ctx,
      "error",
      "Quoted heredoc (`<<'EOF'`) prevents safe injection-hoist rewriting; use an unquoted heredoc or hoist manually",
      [...path, "run"],
      { code: "injection-hoist-quoted-heredoc" },
    );
    return;
  }

  if (knobs.mode === "warn" || knobs.mode === "error") {
    const severity = knobs.mode === "error" ? "error" : "warning";
    pushDiagnostic(
      ctx,
      severity,
      `Untrusted interpolation in run: should be hoisted into env (${hoistable.length} occurrence${
        hoistable.length === 1 ? "" : "s"
      })`,
      [...path, "run"],
      { code: "injection-hoist-untrusted" },
    );
    return;
  }

  // mode === "fix": assign vars and (for shells we can rewrite) splice the body.
  const family = shellFamily(step.shell);
  const reserved = new Map<string, string>();
  for (const scope of [root.env, job.env, step.env]) {
    if (isObject(scope)) {
      for (const [k, v] of Object.entries(scope)) reserved.set(k, String(v));
    }
  }

  const additions: Array<{ name: string; value: string }> = [];
  const replacements: Array<{ start: number; end: number; text: string }> = [];

  for (const occ of hoistable) {
    const paths = extractContextPaths(occ.inner).map(normalizePath);
    const primary =
      paths.find((p) => knobs.force.has(p)) ??
      paths.find((p) => classifyPath(p) === "untrusted" && !knobs.trust.has(p)) ??
      paths[0] ??
      occ.inner;
    const { name, reuse } = resolveVarName(primary, occ.raw, reserved);
    if (!reuse) {
      reserved.set(name, occ.raw);
      additions.push({ name, value: occ.raw });
    }
    replacements.push({ start: occ.start, end: occ.end, text: shellRef(name, family, occ.quote) });
  }

  const env = isObject(step.env) ? (step.env as Record<string, unknown>) : {};
  for (const { name, value } of additions) env[name] = value;
  step.env = env;

  if (family === "python") {
    pushDiagnostic(
      ctx,
      "warning",
      "Python `run:` is not auto-rewritten; untrusted values were hoisted into env — read them via os.environ[...] instead of inlining",
      [...path, "run"],
      { code: "injection-hoist-python" },
    );
    envBeforeRun(step);
    return;
  }

  let rewritten = run;
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    rewritten = rewritten.slice(0, r.start) + r.text + rewritten.slice(r.end);
  }
  step.run = rewritten;
  envBeforeRun(step);
}

export function injectionHoistPass(ctx: ParseContext): void {
  const root = ctx.data as Record<string, unknown>;
  const globalDefault: HoistMode = ctx.internal.injectionHoist ?? "fix";
  const rootMode = readModeKey(ctx, root.injectionHoist, ["injectionHoist"]) ?? globalDefault;
  delete root.injectionHoist;

  visitJobs(ctx, ({ id: jobId, job }) => {
    const jobMode =
      readModeKey(ctx, job.injectionHoist, ["jobs", jobId, "injectionHoist"]) ?? rootMode;
    delete job.injectionHoist;

    transformSteps(ctx, jobId, job, (step, idx) => {
      if (!isObject(step)) return [step];
      const path: Path = ["jobs", jobId, "steps", idx];
      const stepMode =
        readModeKey(ctx, step.injectionHoist, [...path, "injectionHoist"]) ?? jobMode;
      const unsafe = step.unsafe === true;
      const knobs: StepKnobs = {
        mode: unsafe ? "off" : stepMode,
        trust: readStringList(ctx, step.trust, "trust", [...path, "trust"]),
        force: readStringList(ctx, step.force, "force", [...path, "force"]),
      };

      // Strip the macro-only knobs so they never leak into emitted GitHub YAML.
      delete step.injectionHoist;
      delete step.unsafe;
      delete step.trust;
      delete step.force;

      processStep(ctx, step, knobs, job, root, path);
      return [step];
    });
  });
}

export const injectionHoist: Pass = {
  name: "injection-hoist",
  // TODO(injection-hoist-share-ordering): add "share" once #18 merges so we run
  // after the share macro's sanctioned `share.*` rewrites.
  runsAfter: ["fragments", "retry", "fallback", "dynamic_matrix", "lifecycle"],
  apply: injectionHoistPass,
};
