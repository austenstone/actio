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

// Bug I (numeric variant): retry drops a falsy *numeric* `if` on the first attempt.
// The schema allows `if` to be a number (step def: ["string","boolean","number"]). The boolean
// `if: false` case is covered in expressions.test.ts; this asserts the same defect for `if: 0`,
// which retry likewise discards, emitting the first attempt with no condition so it runs anyway.
describe("Bug I (numeric variant): retry drops a falsy `if: 0` gate", () => {
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
