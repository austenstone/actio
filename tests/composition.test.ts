import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Transpile and parse the generated YAML back to a JS object for assertions. */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml" });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  return { result, errors, doc: result.ok ? parse(result.yaml) : undefined };
}

/** Normalize a job `needs` (string | string[] | undefined) to an array. */
function needsOf(job: { needs?: string | string[] }): string[] {
  if (job?.needs == null) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

describe("composition: dynamic_matrix setup job context", () => {
  it("the setup job inherits the target job's needs so the matrix script can read upstream outputs", () => {
    // The matrix-generating script references needs.build.outputs.shards. That
    // script runs in the generated actio_setup_test job, so that job must list
    // `build` in its own `needs` for the expression to resolve. Otherwise the
    // setup script silently sees an empty value.
    const { doc, errors } = build(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      shards: \${{ steps.gen.outputs.shards }}
    steps:
      - id: gen
        run: echo "shards=3" >> "$GITHUB_OUTPUT"
  test:
    needs: build
    runs-on: ubuntu-latest
    dynamic_matrix:
      script: echo "[$(seq -s, 1 \${{ needs.build.outputs.shards }})]"
    steps:
      - run: echo \${{ matrix.value }}
`);
    expect(errors).toEqual([]);
    const setup = doc.jobs.actio_setup_test;
    expect(setup).toBeDefined();
    // The setup job runs `needs.build.outputs.shards`; it must depend on `build`.
    expect(needsOf(setup)).toContain("build");
  });

  it("the setup job inherits the target job's env so the matrix script can read job-level vars", () => {
    // The script uses $SHARDS, defined as job-level env. After dynamic_matrix
    // splits the job, the script lives in actio_setup_test, so that job must
    // carry the env or $SHARDS expands to nothing.
    const { doc, errors } = build(`name: x
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      SHARDS: "3"
    dynamic_matrix:
      script: echo "[$(seq -s, 1 $SHARDS)]"
    steps:
      - run: echo hi
`);
    expect(errors).toEqual([]);
    const setup = doc.jobs.actio_setup_test;
    expect(setup).toBeDefined();
    expect(setup.env).toBeDefined();
    expect(setup.env.SHARDS).toBe("3");
  });
});
