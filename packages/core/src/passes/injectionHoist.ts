import { type Job, type Step, transformSteps, visitJobs } from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import { RUNTIME_CONTEXT_ROOT_SET, type TaintFacet } from "../symbols.js";
import { isObject, pushDiagnostic } from "./helpers.js";
import type { Pass } from "./registry.js";

// macro #22 injection-hoist — auto-defuse `${{ }}` script injection.
//
// Untrusted GitHub Actions expressions (`github.event.*`, `github.head_ref`,
// `github.ref_name`) interpolated directly into a `run:` body are spliced as
// literal text by the GHA templating layer BEFORE the shell runs — so a PR
// title of `"; rm -rf / #` breaks out of any surrounding quoting. This pass
// hoists each such interpolation into a step `env:` var (where the value is
// passed as data, not spliced into the script) and rewrites the script to
// reference the shell variable instead.
//
// Taint: we consume #17's `TaintFacet` shape and the shared
// `RUNTIME_CONTEXT_ROOT_SET` rather than forking a parallel taint system. We do
// NOT reuse `conservativeTaint()` — its docstring forbids runtime passes from
// reusing the compile-time-param stance; injection taint is classified here.
//
// v1 SCOPE: step-level hoist only — one `env:` block per step is hoisted in
// place. Job-level auto-lift (issue #22 spec §4d: collapsing a repeated
// untrusted interpolation across sibling steps into a single job-level `env:`)
// is DEFERRED.
// TODO(injection-hoist-job-lift): implement job-level §4d auto-lift in a
// follow-up once step-scope hoisting has baked in.

type Mode = "fix" | "warn" | "error" | "off";
const MODES: ReadonlySet<string> = new Set<Mode>(["fix", "warn", "error", "off"]);

const CONFIG_KEYS = ["injectionHoist", "unsafe", "trust", "force"] as const;

const CODE = {
  hoisted: "injection-hoist/hoisted",
  untrusted: "injection-hoist/untrusted",
  singleQuote: "injection-hoist/single-quote",
  quotedHeredoc: "injection-hoist/quoted-heredoc",
  python: "injection-hoist/python",
  unsupportedShell: "injection-hoist/unsupported-shell",
  complex: "injection-hoist/complex-expression",
  invalidMode: "injection-hoist/invalid-mode",
  invalidConfig: "injection-hoist/invalid-config",
} as const;

/** Readable env var names for the most common untrusted expressions. */
const NAME_TABLE: ReadonlyMap<string, string> = new Map([
  ["github.event.pull_request.title", "PR_TITLE"],
  ["github.event.pull_request.body", "PR_BODY"],
  ["github.event.pull_request.head.ref", "PR_HEAD_REF"],
  ["github.event.pull_request.head.label", "PR_HEAD_LABEL"],
  ["github.event.issue.title", "ISSUE_TITLE"],
  ["github.event.issue.body", "ISSUE_BODY"],
  ["github.event.comment.body", "COMMENT_BODY"],
  ["github.event.review.body", "REVIEW_BODY"],
  ["github.event.head_commit.message", "HEAD_COMMIT_MESSAGE"],
  ["github.head_ref", "HEAD_REF"],
  ["github.ref_name", "REF_NAME"],
]);

const SIMPLE_PATH_RE = /^[A-Za-z_]\w*(\.\w+)*$/;
const UNTRUSTED_MARKER_RE = /github\s*\.\s*(event\b|head_ref\b|ref_name\b)/;

type QuoteState = "none" | "single" | "double";
type HeredocState = "none" | "expand" | "literal";

type Token =
  | { kind: "text"; text: string }
  | { kind: "interp"; raw: string; inner: string; quote: QuoteState; heredoc: HeredocState };

interface ScopeConfig {
  mode?: Mode;
  unsafe: boolean;
  trust: string[];
  force: string[];
}

/** Resolve the cascade of config knobs at one scope level (workflow/job/step). */
function readScopeConfig(
  ctx: ParseContext,
  container: Record<string, unknown>,
  path: Path,
): ScopeConfig {
  const cfg: ScopeConfig = { unsafe: false, trust: [], force: [] };

  const rawMode = container.injectionHoist;
  if (rawMode !== undefined) {
    if (typeof rawMode === "string" && MODES.has(rawMode)) {
      cfg.mode = rawMode as Mode;
    } else {
      pushDiagnostic(
        ctx,
        "warning",
        `injectionHoist must be one of "fix", "warn", "error", "off" (got ${describe(rawMode)}); ignoring`,
        [...path, "injectionHoist"],
        { code: CODE.invalidMode },
      );
    }
  }

  const rawUnsafe = container.unsafe;
  if (rawUnsafe !== undefined) {
    if (typeof rawUnsafe === "boolean") cfg.unsafe = rawUnsafe;
    else
      pushDiagnostic(
        ctx,
        "warning",
        `unsafe must be a boolean (got ${describe(rawUnsafe)}); ignoring`,
        [...path, "unsafe"],
        { code: CODE.invalidConfig },
      );
  }

  cfg.trust = readExprList(ctx, container.trust, [...path, "trust"]);
  cfg.force = readExprList(ctx, container.force, [...path, "force"]);
  return cfg;
}

function readExprList(ctx: ParseContext, value: unknown, path: Path): string[] {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string") out.push(normalizeExpr(stripWrapper(item)));
    else
      pushDiagnostic(
        ctx,
        "warning",
        `${String(path[path.length - 1])} entries must be expression strings (got ${describe(item)}); ignoring`,
        path,
        { code: CODE.invalidConfig },
      );
  }
  return out;
}

function describe(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function stripWrapper(expr: string): string {
  const t = expr.trim();
  if (t.startsWith("${{") && t.endsWith("}}")) return t.slice(3, -2);
  return t;
}

function normalizeExpr(inner: string): string {
  return inner.replace(/\s+/g, "");
}

/** Injection-taint classification for a simple dotted path. */
function classifyInjectionTaint(expr: string): TaintFacet {
  const segments = expr.split(".");
  const root = segments[0];
  if (root === undefined || !RUNTIME_CONTEXT_ROOT_SET.has(root)) {
    return { tainted: false, derivedFrom: [] };
  }
  if (root === "github") {
    const tainted =
      expr === "github.head_ref" || expr === "github.ref_name" || segments[1] === "event";
    return tainted ? { tainted: true, derivedFrom: [expr] } : { tainted: false, derivedFrom: [] };
  }
  // needs, steps, secrets, env, inputs, vars, runner, job, matrix, strategy.
  return { tainted: false, derivedFrom: [] };
}

/** Split a `run:` body into text/interp tokens, tracking shell quote + heredoc state. */
function tokenizeRun(run: string): Token[] {
  const tokens: Token[] = [];
  const lines = run.split("\n");
  let heredoc: { delim: string; expand: boolean } | null = null;

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li] ?? "";
    const nl = li < lines.length - 1 ? "\n" : "";
    if (heredoc) {
      if (line.trim() === heredoc.delim) {
        tokens.push({ kind: "text", text: line + nl });
        heredoc = null;
        continue;
      }
      scanLine(line, heredoc.expand ? "expand" : "literal", tokens);
      tokens.push({ kind: "text", text: nl });
      continue;
    }
    const started = scanLine(line, "none", tokens);
    tokens.push({ kind: "text", text: nl });
    if (started) heredoc = started;
  }
  return tokens;
}

const HEREDOC_RE = /^<<-?\s*(["']?)([A-Za-z_]\w*)\1/;

function scanLine(
  line: string,
  heredocCtx: HeredocState,
  tokens: Token[],
): { delim: string; expand: boolean } | null {
  let shellQuote: QuoteState = "none";
  let started: { delim: string; expand: boolean } | null = null;
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      tokens.push({ kind: "text", text: buf });
      buf = "";
    }
  };

  while (i < line.length) {
    const ch = line[i] ?? "";
    if (ch === "$" && line.slice(i, i + 3) === "${{") {
      const end = line.indexOf("}}", i + 3);
      if (end !== -1) {
        flush();
        tokens.push({
          kind: "interp",
          raw: line.slice(i, end + 2),
          inner: line.slice(i + 3, end).trim(),
          quote: heredocCtx === "none" ? shellQuote : "none",
          heredoc: heredocCtx,
        });
        i = end + 2;
        continue;
      }
    }

    if (heredocCtx !== "none") {
      buf += ch;
      i++;
      continue;
    }

    if (shellQuote === "none") {
      if (ch === "'") {
        shellQuote = "single";
      } else if (ch === '"') {
        shellQuote = "double";
      } else if (ch === "\\") {
        buf += ch + (line[i + 1] ?? "");
        i += 2;
        continue;
      } else if (ch === "<" && line[i + 1] === "<" && !started) {
        const m = HEREDOC_RE.exec(line.slice(i));
        if (m?.[2] !== undefined) {
          started = { delim: m[2], expand: m[1] === "" };
          buf += m[0];
          i += m[0].length;
          continue;
        }
      }
    } else if (shellQuote === "single") {
      if (ch === "'") shellQuote = "none";
    } else {
      if (ch === "\\") {
        buf += ch + (line[i + 1] ?? "");
        i += 2;
        continue;
      }
      if (ch === '"') shellQuote = "none";
    }
    buf += ch;
    i++;
  }
  flush();
  return started;
}

type ShellKind = "posix" | "pwsh" | "python" | "other";

function resolveShell(step: Step, job: Job, wf: Record<string, unknown>): ShellKind {
  const raw =
    pickShell(step.shell) ??
    pickShell(nestedRunShell(job.defaults)) ??
    pickShell(nestedRunShell(wf.defaults)) ??
    "bash";
  const s = raw.toLowerCase();
  if (s === "bash" || s === "sh") return "posix";
  if (s === "pwsh" || s === "powershell") return "pwsh";
  if (s === "python") return "python";
  return "other";
}

function pickShell(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nestedRunShell(defaults: unknown): unknown {
  if (isObject(defaults) && isObject(defaults.run)) return defaults.run.shell;
  return undefined;
}

function effectiveQuote(token: Extract<Token, { kind: "interp" }>): QuoteState | "literal" {
  if (token.heredoc === "expand") return "double";
  if (token.heredoc === "literal") return "literal";
  return token.quote;
}

function replacement(
  varName: string,
  quote: QuoteState,
  shell: "posix" | "pwsh",
  nextChar: string,
): string {
  const braced = nextChar !== "" && /[A-Za-z0-9_]/.test(nextChar);
  const ref =
    shell === "pwsh"
      ? braced
        ? `\${env:${varName}}`
        : `$env:${varName}`
      : braced
        ? `\${${varName}}`
        : `$${varName}`;
  return quote === "double" ? ref : `"${ref}"`;
}

function deriveVarName(expr: string): string {
  const mapped = NAME_TABLE.get(expr);
  if (mapped) return mapped;
  const segments = expr.split(".");
  let parts: string[];
  if (segments[0] === "github" && segments[1] === "event") parts = segments.slice(2);
  else if (segments[0] === "github") parts = segments.slice(1);
  else parts = segments;
  const name = parts
    .join("_")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return name || "ACTIO_ENV";
}

function upperSnake(expr: string): string {
  return expr
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function canonicalInterp(expr: string): string {
  return `\${{ ${expr} }}`;
}

function envValueExpr(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (t.startsWith("${{") && t.endsWith("}}")) return normalizeExpr(t.slice(3, -2));
  return undefined;
}

interface StepContext {
  jobId: string;
  index: number;
  mode: Mode;
  shell: ShellKind;
  trust: ReadonlySet<string>;
  force: ReadonlySet<string>;
}

function processStep(ctx: ParseContext, step: Step, sc: StepContext): void {
  if (typeof step.run !== "string") return;
  const path: Path = ["jobs", sc.jobId, "steps", sc.index, "run"];
  const tokens = tokenizeRun(step.run);

  const taken = new Set<string>(envKeys(step.env));
  const allocated = new Map<string, string>();
  const envEntries = new Map<string, string>();
  let rewrote = false;

  const allocVar = (expr: string): string => {
    const prior = allocated.get(expr);
    if (prior) return prior;
    const canonical = canonicalInterp(expr);
    const reuse = findEnvKeyForValue(step.env, expr);
    if (reuse) {
      allocated.set(expr, reuse);
      return reuse;
    }
    let base = deriveVarName(expr);
    if (taken.has(base)) base = `ACTIO_${upperSnake(expr)}`;
    let name = base;
    let n = 2;
    while (taken.has(name)) name = `${base}_${n++}`;
    taken.add(name);
    allocated.set(expr, name);
    envEntries.set(name, canonical);
    return name;
  };

  tokens.forEach((token, ti) => {
    if (token.kind !== "interp") return;
    const exprNorm = normalizeExpr(token.inner);

    // share seam: `${{ share.* }}` is actio's sanctioned rewrite namespace,
    // resolved by the share pass (#18). Never hoist it.
    // TODO(injection-hoist-share-ordering): once #18 share lands, add "share"
    // to this pass's `runsAfter` so share's rewritten tokens are final before
    // this scan; whichever of #18/#22 merges second owns wiring that edge.
    if (exprNorm === "share" || exprNorm.startsWith("share.")) return;

    if (!SIMPLE_PATH_RE.test(exprNorm)) {
      if (UNTRUSTED_MARKER_RE.test(token.inner) && !sc.trust.has(exprNorm)) {
        pushDiagnostic(
          ctx,
          "warning",
          `Cannot auto-hoist complex expression "${token.inner}" containing untrusted input; assign it to an env var manually`,
          path,
          {
            code: CODE.complex,
            hint: "Move the expression into env: and reference $VAR in the script.",
          },
        );
      }
      return;
    }

    let tainted = classifyInjectionTaint(exprNorm).tainted;
    if (sc.force.has(exprNorm)) tainted = true;
    else if (sc.trust.has(exprNorm)) tainted = false;
    if (!tainted) return;

    if (sc.mode === "error") {
      pushDiagnostic(
        ctx,
        "error",
        `Untrusted expression "${token.inner}" is interpolated into a run script; this is a script-injection risk`,
        path,
        {
          code: CODE.untrusted,
          hint: 'Switch injectionHoist to "fix" to auto-hoist it into env:.',
        },
      );
      return;
    }

    if (sc.shell === "python" || sc.shell === "other") {
      // Cannot safely rewrite the body; still surface the env var so the author
      // can switch to reading it (os.environ / $env) and warn.
      allocVar(exprNorm);
      pushDiagnostic(
        ctx,
        "warning",
        sc.shell === "python"
          ? `Untrusted expression "${token.inner}" hoisted to env "${allocated.get(exprNorm)}", but the python script body was left unchanged; read it via os.environ instead`
          : `Untrusted expression "${token.inner}" hoisted to env "${allocated.get(exprNorm)}", but this shell is unsupported for auto-rewrite; reference the env var manually`,
        path,
        { code: sc.shell === "python" ? CODE.python : CODE.unsupportedShell },
      );
      return;
    }

    const quote = effectiveQuote(token);
    if (quote === "literal") {
      pushDiagnostic(
        ctx,
        "error",
        `Untrusted expression "${token.inner}" sits inside a quoted heredoc (<<'EOF'); its body is literal and cannot be safely rewritten`,
        path,
        {
          code: CODE.quotedHeredoc,
          hint: "Use an unquoted heredoc delimiter (<<EOF) to allow hoisting.",
        },
      );
      return;
    }
    if (quote === "single") {
      pushDiagnostic(
        ctx,
        "error",
        `Untrusted expression "${token.inner}" sits inside single quotes; it cannot be safely rewritten to a shell variable`,
        path,
        {
          code: CODE.singleQuote,
          hint: "Use double quotes around the value so the env var can be referenced.",
        },
      );
      return;
    }

    const varName = allocVar(exprNorm);
    const next = tokens[ti + 1];
    const nextChar = next && next.kind === "text" ? (next.text[0] ?? "") : "";
    token.raw = replacement(varName, quote, sc.shell, nextChar);
    rewrote = true;

    if (sc.mode === "warn") {
      pushDiagnostic(
        ctx,
        "warning",
        `Hoisted untrusted expression "${token.inner}" into env "${varName}"`,
        path,
        { code: CODE.hoisted },
      );
    }
  });

  if (envEntries.size === 0) {
    if (rewrote) step.run = tokens.map((t) => (t.kind === "text" ? t.text : t.raw)).join("");
    return;
  }

  if (step.env !== undefined && !isObject(step.env)) {
    pushDiagnostic(
      ctx,
      "warning",
      `Cannot hoist into step env: existing env is not a mapping (got ${describe(step.env)})`,
      ["jobs", sc.jobId, "steps", sc.index, "env"],
      { code: CODE.invalidConfig },
    );
    if (rewrote) step.run = tokens.map((t) => (t.kind === "text" ? t.text : t.raw)).join("");
    return;
  }

  const env: Record<string, unknown> = isObject(step.env) ? step.env : {};
  for (const [name, value] of envEntries) env[name] = value;
  step.env = env;
  step.run = tokens.map((t) => (t.kind === "text" ? t.text : t.raw)).join("");
}

function envKeys(env: unknown): string[] {
  return isObject(env) ? Object.keys(env) : [];
}

function findEnvKeyForValue(env: unknown, expr: string): string | undefined {
  if (!isObject(env)) return undefined;
  for (const [k, v] of Object.entries(env)) {
    if (envValueExpr(v) === expr) return k;
  }
  return undefined;
}

function stripConfigKeys(container: Record<string, unknown>): void {
  for (const key of CONFIG_KEYS) delete container[key];
}

export function injectionHoistPass(ctx: ParseContext): void {
  const wf = ctx.data;
  const wfCfg = readScopeConfig(ctx, wf, []);

  visitJobs(ctx, ({ id: jobId, job, path: jobPath }) => {
    const jobCfg = readScopeConfig(ctx, job, jobPath);
    const mode: Mode = jobCfg.mode ?? wfCfg.mode ?? "fix";
    const unsafe = wfCfg.unsafe || jobCfg.unsafe;
    const jobTrust = [...wfCfg.trust, ...jobCfg.trust];
    const jobForce = [...wfCfg.force, ...jobCfg.force];

    if (Array.isArray(job.steps)) {
      transformSteps(ctx, jobId, job, (step, index) => {
        if (!isObject(step)) return [step];
        const stepCfg = readScopeConfig(ctx, step, ["jobs", jobId, "steps", index]);
        const stepMode: Mode = stepCfg.mode ?? mode;
        const stepUnsafe = unsafe || stepCfg.unsafe;
        stripConfigKeys(step);
        if (stepMode !== "off" && !stepUnsafe) {
          processStep(ctx, step, {
            jobId,
            index,
            mode: stepMode,
            shell: resolveShell(step, job, wf),
            trust: new Set([...jobTrust, ...stepCfg.trust]),
            force: new Set([...jobForce, ...stepCfg.force]),
          });
        }
        return [step];
      });
    }
    stripConfigKeys(job);
  });

  stripConfigKeys(wf);
}

/**
 * injection-hoist: rewrite untrusted `${{ }}` interpolations inside `run:`
 * bodies into `env:` vars + safe shell references. A LATE pass: it runs after
 * fragments/retry/fallback/dynamic_matrix so it sees fully-expanded steps.
 */
export const injectionHoist: Pass = {
  name: "injection_hoist",
  // TODO(injection-hoist-share-ordering): add "share" here once #18 merges so
  // this pass runs AFTER share (… → share → injection-hoist → annotate) and
  // never re-hoists share's rewritten tokens. Mocked for now via the
  // `${{ share.* }}` skip guard in processStep.
  runsAfter: ["fragments", "retry", "fallback", "dynamic_matrix"],
  apply: injectionHoistPass,
};
