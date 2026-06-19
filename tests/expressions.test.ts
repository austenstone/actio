import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Transpile with the official workflow parser validating the output. */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml", validate: true });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  return { result, errors, doc: result.ok ? parse(result.yaml) : undefined };
}

describe("expression precedence in combined if:", () => {
  // BUG: combineIf's needsParens uses /\s\|\|\s/, so it only parenthesizes a
  // user `||` when it has whitespace on BOTH sides. GitHub expressions allow
  // `a||b` with no spaces, so the user condition is left bare and the macro's
  // `&& <guard>` binds tighter than `||`:
  //   guard && inputs.a||inputs.b  =>  (guard && inputs.a) || inputs.b
  // When inputs.b is truthy the job runs even though the matrix guard is false
  // (e.g. an empty matrix). The user's `||` must be grouped so the guard applies
  // to the whole condition, exactly like the spaced form already is.
  it("parenthesizes a spaceless || so the dynamic-matrix guard binds", () => {
    const { doc, errors } = build(`name: x
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    if: inputs.a||inputs.b
    dynamic-matrix:
      script: echo '["x"]'
    steps:
      - run: echo hi
`);
    expect(errors).toEqual([]);
    const guard =
      "needs.actio_setup_build.outputs.matrix != '[]' && needs.actio_setup_build.outputs.matrix != ''";
    expect(doc.jobs.build.if).toBe(`${guard} && (inputs.a||inputs.b)`);
  });

  // Same root cause via retry, with the user condition as the FIRST operand:
  //   inputs.a||inputs.b && steps.<id>.outcome == 'failure'
  // parses as inputs.a || (inputs.b && <guard>), so attempt 2 runs whenever
  // inputs.a is truthy, regardless of whether attempt 1 actually failed.
  it("parenthesizes a spaceless || when retry appends its outcome guard", () => {
    const { doc, errors } = build(`name: x
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: main
        run: echo hi
        if: inputs.a||inputs.b
        retry: 2
`);
    expect(errors).toEqual([]);
    const attempt2 = doc.jobs.build.steps[1];
    expect(attempt2.if).toBe(
      "(inputs.a||inputs.b) && steps.step_main_attempt_1.outcome == 'failure'",
    );
  });
});

describe("boolean if: false is preserved when macros combine guards", () => {
  // BUG: combineIf filters its operands to `typeof c === "string"`, so a YAML
  // boolean `if: false` (a perfectly valid way to disable a step/job) is
  // silently dropped. retry then emits attempt 1 with NO `if` at all, so a step
  // the user explicitly disabled now runs unconditionally.
  it("keeps a disabled (if: false) retried step from running", () => {
    const { doc, errors } = build(`name: x
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: main
        run: echo hi
        if: false
        retry: 2
`);
    expect(errors).toEqual([]);
    // The first attempt must still be gated by the user's `false` guard.
    expect(doc.jobs.build.steps[0].if).toBe(false);
  });

  // Same drop via dynamic-matrix: the user's `if: false` vanishes and the job's
  // generated `if` is only the empty-matrix guard, so the disabled job runs
  // whenever the matrix is non-empty.
  it("keeps a disabled (if: false) dynamic-matrix job from running", () => {
    const { doc, errors } = build(`name: x
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    if: false
    dynamic-matrix:
      script: echo '["x"]'
    steps:
      - run: echo hi
`);
    expect(errors).toEqual([]);
    // The combined condition must still encode the user's `false`.
    expect(String(doc.jobs.build.if)).toContain("false");
  });
});
