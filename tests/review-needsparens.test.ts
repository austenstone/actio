import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { combineIf } from "../packages/core/src/passes/helpers.js";

/** Transpile with the official workflow parser validating the output. */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml", validate: true });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  return { result, errors, doc: result.ok ? parse(result.yaml) : undefined };
}

describe("needsParens: string-literal aware paren scanning (B1 regression)", () => {
  // A `)` inside a GitHub-expression string literal must not corrupt the
  // paren-depth scanner. Otherwise a real top-level `||` is seen at depth != 0
  // and left unwrapped, so the appended `&& guard` mis-associates.
  it("wraps a top-level || when an unbalanced paren lives inside a literal", () => {
    const cond = "github.ref == 'refs/heads/x)' || github.event_name == 'push'";
    expect(combineIf("failure()", cond)).toBe(`failure() && (${cond})`);
  });

  // A `||` that only appears inside a string literal is not a top-level
  // operator and must NOT be wrapped.
  it("does not over-wrap a || that lives inside a string literal", () => {
    expect(combineIf("failure()", "inputs.x == 'a||b'")).toBe("failure() && inputs.x == 'a||b'");
  });

  it("handles doubled-quote ('') escapes inside literals", () => {
    // The escaped quote keeps us in-string, so the closing paren stays ignored.
    const cond = "inputs.msg == 'it''s (done)' || failure()";
    expect(combineIf("success()", cond)).toBe(`success() && (${cond})`);
  });

  it("end-to-end: fallback recover guard wraps the unbalanced-paren || correctly", () => {
    const { doc, errors } = build(`name: x
on: [push]
jobs:
  d:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        run: ./build.sh
        fallback:
          - name: Recover
            if: github.ref == 'refs/heads/x)' || github.event_name == 'push'
            run: ./recover.sh
`);
    expect(errors).toEqual([]);
    const steps = doc.jobs.d.steps;
    expect(steps[1].if).toBe(
      "failure() && steps.step_build.conclusion == 'failure' && (github.ref == 'refs/heads/x)' || github.event_name == 'push')",
    );
  });
});
