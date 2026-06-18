import {
  conservativeTaint,
  type Job,
  type Step,
  type TaintFacet,
  transformSteps,
  visitJobs,
} from "../ir.js";
import { KEY_ORDER, type ParseContext, setKeyOrder } from "../parser.js";
import { isObject, pushDiagnostic } from "./helpers.js";
import type { Pass } from "./registry.js";

type Mode = "fix" | "warn" | "error" | "off";
type RunCtx = "bare" | "dquote" | "squote" | "heredoc-unquoted" | "heredoc-quoted";
type ShellFamily = "posix" | "pwsh" | "python";

const MODES = new Set<Mode>(["fix", "warn", "error", "off"]);

/**
 * `github.event.*` leaves that are numeric/enumerated and therefore not a
 * shell-injection vector even when attacker-influenced.
 */
const STRUCTURAL_SAFE_LEAVES = new Set(["number", "id", "sha", "state", "action"]);

/** Friendly env-var names for the well-known untrusted paths. */
const NAME_TABLE: Record<string, string> = {
  "github.event.pull_request.title": "PR_TITLE",
  "github.event.pull_request.body": "PR_BODY",
  "github.event.pull_request.head.ref": "PR_HEAD_REF",
  "github.event.issue.title": "ISSUE_TITLE",
  "github.event.issue.body": "ISSUE_BODY",
  "github.event.comment.body": "COMMENT_BODY",
  "github.event.review.body": "REVIEW_BODY",
  "github.event.head_commit.message": "HEAD_COMMIT_MESSAGE",
  "github.head_ref": "HEAD_REF",
  "github.ref_name": "REF_NAME",
  "github.ref": "REF",
};

function readMode(value: unknown): Mode | undefined {
  if (typeof value === "string" && MODES.has(value as Mode)) return value as Mode;
  // YAML may fold `off` to boolean false depending on schema; treat it as "off".
  if (value === false) return "off";
  return undefined;
}

function toSet(value: unknown): Set<string> {
  if (typeof value === "string") return new Set([value.trim()]);
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim()),
  );
}

/**
 * Whether a dotted reference path is an injectable, attacker-controlled value.
 * Only `github.*` roots are considered: `head_ref`/`ref_name`/`ref` are always
 * untrusted; `github.event.*` is untrusted unless its leaf is structurally safe.
 * Every other root (secrets, vars, env, inputs, matrix, needs, steps, runner,
 * job, strategy, params and actio's own `share.*`) is trusted and skipped.
 */
function isUntrustedPath(path: string): boolean {
  const segments = path.split(".");
  if (segments[0] !== "github") return false;
  const sub = segments[1];
  if (sub === "head_ref" || sub === "ref_name" || sub === "ref") return true;
  if (sub !== "event") return false;
  const leaf = segments[segments.length - 1] ?? "";
  return !STRUCTURAL_SAFE_LEAVES.has(leaf);
}

/** Pull dotted reference chains out of a `${{ }}` inner expression. */
function collectReferencePaths(expression: string): string[] {
  const paths: string[] = [];
  const isStart = (c: string) => /[A-Za-z_]/.test(c);
  const isPart = (c: string) => /[A-Za-z0-9_-]/.test(c);
  let quote: "'" | '"' | undefined;
  let i = 0;
  const n = expression.length;
  while (i < n) {
    const c = expression[i] as string;
    if (quote) {
      if (c === quote) {
        if (quote === "'" && expression[i + 1] === "'") {
          i += 2;
          continue;
        }
        quote = undefined;
      }
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i++;
      continue;
    }
    if (!isStart(c)) {
      i++;
      continue;
    }
    const start = i;
    let end = i + 1;
    while (end < n && isPart(expression[end] as string)) end++;
    while (
      end < n &&
      expression[end] === "." &&
      end + 1 < n &&
      isStart(expression[end + 1] as string)
    ) {
      end++;
      end++;
      while (end < n && isPart(expression[end] as string)) end++;
    }
    paths.push(expression.slice(start, end));
    i = end;
  }
  return paths;
}

interface Decision {
  facet: TaintFacet;
  untrusted: boolean;
  primaryPath?: string;
}

function classify(inner: string, trust: Set<string>, force: Set<string>): Decision {
  const paths = collectReferencePaths(inner);
  const forced = paths.find((p) => force.has(p));
  if (forced) {
    return {
      untrusted: true,
      primaryPath: forced,
      facet: { tainted: true, derivedFrom: [forced] },
    };
  }
  const untrusted = paths.filter((p) => isUntrustedPath(p) && !trust.has(p));
  if (untrusted.length === 0) return { untrusted: false, facet: conservativeTaint() };
  return {
    untrusted: true,
    primaryPath: untrusted[0],
    facet: { tainted: true, derivedFrom: untrusted },
  };
}

function deriveName(path: string): string {
  const mapped = NAME_TABLE[path];
  if (mapped) return mapped;
  const stripped = path.replace(/^github\.event\./, "").replace(/^github\./, "");
  const name = stripped
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return name || "ACTIO_VAR";
}

function resolveShellFamily(ctx: ParseContext, job: Job, step: Step): ShellFamily {
  const fromDefaults = (owner: unknown): string | undefined => {
    if (!isObject(owner)) return undefined;
    const defaults = (owner as { defaults?: unknown }).defaults;
    if (!isObject(defaults)) return undefined;
    const run = (defaults as { run?: unknown }).run;
    if (!isObject(run)) return undefined;
    const shell = (run as { shell?: unknown }).shell;
    return typeof shell === "string" ? shell : undefined;
  };
  const raw =
    (typeof step.shell === "string" && step.shell) ||
    fromDefaults(job) ||
    fromDefaults(ctx.data) ||
    "bash";
  const shell = raw.toLowerCase();
  if (shell === "pwsh" || shell === "powershell") return "pwsh";
  if (shell === "python") return "python";
  return "posix";
}

interface Span {
  start: number;
  end: number;
  inner: string;
}

function findSpans(body: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  while (true) {
    const start = body.indexOf("${{", i);
    if (start < 0) break;
    const close = body.indexOf("}}", start + 3);
    if (close < 0) break;
    spans.push({ start, end: close + 2, inner: body.slice(start + 3, close).trim() });
    i = close + 2;
  }
  return spans;
}

const HEREDOC_OPENER = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/** Classify the shell-quoting context each interpolation sits in. */
function contextsFor(body: string, spans: Span[]): RunCtx[] {
  const result: RunCtx[] = spans.map(() => "bare");
  const startToIndex = new Map<number, number>();
  const startToEnd = new Map<number, number>();
  spans.forEach((span, index) => {
    startToIndex.set(span.start, index);
    startToEnd.set(span.start, span.end);
  });

  const lines = body.split("\n");
  const lineStart: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStart.push(offset);
    offset += line.length + 1;
  }

  let active: { delim: string; quoted: boolean } | null = null;
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] as string;
    const base = lineStart[li] as number;
    const lineEnd = base + line.length;

    if (active) {
      if (line.trim() === active.delim) {
        active = null;
        continue;
      }
      for (let idx = 0; idx < spans.length; idx++) {
        const span = spans[idx] as Span;
        if (span.start >= base && span.start < lineEnd) {
          result[idx] = active.quoted ? "heredoc-quoted" : "heredoc-unquoted";
        }
      }
      continue;
    }

    let quote: "'" | '"' | null = null;
    let c = base;
    while (c < lineEnd) {
      if (startToIndex.has(c)) {
        const idx = startToIndex.get(c) as number;
        result[idx] = quote === '"' ? "dquote" : quote === "'" ? "squote" : "bare";
        c = startToEnd.get(c) as number;
        continue;
      }
      const ch = body[c] as string;
      if (quote) {
        if (ch === "\\" && quote === '"') {
          c += 2;
          continue;
        }
        if (ch === quote) quote = null;
        c++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        c++;
        continue;
      }
      if (ch === "\\") {
        c += 2;
        continue;
      }
      c++;
    }

    const opener = line.match(HEREDOC_OPENER);
    if (opener) active = { delim: opener[2] as string, quoted: opener[1] !== "" };
  }
  return result;
}

function refText(family: ShellFamily, ctxKind: RunCtx, name: string): string {
  if (family === "pwsh") {
    return ctxKind === "dquote" ? `$env:${name}` : `"$env:${name}"`;
  }
  if (ctxKind === "dquote" || ctxKind === "heredoc-unquoted") return `$${name}`;
  return `"$${name}"`;
}

/** Re-order a step's keys so a freshly added `env` renders just before `run`. */
function placeEnvBeforeRun(step: Step): void {
  const recorded = (step as Record<symbol, unknown>)[KEY_ORDER] as string[] | undefined;
  const present = Object.keys(step);
  const seeded = recorded
    ? [...recorded.filter((k) => k in step), ...present.filter((k) => !recorded.includes(k))]
    : present;
  const order = seeded.filter((k) => k !== "env");
  const runIndex = order.indexOf("run");
  if (runIndex >= 0) order.splice(runIndex, 0, "env");
  else order.push("env");
  setKeyOrder(step, order);
}

function diagPath(jobId: string, index: number): (string | number)[] {
  return ["jobs", jobId, "steps", index, "run"];
}

function hoistRun(
  ctx: ParseContext,
  jobId: string,
  index: number,
  step: Step,
  job: Job,
  mode: Mode,
  trust: Set<string>,
  force: Set<string>,
): void {
  const body = step.run as string;
  const spans = findSpans(body);
  if (spans.length === 0) return;

  const decisions = spans.map((span) => classify(span.inner, trust, force));
  if (!decisions.some((d) => d.untrusted)) return;

  const path = diagPath(jobId, index);

  if (mode === "warn" || mode === "error") {
    const severity = mode === "warn" ? "warning" : "error";
    const code = mode === "warn" ? "injection-hoist/warn" : "injection-hoist/error";
    spans.forEach((span, i) => {
      if (!decisions[i]?.untrusted) return;
      pushDiagnostic(
        ctx,
        severity,
        `Untrusted expression \`${span.inner}\` is interpolated into a run body and is a script-injection risk.`,
        path,
        { code, hint: "Set injectionHoist: fix to hoist it into an env var automatically." },
      );
    });
    return;
  }

  const family = resolveShellFamily(ctx, job, step);
  const contexts = contextsFor(body, spans);
  const existingEnv = isObject(step.env) ? (step.env as Record<string, unknown>) : undefined;
  const taken = new Set<string>(existingEnv ? Object.keys(existingEnv) : []);
  const generated: Record<string, string> = {};
  const byInner = new Map<string, string>();

  const unique = (base: string): string => {
    if (!taken.has(base)) return base;
    const prefixed = `ACTIO_${base}`;
    if (!taken.has(prefixed)) return prefixed;
    let n = 2;
    while (taken.has(`${prefixed}_${n}`)) n++;
    return `${prefixed}_${n}`;
  };

  let out = "";
  let cursor = 0;
  let touched = false;
  spans.forEach((span, i) => {
    out += body.slice(cursor, span.start);
    cursor = span.end;
    const original = body.slice(span.start, span.end);
    const decision = decisions[i] as Decision;
    if (!decision.untrusted) {
      out += original;
      return;
    }
    const ctxKind = contexts[i] as RunCtx;
    if (ctxKind === "heredoc-quoted") {
      pushDiagnostic(
        ctx,
        "error",
        `Untrusted expression \`${span.inner}\` cannot be safely hoisted inside a quoted heredoc (<<'EOF').`,
        path,
        {
          code: "injection-hoist/quoted-heredoc",
          hint: "Use an unquoted heredoc (<<EOF) or move the value out of the heredoc.",
        },
      );
      out += original;
      return;
    }
    if (ctxKind === "squote") {
      pushDiagnostic(
        ctx,
        "warning",
        `Untrusted expression \`${span.inner}\` sits inside single quotes and was left inline; hoist it manually.`,
        path,
        { code: "injection-hoist/manual-quote" },
      );
      out += original;
      return;
    }

    const value = `\${{ ${span.inner} }}`;
    let name = byInner.get(span.inner);
    if (!name) {
      const reuse = existingEnv
        ? Object.entries(existingEnv).find(([, v]) => v === value)?.[0]
        : undefined;
      if (reuse) {
        name = reuse;
      } else {
        name = unique(deriveName(decision.primaryPath ?? span.inner));
        generated[name] = value;
        taken.add(name);
      }
      byInner.set(span.inner, name);
    }

    if (family === "python") {
      pushDiagnostic(
        ctx,
        "warning",
        `Untrusted expression \`${span.inner}\` was hoisted to env \`${name}\` but the python run body was left unchanged; read it via os.environ[${JSON.stringify(name)}].`,
        path,
        { code: "injection-hoist/python-manual" },
      );
      out += original;
      touched = true;
      return;
    }

    out += refText(family, ctxKind, name);
    touched = true;
  });
  out += body.slice(cursor);

  if (!touched) return;

  if (Object.keys(generated).length > 0) {
    const env = existingEnv ?? {};
    for (const [k, v] of Object.entries(generated)) env[k] = v;
    step.env = env;
    placeEnvBeforeRun(step);
  }
  step.run = out;
}

function processStep(
  ctx: ParseContext,
  jobId: string,
  job: Job,
  step: Step,
  index: number,
  inherited: Mode,
): void {
  const stepMode = readMode(step.injectionHoist);
  const unsafe = step.unsafe === true;
  const trust = toSet(step.trust);
  const force = toSet(step.force);
  delete step.injectionHoist;
  delete step.unsafe;
  delete step.trust;
  delete step.force;

  const mode: Mode = stepMode ?? (unsafe ? "off" : inherited);
  if (mode === "off") return;
  if (typeof step.run !== "string" || step.run.length === 0) return;
  hoistRun(ctx, jobId, index, step, job, mode, trust, force);
}

function injectionHoistPass(ctx: ParseContext): void {
  const data = ctx.data as Record<string, unknown>;
  const docDefault = readMode(data.injectionHoist) ?? "fix";
  if ("injectionHoist" in data) delete data.injectionHoist;

  visitJobs(ctx, ({ id, job }) => {
    const jobRecord = job as Record<string, unknown>;
    const jobMode = readMode(jobRecord.injectionHoist) ?? docDefault;
    if ("injectionHoist" in jobRecord) delete jobRecord.injectionHoist;
    if (!Array.isArray(job.steps)) return;
    transformSteps(ctx, id, job, (step, index) => {
      if (isObject(step)) processStep(ctx, id, job, step, index, jobMode);
      return [step];
    });
  });
}

export const injectionHoist: Pass = {
  name: "injection_hoist",
  // Runs late so it observes fully expanded steps. The real ordering edge is
  // against the `share` pass (#18): injection-hoist must run AFTER share so
  // `${{ share.* }}` is already rewritten and skipped. #18 is in-flight and not
  // yet on this base, so we do NOT add a hard `runsAfter: ["share"]` edge here.
  // TODO(injection-hoist-share-ordering): once #18 merges, add "share" to
  // runsAfter. Until then, isUntrustedPath() defensively treats the `share.*`
  // root as trusted/own-namespace, so correctness holds whether or not share ran.
  runsAfter: ["fragments", "retry", "fallback", "dynamic_matrix"],
  apply: injectionHoistPass,
};
