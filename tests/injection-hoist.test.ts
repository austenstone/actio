import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Transpile and parse the generated YAML back to a JS object for assertions. */
function build(source: string, options: Record<string, unknown> = {}) {
  const result = transpile(source, { fileName: "t.actio.yml", ...options });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  return { result, errors, warnings, doc: result.ok ? parse(result.yaml) : undefined };
}

/** Wrap a single job's steps around a shared header so tests stay terse. */
function wf(steps: string): string {
  return `name: x
on: [pull_request]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
${steps}
`;
}

function step0(doc: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: test helper reaching into parsed YAML
  return (doc as any).jobs.a.steps[0];
}

describe("injection-hoist", () => {
  it('hoists github.event.* in a bash run: into env and rewrites body to "$VAR"', () => {
    const { doc, errors } = build(wf("      - run: echo ${{ github.event.pull_request.title }}"));
    expect(errors).toEqual([]);
    const step = step0(doc);
    expect(step.env).toEqual({ PR_TITLE: "${{ github.event.pull_request.title }}" });
    expect(step.run).toBe('echo "$PR_TITLE"');
  });

  it("rewrites an interpolation already inside double quotes to bare $VAR", () => {
    const { doc, errors } = build(
      wf(`      - run: |
          echo "PR title: \${{ github.event.pull_request.title }}"`),
    );
    expect(errors).toEqual([]);
    const step = step0(doc);
    expect(step.env).toEqual({ PR_TITLE: "${{ github.event.pull_request.title }}" });
    expect(step.run.trim()).toBe('echo "PR title: $PR_TITLE"');
  });

  it("emits env before run in the generated step", () => {
    const { doc } = build(wf("      - run: echo ${{ github.event.pull_request.title }}"));
    expect(Object.keys(step0(doc))).toEqual(["env", "run"]);
  });

  it("rewrites pwsh interpolation to $env:VAR", () => {
    const { doc, errors } = build(
      wf(`      - shell: pwsh
        run: Write-Output \${{ github.event.pull_request.title }}`),
    );
    expect(errors).toEqual([]);
    const step = step0(doc);
    expect(step.env).toEqual({ PR_TITLE: "${{ github.event.pull_request.title }}" });
    expect(step.run).toBe('Write-Output "$env:PR_TITLE"');
  });

  it("hoists env for python but leaves the body unchanged with a warning", () => {
    const { doc, warnings, errors } = build(
      wf(`      - shell: python
        run: |
          import os
          print("\${{ github.event.pull_request.title }}")`),
    );
    expect(errors).toEqual([]);
    const step = step0(doc);
    expect(step.env).toEqual({ PR_TITLE: "${{ github.event.pull_request.title }}" });
    // body is NOT rewritten — the raw interpolation is preserved verbatim.
    expect(step.run).toContain('print("${{ github.event.pull_request.title }}")');
    expect(warnings.some((w) => w.code === "injection-hoist-python")).toBe(true);
  });

  it("errors on a quoted heredoc that would need hoisting", () => {
    const { errors } = build(
      wf(`      - run: |
          cat <<'EOF'
          \${{ github.event.pull_request.title }}
          EOF`),
    );
    expect(errors.some((e) => e.code === "injection-hoist-quoted-heredoc")).toBe(true);
  });

  it("hoists an unquoted heredoc safely", () => {
    const { doc, errors } = build(
      wf(`      - run: |
          cat <<EOF
          \${{ github.event.pull_request.title }}
          EOF`),
    );
    expect(errors).toEqual([]);
    expect(step0(doc).env).toEqual({ PR_TITLE: "${{ github.event.pull_request.title }}" });
  });

  it("hoists github.ref_name unconditionally", () => {
    const { doc } = build(wf("      - run: echo ${{ github.ref_name }}"));
    const step = step0(doc);
    expect(step.env).toEqual({ REF_NAME: "${{ github.ref_name }}" });
    expect(step.run).toBe('echo "$REF_NAME"');
  });

  it("hoists github.head_ref unconditionally", () => {
    const { doc } = build(wf("      - run: echo ${{ github.head_ref }}"));
    const step = step0(doc);
    expect(step.env).toEqual({ HEAD_REF: "${{ github.head_ref }}" });
    expect(step.run).toBe('echo "$HEAD_REF"');
  });

  it("does NOT hoist trusted github.sha", () => {
    const { doc } = build(wf("      - run: echo ${{ github.sha }}"));
    const step = step0(doc);
    expect(step.env).toBeUndefined();
    expect(step.run).toBe("echo ${{ github.sha }}");
  });

  it("does NOT hoist a structural github.event leaf (number)", () => {
    const { doc } = build(wf("      - run: echo ${{ github.event.pull_request.number }}"));
    const step = step0(doc);
    expect(step.env).toBeUndefined();
    expect(step.run).toBe("echo ${{ github.event.pull_request.number }}");
  });

  it("skips a step marked unsafe: true and strips the knob", () => {
    const { doc } = build(
      wf(`      - unsafe: true
        run: echo \${{ github.event.pull_request.title }}`),
    );
    const step = step0(doc);
    expect(step.env).toBeUndefined();
    expect(step.unsafe).toBeUndefined();
    expect(step.run).toBe("echo ${{ github.event.pull_request.title }}");
  });

  it("honors a trust: list to inline an otherwise-untrusted path", () => {
    const { doc } = build(
      wf(`      - trust: [github.event.pull_request.title]
        run: echo \${{ github.event.pull_request.title }}`),
    );
    const step = step0(doc);
    expect(step.env).toBeUndefined();
    expect(step.trust).toBeUndefined();
    expect(step.run).toBe("echo ${{ github.event.pull_request.title }}");
  });

  it("honors a force: list to hoist an otherwise-trusted path", () => {
    const { doc } = build(
      wf(`      - force: [github.sha]
        run: echo \${{ github.sha }}`),
    );
    const step = step0(doc);
    expect(step.env).toEqual({ SHA: "${{ github.sha }}" });
    expect(step.force).toBeUndefined();
    expect(step.run).toBe('echo "$SHA"');
  });

  it("leaves share.* tokens untouched (deferred to the #18 share macro)", () => {
    // Until #18 (share) merges, the workflow-parser rejects `share` as an unknown
    // named-value — that schema error is the expected seam. What matters here is
    // that injection-hoist defensively skipped it: no injection-hoist diagnostic,
    // and the only error is the downstream "Unrecognized named-value" one.
    const { result } = build(wf("      - run: echo ${{ share.foo }}"));
    expect(result.diagnostics.some((d) => d.code?.startsWith("injection-hoist"))).toBe(false);
    expect(
      result.diagnostics.some((d) => /unrecognized named-value: 'share'/i.test(d.message)),
    ).toBe(true);
  });

  it("hoists an untrusted token but leaves a co-located share.* token for #18", () => {
    const { result } = build(
      wf("      - run: echo ${{ github.event.pull_request.title }} ${{ share.foo }}"),
    );
    // injection-hoist must not have flagged or rewritten the share token itself.
    expect(result.diagnostics.some((d) => d.code?.startsWith("injection-hoist"))).toBe(false);
    expect(
      result.diagnostics.some((d) => /unrecognized named-value: 'share'/i.test(d.message)),
    ).toBe(true);
  });

  it("does not hoist interpolations outside run: (name/if)", () => {
    const { doc } = build(
      wf(`      - name: \${{ github.event.pull_request.title }}
        if: github.event.pull_request.title != ''
        run: echo hello`),
    );
    const step = step0(doc);
    expect(step.env).toBeUndefined();
    expect(step.name).toBe("${{ github.event.pull_request.title }}");
    expect(step.run).toBe("echo hello");
  });

  it("deduplicates repeated identical occurrences into one env var", () => {
    const { doc } = build(
      wf(`      - run: |
          echo \${{ github.event.pull_request.title }}
          echo \${{ github.event.pull_request.title }}`),
    );
    const step = step0(doc);
    expect(step.env).toEqual({ PR_TITLE: "${{ github.event.pull_request.title }}" });
    expect(step.run.trim()).toBe('echo "$PR_TITLE"\necho "$PR_TITLE"');
  });

  it("falls back to a qualified name when a step env already binds the preferred name", () => {
    const { doc } = build(
      wf(`      - env:
          PR_TITLE: something-else
        run: echo \${{ github.event.pull_request.title }}`),
    );
    const step = step0(doc);
    expect(step.env.PR_TITLE).toBe("something-else");
    expect(step.env.ACTIO_PULL_REQUEST_TITLE).toBe("${{ github.event.pull_request.title }}");
    expect(step.run).toBe('echo "$ACTIO_PULL_REQUEST_TITLE"');
  });

  it("mode off skips hoisting entirely", () => {
    const { doc } = build(
      wf(`      - injectionHoist: off
        run: echo \${{ github.event.pull_request.title }}`),
    );
    const step = step0(doc);
    expect(step.env).toBeUndefined();
    expect(step.injectionHoist).toBeUndefined();
    expect(step.run).toBe("echo ${{ github.event.pull_request.title }}");
  });

  it("mode warn diagnoses without mutating", () => {
    const { doc, warnings } = build(
      wf(`      - injectionHoist: warn
        run: echo \${{ github.event.pull_request.title }}`),
    );
    const step = step0(doc);
    expect(step.env).toBeUndefined();
    expect(step.run).toBe("echo ${{ github.event.pull_request.title }}");
    expect(warnings.some((w) => w.code === "injection-hoist-untrusted")).toBe(true);
  });

  it("mode error raises a diagnostic without mutating", () => {
    const { doc, errors } = build(
      wf(`      - injectionHoist: error
        run: echo \${{ github.event.pull_request.title }}`),
    );
    expect(errors.some((e) => e.code === "injection-hoist-untrusted")).toBe(true);
    // even on error the body is preserved (drift is self-healing, never destructive)
    if (doc) expect(step0(doc).run).toBe("echo ${{ github.event.pull_request.title }}");
  });

  it("warns and falls back to fix on an invalid mode value", () => {
    const { doc, warnings } = build(
      wf(`      - injectionHoist: loud
        run: echo \${{ github.event.pull_request.title }}`),
    );
    expect(warnings.some((w) => w.code === "injection-hoist-mode-invalid")).toBe(true);
    expect(step0(doc).env).toEqual({ PR_TITLE: "${{ github.event.pull_request.title }}" });
  });

  it("errors on nested interpolation", () => {
    const { errors } = build(
      wf("      - run: echo ${{ foo(${{ github.event.pull_request.title }}) }}"),
    );
    expect(errors.some((e) => e.code === "injection-hoist-nested")).toBe(true);
  });

  it("a global default mode of off disables the pass", () => {
    const { doc } = build(wf("      - run: echo ${{ github.event.pull_request.title }}"), {
      injectionHoist: "off",
    });
    expect(step0(doc).env).toBeUndefined();
  });

  it("a job-level injectionHoist overrides the global default", () => {
    const { doc } = build(`name: x
on: [pull_request]
jobs:
  a:
    runs-on: ubuntu-latest
    injectionHoist: off
    steps:
      - run: echo \${{ github.event.pull_request.title }}
`);
    expect(step0(doc).env).toBeUndefined();
    // job knob stripped from emitted YAML
    // biome-ignore lint/suspicious/noExplicitAny: parsed YAML
    expect((step0(doc) as any).injectionHoist).toBeUndefined();
  });
});
