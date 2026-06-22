import { type Job, visitJobs } from "../ir.js";
import type { PermissionsMode } from "../config.js";
import { type ParseContext, type Path, setKeyOrder } from "../parser.js";
import { isObject, pushDiagnostic } from "./helpers.js";
import type { Pass } from "./registry.js";

/**
 * permissions least-privilege pass: compute the minimal `permissions:` block each
 * job needs from its steps and either emit it (`infer`) or audit the declared
 * block against it (`check`). Default `off` so it never silently rewrites output.
 *
 * LATE pass: runs after every step-producing macro expands so it sees the final
 * step list. Pure IR (no `node:*`) so it composes into the browser bundle.
 *
 * SAFETY INVARIANT: never silently under-grant. An action we cannot map (and no
 * user override) makes the job "unknown": we emit a diagnostic and, in `infer`
 * mode, only ever broaden (never narrow) such a job.
 */

export type ScopeLevel = "read" | "write";
export type ScopeMap = Record<string, ScopeLevel>;

interface PermissionsInternal {
  mode: PermissionsMode;
  actions?: Record<string, ScopeMap>;
  inferRunScopes?: boolean;
  strict?: boolean;
}

/** The GITHUB_TOKEN scope keys GitHub accepts in a `permissions:` block. */
const KNOWN_SCOPES: ReadonlySet<string> = new Set([
  "actions",
  "attestations",
  "checks",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "repository-projects",
  "security-events",
  "statuses",
]);

/**
 * Bundled first-party action -> required scopes. Keyed by `owner/repo[/path]`
 * (no `@ref`). `github-script` is deliberately absent: it can call any API, so it
 * must stay "unknown" and force an explicit declaration. Users extend or override
 * this via `config.permissions.actions`.
 */
const BUNDLED_ACTIONS: ReadonlyMap<string, ScopeMap> = new Map<string, ScopeMap>([
  ["actions/checkout", { contents: "read" }],
  ["actions/cache", { contents: "read" }],
  ["actions/cache/restore", { contents: "read" }],
  ["actions/cache/save", { contents: "read" }],
  ["actions/upload-artifact", { contents: "read" }],
  ["actions/download-artifact", { contents: "read" }],
  ["actions/configure-pages", { contents: "read" }],
  ["actions/upload-pages-artifact", { contents: "read" }],
  ["actions/deploy-pages", { pages: "write", "id-token": "write" }],
  ["actions/stale", { issues: "write", "pull-requests": "write" }],
  ["actions/labeler", { contents: "read", "pull-requests": "write" }],
  ["actions/dependency-review-action", { contents: "read" }],
  ["actions/attest-build-provenance", {
    "id-token": "write",
    attestations: "write",
    contents: "read",
  }],
  ["actions/add-to-project", { "repository-projects": "write" }],
]);

/**
 * Prefix families: any action id starting with the prefix maps to these scopes
 * unless an exact bundled/override entry wins first. Keeps the table small for
 * the `actions/setup-*` and `github/codeql-action/*` constellations.
 */
const BUNDLED_PREFIXES: ReadonlyArray<readonly [string, ScopeMap]> = [
  ["actions/setup-", { contents: "read" }],
  ["github/codeql-action/", {
    "security-events": "write",
    actions: "read",
    contents: "read",
  }],
];

const rank: Record<ScopeLevel, number> = { read: 1, write: 2 };

/** Merge `src` into `dst`, keeping the broader level per scope (write beats read). */
function mergeScopes(dst: ScopeMap, src: ScopeMap): void {
  for (const [scope, level] of Object.entries(src)) {
    const current = dst[scope];
    if (current === undefined || rank[level] > rank[current]) dst[scope] = level;
  }
}

/** A scope map serialized with keys sorted, so emitted output is deterministic. */
function sortedScopeMap(scopes: ScopeMap): ScopeMap {
  const out: ScopeMap = {};
  for (const scope of Object.keys(scopes).sort()) {
    const level = scopes[scope];
    if (level !== undefined) out[scope] = level;
  }
  return out;
}

/** Parse `uses:` into its action id (`owner/repo[/path]`, no `@ref`), or undefined. */
function actionId(uses: string): string | undefined {
  const trimmed = uses.trim();
  if (trimmed === "") return undefined;
  // Local composite (`./...`), docker (`docker://...`), and reusable-workflow
  // refs are not mappable here: caller treats `undefined` as "unknown".
  if (trimmed.startsWith("./") || trimmed.startsWith("../")) return undefined;
  if (trimmed.startsWith("docker://")) return undefined;
  if (trimmed.endsWith(".yml") || trimmed.endsWith(".yaml")) return undefined;
  const id = trimmed.split("@", 1)[0] ?? "";
  return id.includes("/") ? id : undefined;
}

/** Look up an action id in user overrides, then the bundled exact/prefix tables. */
function lookupAction(id: string, overrides: Record<string, ScopeMap> | undefined): ScopeMap | undefined {
  const override = overrides?.[id];
  if (override) return override;
  const exact = BUNDLED_ACTIONS.get(id);
  if (exact) return exact;
  for (const [prefix, scopes] of BUNDLED_PREFIXES) {
    if (id.startsWith(prefix)) return scopes;
  }
  return undefined;
}

const TOKEN_HINT = /\bgh\b|GITHUB_TOKEN|github\.token|secrets\.GITHUB_TOKEN/;

/** Coarse opt-in heuristic: map a `gh`/API `run:` body to the scopes it likely needs. */
function inferRunStepScopes(run: string): ScopeMap | undefined {
  const scopes: ScopeMap = {};
  if (/\bgh\s+pr\b/.test(run)) scopes["pull-requests"] = "write";
  if (/\bgh\s+issue\b/.test(run)) scopes.issues = "write";
  if (/\bgh\s+release\b/.test(run)) scopes.contents = "write";
  if (/\bgh\s+run\b|\bgh\s+workflow\b/.test(run)) scopes.actions = "write";
  return Object.keys(scopes).length > 0 ? scopes : undefined;
}

interface JobScopes {
  scopes: ScopeMap;
  unknown: string[];
}

/** Compute the union of scopes every step in a job needs, plus any unknown refs. */
function computeJobScopes(job: Job, internal: PermissionsInternal): JobScopes {
  const scopes: ScopeMap = {};
  const unknown: string[] = [];
  const steps = Array.isArray(job.steps) ? job.steps : [];
  for (const step of steps) {
    if (!isObject(step)) continue;
    if (typeof step.uses === "string") {
      const id = actionId(step.uses);
      const mapped = id === undefined ? undefined : lookupAction(id, internal.actions);
      if (mapped) mergeScopes(scopes, mapped);
      else unknown.push(step.uses.trim());
      continue;
    }
    if (typeof step.run === "string" && TOKEN_HINT.test(step.run)) {
      const inferred = internal.inferRunScopes ? inferRunStepScopes(step.run) : undefined;
      if (inferred) mergeScopes(scopes, inferred);
      else unknown.push("run: (uses GITHUB_TOKEN)");
    }
  }
  return { scopes, unknown };
}

/** Position a freshly added `permissions:` key right after the recorded `anchor` key. */
function placePermissionsAfter(obj: object, anchor: string): void {
  const keys = Object.keys(obj);
  const permIdx = keys.indexOf("permissions");
  if (permIdx === -1) return;
  keys.splice(permIdx, 1);
  const anchorIdx = keys.indexOf(anchor);
  keys.splice(anchorIdx === -1 ? 0 : anchorIdx + 1, 0, "permissions");
  setKeyOrder(obj, keys);
}

/** Render a scope map as a compact `a: read, b: write` string for diagnostics. */
function renderScopes(scopes: ScopeMap): string {
  const entries = Object.entries(scopes);
  if (entries.length === 0) return "{}";
  return entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scope, level]) => `${scope}: ${level}`)
    .join(", ");
}

/** Normalize a declared job `permissions:` value into a scope map for comparison. */
function declaredToScopeMap(declared: unknown): { all?: ScopeLevel; map: ScopeMap } {
  if (declared === "read-all") return { all: "read", map: {} };
  if (declared === "write-all") return { all: "write", map: {} };
  const map: ScopeMap = {};
  if (isObject(declared)) {
    for (const [scope, level] of Object.entries(declared)) {
      if (level === "read" || level === "write") map[scope] = level;
    }
  }
  return { map };
}

/** Scopes the declared block grants beyond what the computed minimum needs. */
function overGrantedScopes(
  declared: { all?: ScopeLevel; map: ScopeMap },
  computed: ScopeMap,
): string[] {
  const over: string[] = [];
  if (declared.all !== undefined) {
    for (const scope of KNOWN_SCOPES) {
      const need = computed[scope];
      if (need === undefined || rank[declared.all] > rank[need]) {
        over.push(`${scope}: ${declared.all}`);
      }
    }
    return over;
  }
  for (const [scope, level] of Object.entries(declared.map)) {
    const need = computed[scope];
    if (need === undefined || rank[level] > rank[need]) over.push(`${scope}: ${level}`);
  }
  return over;
}

/** A job is a reusable-workflow call when it has `uses:` instead of `steps:`. */
function isCallJob(job: Job): boolean {
  return typeof job.uses === "string";
}

export function permissionsPass(ctx: ParseContext): void {
  const internal = ctx.internal.permissions;
  if (!internal || internal.mode === "off") return;

  const root = ctx.data as Record<string, unknown>;
  const rootHadPermissions = "permissions" in root;

  let inferredAnyJob = false;
  let uncoveredCallJob = false;

  visitJobs(ctx, ({ id: jobId, job }) => {
    const path: Path = ["jobs", jobId];

    if (isCallJob(job)) {
      if (!("permissions" in job)) {
        uncoveredCallJob = true;
        pushDiagnostic(
          ctx,
          "warning",
          `job '${jobId}' calls a reusable workflow; actio cannot infer its permissions. Declare them on the job.`,
          path,
          { code: "permissions-reusable-call" },
        );
      }
      return;
    }

    const { scopes, unknown } = computeJobScopes(job, internal);

    if (internal.mode === "check") {
      if (!("permissions" in job)) return;
      if (unknown.length > 0) {
        for (const ref of unknown) {
          pushDiagnostic(
            ctx,
            "warning",
            `job '${jobId}' uses '${ref}' with no known scopes; cannot verify its declared permissions. Add it to config.permissions.actions.`,
            path,
            { code: "permissions-unknown-action" },
          );
        }
        return;
      }
      const declared = declaredToScopeMap(job.permissions);
      const over = overGrantedScopes(declared, scopes);
      if (over.length > 0) {
        pushDiagnostic(
          ctx,
          internal.strict ? "error" : "warning",
          `job '${jobId}' declares permissions broader than required (over-granted: ${over.join(
            ", ",
          )}). Narrow to: ${renderScopes(scopes)}.`,
          path,
          { code: "permissions-over-grant" },
        );
      }
      return;
    }

    // infer mode: explicit job permissions always win (escape hatch).
    if ("permissions" in job) return;

    inferredAnyJob = true;

    if (unknown.length > 0) {
      for (const ref of unknown) {
        pushDiagnostic(
          ctx,
          "warning",
          `can't infer scopes for '${ref}' in job '${jobId}'; declare permissions explicitly or add it to config.permissions.actions.`,
          path,
          { code: "permissions-unknown-action" },
        );
      }
      // Only rescue from a deny-all baseline we are about to introduce; if the
      // user already manages top-level permissions, leave the job to inherit it.
      if (!rootHadPermissions) {
        job.permissions = "write-all";
        placePermissionsAfter(job, "runs-on");
      }
      return;
    }

    job.permissions = sortedScopeMap(scopes);
    placePermissionsAfter(job, "runs-on");
  });

  if (internal.mode === "infer" && !rootHadPermissions && inferredAnyJob && !uncoveredCallJob) {
    root.permissions = {};
    placePermissionsAfter(root, "on");
  }
}

export const permissions: Pass = {
  name: "permissions",
  runsAfter: [
    "fragments",
    "retry",
    "fallback",
    "dynamic-matrix",
    "expand-matrix",
    "lifecycle",
    "if-changed",
    "injection-hoist",
    "artifacts",
  ],
  apply: permissionsPass,
};
