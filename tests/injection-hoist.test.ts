import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Transpile and parse the generated YAML back to a JS object for assertions. */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml" });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  return { result, errors, warnings, doc: result.ok ? parse(result.yaml) : undefined };
}

function step0(doc: unknown) {
  return (doc as { jobs: { a: { steps: Record<string, unknown>[] } } }).jobs.a.steps[0];
}

const wrap = (steps: string) => `name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
${steps}`;

describe("injection-hoist: untrusted hoisting", () => {
  it("hoists github.event.* in a bash run body and quotes the shell var", () => {
    const { doc, errors } = build(
      wrap(`      - run: echo "Title is \${{ github.event.issue.title }}"`),
    );
    expect(errors).toEqual([]);
    const s = step0(doc);
    expect(s.env).toEqual({ ISSUE_TITLE: "${{ github.event.issue.title }}" });
    expect(s.run).toBe('echo "Title is $ISSUE_TITLE"');
  });

  it("hoists github.event.pull_request.title to PR_TITLE", () => {
    const { doc, errors } = build(
      wrap(`      - run: echo "\${{ github.event.pull_request.title }}"`),
    );
    expect(errors).toEqual([]);
    const s = step0(doc);
    expect(s.env).toEqual({ PR_TITLE: "${{ github.event.pull_request.title }}" });
    expect(s.run).toContain('"$PR_TITLE"');
  });

  it("hoists github.ref_name unconditionally", () => {
    const { doc, errors } = build(wrap(`      - run: git checkout \${{ github.ref_name }}`));
    expect(errors).toEqual([]);
    const s = step0(doc);
    expect(s.env).toEqual({ REF_NAME: "${{ github.ref_name }}" });
    expect(s.run).toBe('git checkout "$REF_NAME"');
  });

  it("hoists github.head_ref unconditionally", () => {
    const { doc, errors } = build(wrap(`      - run: echo \${{ github.head_ref }}`));
    expect(errors).toEqual([]);
    const s = step0(doc);
    expect(s.env).toEqual({ HEAD_REF: "${{ github.head_ref }}" });
    expect(s.run).toBe('echo "$HEAD_REF"');
  });
});

describe("injection-hoist: trusted contexts are left inline", () => {
  it("does not hoist github.sha", () => {
    const { doc, errors } = build(wrap(`      - run: echo \${{ github.sha }}`));
    expect(errors).toEqual([]);
    const s = step0(doc);
    expect(s.env).toBeUndefined();
    expect(s.run).toBe("echo ${{ github.sha }}");
  });

  it("does not hoist github.run_id", () => {
    const { doc } = build(wrap(`      - run: echo \${{ github.run_id }}`));
    const s = step0(doc);
    expect(s.env).toBeUndefined();
    expect(s.run).toBe("echo ${{ github.run_id }}");
  });

  it("never hoists secrets", () => {
    const { doc } = build(wrap(`      - run: echo \${{ secrets.TOKEN }}`));
    const s = step0(doc);
    expect(s.env).toBeUndefined();
    expect(s.run).toBe("echo ${{ secrets.TOKEN }}");
  });

  it("leaves structural-safe github.event leaves inline (number/id/sha)", () => {
    const { doc } = build(
      wrap(
        `      - run: echo \${{ github.event.pull_request.number }}-\${{ github.event.issue.id }}`,
      ),
    );
    const s = step0(doc);
    expect(s.env).toBeUndefined();
    expect(s.run).toBe("echo ${{ github.event.pull_request.number }}-${{ github.event.issue.id }}");
  });

  it("defensively skips share.* (actio own namespace)", () => {
    // `share.*` is #18's namespace and not yet a known context on this base, so
    // the validate pass flags it. What matters here is that injection-hoist
    // leaves it untouched: no env hoist, body unchanged.
    const { result } = build(wrap(`      - run: echo \${{ share.build.value }}`));
    const s = step0(parse(result.yaml));
    expect(s.env).toBeUndefined();
    expect(s.run).toBe("echo ${{ share.build.value }}");
  });
});

describe("injection-hoist: shell awareness", () => {
  it("rewrites pwsh to $env:VAR", () => {
    const { doc, errors } = build(
      wrap(`      - shell: pwsh
        run: Write-Output "\${{ github.event.issue.title }}"`),
    );
    expect(errors).toEqual([]);
    const s = step0(doc);
    expect(s.env).toEqual({ ISSUE_TITLE: "${{ github.event.issue.title }}" });
    expect(s.run).toContain('"$env:ISSUE_TITLE"');
  });

  it("python is warn-only: emits env but leaves the body unchanged", () => {
    const { doc, warnings, errors } = build(
      wrap(`      - shell: python
        run: print("\${{ github.event.issue.title }}")`),
    );
    expect(errors).toEqual([]);
    const s = step0(doc);
    expect(s.env).toEqual({ ISSUE_TITLE: "${{ github.event.issue.title }}" });
    expect(s.run).toBe('print("${{ github.event.issue.title }}")');
    expect(warnings.some((w) => w.code === "injection-hoist/python-manual")).toBe(true);
  });
});

describe("injection-hoist: heredocs", () => {
  it("hoists inside an unquoted heredoc (expansion active)", () => {
    const { doc, errors } = build(
      wrap(`      - run: |
          cat <<EOF
          title: \${{ github.event.issue.title }}
          EOF`),
    );
    expect(errors).toEqual([]);
    const s = step0(doc);
    expect(s.env).toEqual({ ISSUE_TITLE: "${{ github.event.issue.title }}" });
    expect(s.run).toContain("$ISSUE_TITLE");
  });

  it("errors on an untrusted interpolation inside a quoted heredoc", () => {
    const { result } = build(
      wrap(`      - run: |
          cat <<'EOF'
          title: \${{ github.event.issue.title }}
          EOF`),
    );
    const errs = result.diagnostics.filter((d) => d.severity === "error");
    expect(errs.some((e) => e.code === "injection-hoist/quoted-heredoc")).toBe(true);
  });
});

describe("injection-hoist: mode knob", () => {
  it("off disables hoisting", () => {
    const { doc } = build(
      wrap(`      - injectionHoist: off
        run: echo "\${{ github.event.issue.title }}"`),
    );
    const s = step0(doc);
    expect(s.env).toBeUndefined();
    expect(s.run).toBe('echo "${{ github.event.issue.title }}"');
  });

  it("warn diagnoses without mutating", () => {
    const { doc, warnings, errors } = build(
      wrap(`      - injectionHoist: warn
        run: echo "\${{ github.event.issue.title }}"`),
    );
    expect(errors).toEqual([]);
    const s = step0(doc);
    expect(s.env).toBeUndefined();
    expect(s.run).toBe('echo "${{ github.event.issue.title }}"');
    expect(warnings.some((w) => w.code === "injection-hoist/warn")).toBe(true);
  });

  it("error diagnoses an error without mutating", () => {
    const { result } = build(
      wrap(`      - injectionHoist: error
        run: echo "\${{ github.event.issue.title }}"`),
    );
    const errs = result.diagnostics.filter((d) => d.severity === "error");
    expect(errs.some((e) => e.code === "injection-hoist/error")).toBe(true);
  });

  it("fix is the default and mutates silently", () => {
    const { warnings, errors } = build(
      wrap(`      - run: echo "\${{ github.event.issue.title }}"`),
    );
    expect(errors).toEqual([]);
    expect(warnings.filter((w) => (w.code ?? "").startsWith("injection-hoist"))).toEqual([]);
  });

  it("cascades from a workflow-level default", () => {
    const src = `name: x
on: [push]
injectionHoist: off
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.issue.title }}"`;
    const { doc, result } = build(src);
    expect(parse(result.yaml).injectionHoist).toBeUndefined();
    const s = step0(doc);
    expect(s.env).toBeUndefined();
  });

  it("a step mode overrides an inherited job default", () => {
    const src = `name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    injectionHoist: off
    steps:
      - injectionHoist: fix
        run: echo "\${{ github.event.issue.title }}"`;
    const { doc, result } = build(src);
    expect(
      (parse(result.yaml).jobs.a as { injectionHoist?: unknown }).injectionHoist,
    ).toBeUndefined();
    expect(step0(doc).env).toEqual({ ISSUE_TITLE: "${{ github.event.issue.title }}" });
  });
});

describe("injection-hoist: opt-outs and opt-ins", () => {
  it("unsafe:true opts the step out entirely", () => {
    const { doc, result } = build(
      wrap(`      - unsafe: true
        run: echo "\${{ github.event.issue.title }}"`),
    );
    const s = step0(doc);
    expect(s.env).toBeUndefined();
    expect((s as { unsafe?: unknown }).unsafe).toBeUndefined();
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("trust list keeps a named expression inline", () => {
    const { doc } = build(
      wrap(`      - trust: ["github.event.issue.title"]
        run: echo "\${{ github.event.issue.title }}"`),
    );
    const s = step0(doc);
    expect(s.env).toBeUndefined();
    expect((s as { trust?: unknown }).trust).toBeUndefined();
  });

  it("force list hoists an otherwise-trusted expression", () => {
    const { doc } = build(
      wrap(`      - force: ["github.sha"]
        run: echo "\${{ github.sha }}"`),
    );
    const s = step0(doc);
    expect(s.env).toEqual({ SHA: "${{ github.sha }}" });
    expect((s as { force?: unknown }).force).toBeUndefined();
  });
});

describe("injection-hoist: non-run contexts are never hoisted", () => {
  it("leaves if/name/with/env/uses untouched", () => {
    const src = `name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: \${{ github.event.issue.title }}
        if: \${{ github.event.issue.title != '' }}
        uses: actions/checkout@v4
        env:
          PASSTHROUGH: \${{ github.event.issue.body }}
        with:
          ref: \${{ github.head_ref }}`;
    const { doc, errors } = build(src);
    expect(errors).toEqual([]);
    const s = step0(doc);
    expect(s.name).toBe("${{ github.event.issue.title }}");
    expect(s.if).toBe("${{ github.event.issue.title != '' }}");
    expect(s.uses).toBe("actions/checkout@v4");
    expect((s.env as Record<string, string>).PASSTHROUGH).toBe("${{ github.event.issue.body }}");
    expect((s.with as Record<string, string>).ref).toBe("${{ github.head_ref }}");
  });

  it("does not hoist github.ref in concurrency", () => {
    const src = `name: x
on: [push]
concurrency:
  group: ci-\${{ github.ref }}
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi`;
    const { doc, errors } = build(src);
    expect(errors).toEqual([]);
    expect((doc as { concurrency: { group: string } }).concurrency.group).toBe(
      "ci-${{ github.ref }}",
    );
  });
});

describe("injection-hoist: reuse and collisions", () => {
  it("reuses one env var for a repeated expression in the same step", () => {
    const { doc } = build(
      wrap(
        `      - run: echo "\${{ github.event.issue.title }}" && echo "\${{ github.event.issue.title }}"`,
      ),
    );
    const s = step0(doc);
    expect(Object.keys(s.env as object)).toEqual(["ISSUE_TITLE"]);
  });

  it("avoids clobbering an existing env key of a different value", () => {
    const { doc } = build(
      wrap(`      - env:
          ISSUE_TITLE: preset
        run: echo "\${{ github.event.issue.title }}"`),
    );
    const s = step0(doc) as { env: Record<string, string> };
    expect(s.env.ISSUE_TITLE).toBe("preset");
    expect(s.env.ACTIO_ISSUE_TITLE).toBe("${{ github.event.issue.title }}");
  });

  it("reuses an existing env key that already holds the same expression", () => {
    const { doc } = build(
      wrap(`      - env:
          MY_TITLE: \${{ github.event.issue.title }}
        run: echo "\${{ github.event.issue.title }}"`),
    );
    const s = step0(doc) as { env: Record<string, string>; run: string };
    expect(Object.keys(s.env)).toEqual(["MY_TITLE"]);
    expect(s.run).toBe('echo "$MY_TITLE"');
  });

  it("warns and leaves single-quoted untrusted interpolations inline", () => {
    const { doc, warnings } = build(wrap(`      - run: echo '\${{ github.event.issue.title }}'`));
    const s = step0(doc) as { env?: unknown; run: string };
    expect(s.env).toBeUndefined();
    expect(s.run).toBe("echo '${{ github.event.issue.title }}'");
    expect(warnings.some((w) => w.code === "injection-hoist/manual-quote")).toBe(true);
  });
});
