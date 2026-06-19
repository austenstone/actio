import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Failing tests that pin down genuine actio bugs. Each test asserts the
 * behavior a correct transpiler should produce; they fail against the current
 * implementation. Do not "fix" the tests — fix the compiler.
 */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml", validate: true });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  return { result, errors, doc: result.ok ? parse(result.yaml) : undefined };
}

describe("BUG: YAML merge keys (<<) are not resolved", () => {
  it("expands a job merge anchor into valid plain YAML", () => {
    const { result, errors, doc } = build(`on: [push]
jobs:
  a: &job
    runs-on: ubuntu-latest
    steps:
      - run: echo a
  b:
    <<: *job
    steps:
      - run: echo b
`);
    // GitHub Actions does not support YAML merge keys, so the compiled output
    // must be plain expanded YAML. Currently actio keeps `<<` literal and
    // re-emits the `&job` anchor, producing output the GHA schema rejects
    // ("Unexpected value '<<'", "Required property is missing: runs-on").
    expect(errors).toEqual([]);
    expect(doc?.jobs.b["runs-on"]).toBe("ubuntu-latest");
    expect(result.yaml).not.toContain("<<");
    expect(result.yaml).not.toMatch(/&\w/);
  });
});

describe("BUG: retry discards a step's explicit id", () => {
  it("keeps the explicit id so later steps can reference it", () => {
    const { doc } = build(`on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - id: build
        run: echo "v=1" >> $GITHUB_OUTPUT
        retry: 2
      - run: echo "\${{ steps.build.outputs.v }}"
`);
    // The next step references steps.build.outputs.v, but retry renames the
    // step to step_<slug>_attempt_n and drops the `build` id entirely, so the
    // reference silently resolves to nothing.
    const ids = doc.jobs.j.steps.map((s: { id?: string }) => s.id).filter(Boolean);
    expect(ids).toContain("build");
  });

  it("keeps the id reachable from job-level outputs", () => {
    const { doc } = build(`on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    outputs:
      v: \${{ steps.build.outputs.v }}
    steps:
      - id: build
        run: echo "v=1" >> $GITHUB_OUTPUT
        retry: 2
`);
    // job.outputs.v points at steps.build, but after retry no step carries the
    // `build` id, so the job output is permanently empty.
    const ids = doc.jobs.j.steps.map((s: { id?: string }) => s.id).filter(Boolean);
    expect(ids).toContain("build");
  });

  it("keeps the id on a retried action (uses) step", () => {
    const { doc } = build(`on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - id: setup
        uses: actions/setup-node@v4
        retry: 2
      - run: echo "\${{ steps.setup.outcome }}"
`);
    const ids = doc.jobs.j.steps.map((s: { id?: string }) => s.id).filter(Boolean);
    expect(ids).toContain("setup");
  });
});

describe("BUG: job-level fallback on a reusable-workflow (uses) job", () => {
  it("does not emit a job with both uses and steps", () => {
    const { errors, doc } = build(`on: [push]
jobs:
  call:
    uses: ./.github/workflows/reusable.yml
    fallback:
      steps:
        - run: echo notify
`);
    // A reusable-workflow job cannot also define steps. Actio appends the
    // fallback steps anyway, producing schema-invalid output ("Unexpected
    // value 'steps'") with no diagnostic of its own.
    expect(errors).toEqual([]);
    const job = doc?.jobs.call as { uses?: string; steps?: unknown[] } | undefined;
    expect(job?.uses !== undefined && job?.steps !== undefined).toBe(false);
  });
});

describe("BUG: dynamic-matrix id override is ignored", () => {
  it("names the generated setup job using the provided id", () => {
    const { doc } = build(`on: [push]
jobs:
  j:
    runs-on: ubuntu-latest
    dynamic-matrix:
      script: echo '["a"]'
      alias: x
      id: gen
    steps:
      - run: echo "\${{ matrix.x }}"
`);
    // The schema documents dynamic-matrix.id as "Override the generated setup
    // job id", but the pass hardcodes actio_setup_<jobId> for the job name,
    // needs, matrix expression, and guard.
    expect(Object.keys(doc.jobs)).toContain("gen");
    expect(doc.jobs.j.needs).toContain("gen");
    expect(doc.jobs.j.strategy.matrix.x).toContain("needs.gen.outputs.matrix");
  });
});
