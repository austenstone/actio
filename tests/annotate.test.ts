import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  defaultStepName,
  matchJobKey,
  matchStepIndex,
  resolvePath,
  type SourceMap,
} from "../.github/actions/actio-annotate/src/map.js";

const WORKFLOW = `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm test
`;

interface Jobs {
  [key: string]: { name?: string; "runs-on"?: string; needs?: string[]; if?: string };
}

function jobsOf(yaml: string): Jobs {
  return (parse(yaml) as { jobs: Jobs }).jobs;
}

describe("annotate pass", () => {
  it("appends the actio-annotate job at the bottom when sourceMap is on", () => {
    const { ok, yaml } = transpile(WORKFLOW, { annotate: true, sourceMap: true });
    expect(ok).toBe(true);
    const jobs = jobsOf(yaml);
    expect(jobs["actio-annotate"]).toBeDefined();
    expect(jobs["actio-annotate"].if).toBe("failure()");
    expect(jobs["actio-annotate"].needs).toEqual(["build"]);
    // Emitted last so `needs: <all jobs>` is satisfiable.
    expect(Object.keys(jobs).at(-1)).toBe("actio-annotate");
  });

  it("does not inject when annotate is off", () => {
    const { yaml } = transpile(WORKFLOW, { sourceMap: true });
    expect(jobsOf(yaml)["actio-annotate"]).toBeUndefined();
  });

  it("warns and skips when annotate is requested without a source map", () => {
    const { yaml, diagnostics } = transpile(WORKFLOW, { annotate: true });
    expect(jobsOf(yaml)["actio-annotate"]).toBeUndefined();
    expect(
      diagnostics.some(
        (d) => d.severity === "warning" && /annotate requires sourceMap/.test(d.message),
      ),
    ).toBe(true);
  });

  it("warns instead of clobbering a user job named actio-annotate", () => {
    const collide = `name: ci
on: [push]
jobs:
  actio-annotate:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const { diagnostics } = transpile(collide, { annotate: true, sourceMap: true });
    expect(
      diagnostics.some((d) => d.severity === "warning" && /already exists/.test(d.message)),
    ).toBe(true);
  });
});

describe("action map helpers", () => {
  const map: SourceMap = {
    version: 1,
    generator: "actio",
    file: "ci.yml",
    sources: [".github/actio/ci.actio.yml"],
    mappings: [
      {
        generated: { line: 26 },
        source: 0,
        original: { line: 18, col: 9 },
        path: "jobs.build.steps.0.uses",
      },
      {
        generated: { line: 31 },
        source: 0,
        original: { line: 23, col: 9 },
        path: "jobs.build.steps.2.run",
      },
      {
        generated: { line: 32 },
        source: 0,
        original: { line: 34, col: 9 },
        path: "jobs.build.steps.3.run",
      },
    ],
  };

  it("derives default step names like GitHub does", () => {
    expect(defaultStepName({ name: "Custom" })).toBe("Custom");
    expect(defaultStepName({ uses: "actions/checkout@v4" })).toBe("actions/checkout@v4");
    expect(defaultStepName({ run: "npm test\nnpm run lint" })).toBe("Run npm test");
  });

  it("matches a job display name to its generated key, including matrix legs", () => {
    const jobs = { build: { name: "Build" }, lint: {} };
    expect(matchJobKey("Build", jobs)).toBe("build");
    expect(matchJobKey("Build (18)", jobs)).toBe("build");
    expect(matchJobKey("lint", jobs)).toBe("lint");
    expect(matchJobKey("nope", jobs)).toBeUndefined();
  });

  it("matches failed step names to their index, tolerating truncation", () => {
    const steps = [{ uses: "actions/checkout@v4" }, { name: "Setup" }, { run: "npm test" }];
    expect(matchStepIndex("actions/checkout@v4", steps)).toBe(0);
    expect(matchStepIndex("Run npm test", steps)).toBe(2);
    expect(matchStepIndex("Set up job", steps)).toBeUndefined();
  });

  it("prefix-matches a sparse step path to the topmost source line", () => {
    const loc = resolvePath(map, "jobs.build.steps.0");
    expect(loc).toEqual({ file: ".github/actio/ci.actio.yml", line: 18, col: 9 });
  });

  it("prefix-matches a job path to its first mapped child", () => {
    const loc = resolvePath(map, "jobs.build");
    expect(loc?.line).toBe(18);
  });

  it("returns undefined for an unmapped construct", () => {
    expect(resolvePath(map, "jobs.missing")).toBeUndefined();
  });
});
