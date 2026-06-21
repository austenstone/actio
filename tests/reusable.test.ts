import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Transpile and parse the generated YAML back to a JS object for assertions. */
function build(source: string, validate = true) {
  const result = transpile(source, { fileName: "t.actio.yml", validate });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  return { result, errors, warnings, doc: result.ok ? parse(result.yaml) : undefined };
}

const hasCode = (diags: ReadonlyArray<{ code?: string }>, code: string): boolean =>
  diags.some((d) => d.code === code);

describe("reusable", () => {
  it("emits both triggers and derives dispatch inputs from shared inputs", () => {
    const { doc, errors } = build(`name: x
on:
  push:
    branches: [main]
reusable:
  inputs:
    target:
      type: string
      required: true
    flag:
      type: boolean
      default: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "to \${{ inputs.target }}"
`);
    expect(errors).toEqual([]);
    expect(doc.reusable).toBeUndefined();
    // existing trigger preserved
    expect(doc.on.push).toEqual({ branches: ["main"] });
    // workflow_call carries the declared inputs
    expect(doc.on.workflow_call.inputs).toEqual({
      target: { type: "string", required: true },
      flag: { type: "boolean", default: false },
    });
    // workflow_dispatch inputs are derived (DRY), a separate object
    expect(doc.on.workflow_dispatch.inputs).toEqual(doc.on.workflow_call.inputs);
    expect(doc.on.workflow_dispatch.inputs).not.toBe(doc.on.workflow_call.inputs);
  });

  it("copies secrets and outputs onto workflow_call only", () => {
    const { doc, errors } = build(`name: x
on: push
reusable:
  inputs:
    a: { type: string }
  secrets:
    token:
      required: true
  outputs:
    url:
      value: \${{ jobs.j.outputs.url }}
jobs:
  j:
    runs-on: ubuntu-latest
    outputs:
      url: \${{ steps.s.outputs.url }}
    steps:
      - id: s
        run: echo hi
`);
    expect(errors).toEqual([]);
    expect(doc.on.workflow_call.secrets).toEqual({ token: { required: true } });
    expect(doc.on.workflow_call.outputs).toEqual({ url: { value: "${{ jobs.j.outputs.url }}" } });
    expect(doc.on.workflow_dispatch.secrets).toBeUndefined();
  });

  it("defaults an input type to string when omitted", () => {
    const { doc, errors } = build(`name: x
on: push
reusable:
  inputs:
    bare: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ inputs.bare }}
`);
    expect(errors).toEqual([]);
    expect(doc.on.workflow_call.inputs.bare).toEqual({ type: "string" });
    expect(doc.on.workflow_dispatch.inputs.bare).toEqual({ type: "string" });
  });

  it("normalizes the dispatch-only footgun to the canonical inputs form", () => {
    const { doc, errors } = build(`name: x
on: push
reusable:
  inputs:
    target: { type: string }
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "named \${{ github.event.inputs.target }}"
          echo "object \${{ toJSON(github.event.inputs) }}"
`);
    expect(errors).toEqual([]);
    const run = doc.jobs.j.steps[0].run as string;
    expect(run).toContain("${{ inputs.target }}");
    expect(run).toContain("${{ toJSON(inputs) }}");
    expect(run).not.toContain("github.event.inputs");
  });

  it("rewrites a bare inputs object even with a trailing dot", () => {
    const { doc, errors } = build(
      `name: x
on: push
reusable:
  inputs:
    target: { type: string }
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "dot \${{ github.event.inputs. }}"
`,
      false,
    );
    expect(errors).toEqual([]);
    const run = doc.jobs.j.steps[0].run as string;
    expect(run).toContain("${{ inputs. }}");
    expect(run).not.toContain("github.event");
  });

  it("leaves quoted literals and lookalike identifiers untouched", () => {
    const { result, errors } = build(`name: x
on: push
reusable:
  inputs:
    target: { type: string }
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.inputsX }} keep"
      - run: echo "\${{ 'github.event.inputs.kept' }} keep"
`);
    expect(errors).toEqual([]);
    // A later hoist pass may move raw expressions into env:, so assert on the
    // full emission rather than the inlined run.
    expect(result.yaml).toContain("github.event.inputsX");
    expect(result.yaml).toContain("'github.event.inputs.kept'");
  });

  it("warns when a normalized reference is not declared", () => {
    const { warnings, errors } = build(`name: x
on: push
reusable:
  inputs:
    known: { type: string }
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ github.event.inputs.unknown }}
`);
    expect(errors).toEqual([]);
    expect(hasCode(warnings, "reusable-input-undeclared")).toBe(true);
  });

  it("does not rewrite a chain that is a property of another object", () => {
    const { doc, errors } = build(`name: x
on: push
reusable:
  inputs:
    target: { type: string }
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ needs.github.event.inputs.target }}
`);
    expect(errors).toEqual([]);
    // The leading `needs.` makes github a property access, not a context root.
    expect(doc.jobs.j.steps[0].run).toContain("needs.github.event.inputs.target");
  });

  it("supports dispatch: false for a call-only workflow that still normalizes", () => {
    const { doc, errors } = build(`name: x
on: push
reusable:
  dispatch: false
  inputs:
    target: { type: string }
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ github.event.inputs.target }}
`);
    expect(errors).toEqual([]);
    expect(doc.on.workflow_call).toBeDefined();
    expect("workflow_dispatch" in doc.on).toBe(false);
    expect(doc.jobs.j.steps[0].run).toContain("${{ inputs.target }}");
  });

  it("emits null trigger bodies when no inputs are declared", () => {
    const { doc, errors } = build(`name: x
on: push
reusable: {}
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(errors).toEqual([]);
    expect(doc.on.workflow_call).toBeNull();
    expect(doc.on.workflow_dispatch).toBeNull();
  });

  it("coerces every on: shape into an event object", () => {
    const stringForm = build(`name: x
on: push
reusable: {}
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
    expect(stringForm.errors).toEqual([]);
    expect("push" in stringForm.doc.on).toBe(true);

    const arrayForm = build(`name: x
on: [push, pull_request]
reusable: {}
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
    expect(arrayForm.errors).toEqual([]);
    expect("push" in arrayForm.doc.on).toBe(true);
    expect("pull_request" in arrayForm.doc.on).toBe(true);

    const noTrigger = build(`name: x
reusable: {}
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
    expect(noTrigger.errors).toEqual([]);
    expect(noTrigger.doc.on.workflow_call).toBeNull();
  });

  it("ignores non-string entries in an array on:", () => {
    const { doc, errors } = build(
      `name: x
on: [push, 5]
reusable: {}
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`,
      false,
    );
    expect(errors).toEqual([]);
    expect("push" in doc.on).toBe(true);
  });

  it("leaves an unterminated expression verbatim", () => {
    const { doc, errors } = build(
      `name: x
on: push
reusable:
  inputs:
    target: { type: string }
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: echo \${{ github.event.inputs.target
`,
      false,
    );
    expect(errors).toEqual([]);
    expect(doc.jobs.j.steps[0].run).toContain("${{ github.event.inputs.target");
  });

  describe("conflicts and errors", () => {
    it("errors on a hand-written workflow_call", () => {
      const { result } = build(`name: x
on:
  workflow_call:
    inputs:
      a: { type: string }
reusable:
  inputs:
    a: { type: string }
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
      expect(result.ok).toBe(false);
      expect(hasCode(result.diagnostics, "reusable-trigger-conflict")).toBe(true);
    });

    it("errors on a hand-written workflow_dispatch when dispatch is on", () => {
      const { result } = build(`name: x
on:
  workflow_dispatch: {}
reusable:
  inputs:
    a: { type: string }
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
      expect(result.ok).toBe(false);
      expect(hasCode(result.diagnostics, "reusable-trigger-conflict")).toBe(true);
    });

    it("allows a hand-written workflow_dispatch when dispatch is off", () => {
      const { doc, errors } = build(`name: x
on:
  workflow_dispatch:
    inputs:
      manual: { type: string }
reusable:
  dispatch: false
  inputs:
    a: { type: string }
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
      expect(errors).toEqual([]);
      expect(doc.on.workflow_dispatch.inputs.manual).toBeDefined();
      expect(doc.on.workflow_call).toBeDefined();
    });

    it("errors when reusable is not a mapping", () => {
      const { result } = build(`name: x
on: push
reusable: nope
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
      expect(result.ok).toBe(false);
      expect(hasCode(result.diagnostics, "reusable-shape")).toBe(true);
    });

    it("errors on an unknown reusable key", () => {
      const { result } = build(`name: x
on: push
reusable:
  bogus: true
  inputs:
    a: { type: string }
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
      expect(result.ok).toBe(false);
      expect(hasCode(result.diagnostics, "reusable-unknown-key")).toBe(true);
    });

    it("errors when dispatch is not a boolean", () => {
      const { result } = build(`name: x
on: push
reusable:
  dispatch: maybe
  inputs:
    a: { type: string }
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
      expect(result.ok).toBe(false);
      expect(hasCode(result.diagnostics, "reusable-dispatch-type")).toBe(true);
    });

    it("errors when inputs is not a mapping", () => {
      const { result } = build(`name: x
on: push
reusable:
  inputs: nope
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
      expect(result.ok).toBe(false);
      expect(hasCode(result.diagnostics, "reusable-inputs-shape")).toBe(true);
    });

    it("errors when an input definition is not a mapping", () => {
      const { result } = build(`name: x
on: push
reusable:
  inputs:
    a: nope
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
      expect(result.ok).toBe(false);
      expect(hasCode(result.diagnostics, "reusable-input-shape")).toBe(true);
    });

    it("errors on a workflow_dispatch-only input type", () => {
      const { result } = build(`name: x
on: push
reusable:
  inputs:
    a: { type: choice }
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
      expect(result.ok).toBe(false);
      expect(hasCode(result.diagnostics, "reusable-input-type")).toBe(true);
    });

    it("errors when secrets is not a mapping", () => {
      const { result } = build(`name: x
on: push
reusable:
  inputs:
    a: { type: string }
  secrets: nope
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
      expect(result.ok).toBe(false);
      expect(hasCode(result.diagnostics, "reusable-secrets-shape")).toBe(true);
    });

    it("errors when outputs is not a mapping", () => {
      const { result } = build(`name: x
on: push
reusable:
  inputs:
    a: { type: string }
  outputs: nope
jobs:
  j: { runs-on: ubuntu-latest, steps: [{ run: echo }] }
`);
      expect(result.ok).toBe(false);
      expect(hasCode(result.diagnostics, "reusable-outputs-shape")).toBe(true);
    });
  });

  it("handles GHA string-literal quote escapes without rewriting inside them", () => {
    const { doc, errors } = build(
      `name: x
on: push
reusable:
  inputs:
    a: { type: string }
jobs:
  j:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo \${{ 'a''b' }}
          echo \${{ "x\\"y" }}
`,
      false,
    );
    expect(errors).toEqual([]);
    const run = doc.jobs.j.steps[0].run as string;
    expect(run).toContain("'a''b'");
    expect(run).toContain('"x\\"y"');
  });
});
