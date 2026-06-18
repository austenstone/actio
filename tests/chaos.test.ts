import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * Transpile with output validation (GitHub's official @actions/workflow-parser)
 * and parse the generated YAML back for assertions. `schemaErrors` surfaces the
 * gold signal: actio emitting schema-invalid GitHub Actions YAML.
 */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml", validate: true });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const schemaErrors = errors.filter((d) => d.source === "schema");
  return { result, errors, schemaErrors, doc: result.ok ? parse(result.yaml) : undefined };
}

// Bug E: retry drops a falsy non-string `if` on the first attempt.
// The schema explicitly allows `if` to be a boolean/number (step def: ["string","boolean","number"]).
// `if: false` means "never run", but retry only carries forward string conditions, so the first
// attempt is emitted with NO `if` and `continue-on-error: true` -> it runs unconditionally and the
// never-run gate is silently lost.
describe("Bug E: retry drops a falsy boolean `if` gate", () => {
  it("keeps the `if: false` gate on the first retry attempt", () => {
    const { doc, schemaErrors } = build(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        if: false
        retry: 2
`);
    expect(schemaErrors).toEqual([]);
    const first = doc.jobs.a.steps[0];
    // A step gated `if: false` must never run; the first attempt must remain gated
    // instead of being emitted with no condition (which makes it run unconditionally).
    expect(first).toHaveProperty("if");
  });

  it("keeps the falsy `if: 0` gate on the first retry attempt", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        if: 0
        retry: 2
`);
    expect(doc.jobs.a.steps[0]).toHaveProperty("if");
  });
});

// Bug F: dynamic_matrix drops a boolean job-level `if`.
// `combineIf` keeps only string conditions, so a job's `if: false` (schema allows job `if` to be
// boolean/number) is discarded when the empty-matrix guard is combined in. The generated job `if`
// becomes just the matrix guard, so a job the user gated off now runs whenever the matrix is non-empty.
describe("Bug F: dynamic_matrix drops a boolean job `if` gate", () => {
  it("preserves the original `if: false` gate on the matrix-consuming job", () => {
    const { doc } = build(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    if: false
    dynamic_matrix:
      script: echo '["x"]'
    steps:
      - run: echo \${{ matrix }}
`);
    // The user's never-run gate must survive into the generated condition.
    expect(String(doc.jobs.a.if)).toContain("false");
  });
});

// Bug G: macros nested inside a `fallback` block are not expanded.
// The fragments pass descends into fallback blocks, but the retry and fallback passes only walk a
// job's top-level `steps`. The schema allows a fallback step to be a full step (with `retry`/`fallback`),
// so a `retry:`/`fallback:` key inside a fallback block leaks verbatim into the output, producing
// schema-invalid GitHub Actions YAML with no diagnostic.
describe("Bug G: macros nested in a fallback block leak into the output", () => {
  it("expands `retry` on a step inside a step-level fallback block", () => {
    const { result, schemaErrors } = build(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        fallback:
          steps:
            - run: echo recover
              retry: 2
          recover: true
`);
    expect(schemaErrors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("expands `retry` on a step inside a job-level fallback block", () => {
    const { result, schemaErrors } = build(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
    fallback:
      - run: echo notify
        retry: 2
`);
    expect(schemaErrors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("expands a nested `fallback` on a step inside a fallback block", () => {
    const { result, schemaErrors } = build(`name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        fallback:
          steps:
            - run: echo recover
              fallback:
                steps:
                  - run: echo deep
                recover: true
          recover: true
`);
    expect(schemaErrors).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
