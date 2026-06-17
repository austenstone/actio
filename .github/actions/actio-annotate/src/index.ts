import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import { parse as parseYaml } from "yaml";
import {
  matchJobKey,
  matchStepIndex,
  type ResolvedLocation,
  resolvePath,
  type SourceMap,
} from "./map.js";

interface ParsedStep {
  name?: string;
  uses?: string;
  run?: string;
  [key: string]: unknown;
}
interface ParsedJob {
  name?: string;
  steps?: ParsedStep[];
}
interface ParsedWorkflow {
  jobs?: Record<string, ParsedJob>;
}

/** The display name Actio gives its own injected job; never annotate it. */
const SELF_JOB_NAME = "Actio annotate";

/**
 * Turn `owner/repo/.github/workflows/ci.yml@refs/heads/main` (the value of
 * `GITHUB_WORKFLOW_REF`) into the repo-relative `.github/workflows/ci.yml`.
 */
function workflowPathFromRef(ref: string, repo: string): string | undefined {
  const withoutGit = ref.split("@")[0];
  const prefix = `${repo}/`;
  if (!withoutGit.startsWith(prefix)) return undefined;
  return withoutGit.slice(prefix.length);
}

function readSourceMap(workspace: string, workflowPath: string): SourceMap | undefined {
  try {
    const raw = readFileSync(join(workspace, `${workflowPath}.map`), "utf8");
    return JSON.parse(raw) as SourceMap;
  } catch {
    return undefined;
  }
}

function readWorkflow(workspace: string, workflowPath: string): ParsedWorkflow | undefined {
  try {
    const raw = readFileSync(join(workspace, workflowPath), "utf8");
    return parseYaml(raw) as ParsedWorkflow;
  } catch {
    return undefined;
  }
}

async function run(): Promise<void> {
  const token = core.getInput("token");
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const runId = github.context.runId;
  const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();

  const explicitPath = core.getInput("workflow-file");
  const workflowPath =
    explicitPath || workflowPathFromRef(process.env.GITHUB_WORKFLOW_REF ?? "", `${owner}/${repo}`);
  if (!workflowPath) {
    core.warning("actio-annotate: could not determine the workflow file; skipping.");
    return;
  }

  const map = readSourceMap(workspace, workflowPath);
  if (!map) {
    core.info(`actio-annotate: no source map beside ${workflowPath}; nothing to map.`);
    return;
  }
  const workflow = readWorkflow(workspace, workflowPath);
  const jobs = workflow?.jobs ?? {};

  const apiJobs = await octokit.paginate(octokit.rest.actions.listJobsForWorkflowRun, {
    owner,
    repo,
    run_id: runId,
    per_page: 100,
  });

  const seen = new Set<string>();
  const emit = (loc: ResolvedLocation, message: string): void => {
    const dedupe = `${loc.file}:${loc.line}:${loc.col}`;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    core.error(message, {
      file: loc.file,
      startLine: loc.line,
      startColumn: loc.col,
      title: "Actio: workflow step failed",
    });
  };

  for (const apiJob of apiJobs) {
    if (apiJob.conclusion !== "failure") continue;
    if (apiJob.name === SELF_JOB_NAME) continue;

    const key = matchJobKey(apiJob.name, jobs);
    if (!key) continue;

    const failedStep = (apiJob.steps ?? []).find((s) => s.conclusion === "failure");
    const yamlSteps = jobs[key]?.steps ?? [];
    const stepIdx = failedStep
      ? matchStepIndex(failedStep.name, yamlSteps as Array<Record<string, unknown>>)
      : undefined;

    const target = stepIdx === undefined ? `jobs.${key}` : `jobs.${key}.steps.${stepIdx}`;
    const loc = resolvePath(map, target) ?? resolvePath(map, `jobs.${key}`);
    if (!loc) continue;

    const where = failedStep ? `step "${failedStep.name}"` : "a step";
    emit(loc, `${apiJob.name}: ${where} failed`);
  }
}

run().catch((err: unknown) => {
  // Reporting must never turn a green run red, or mask the real failure.
  core.warning(`actio-annotate: ${err instanceof Error ? err.message : String(err)}`);
});
