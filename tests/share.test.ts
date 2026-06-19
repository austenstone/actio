import { type TranspileOptions, transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildOutputWriter } from "../packages/core/src/passes/share.js";

/** Transpile and parse the generated YAML back to a JS object for assertions. */
function build(source: string, options?: Partial<TranspileOptions>) {
  const result = transpile(source, { fileName: "t.actio.yml", ...options });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  return { result, errors, warnings, doc: result.ok ? parse(result.yaml) : undefined };
}

/** Structured diagnostic codes (the `code` field — NOT the legacy `[code]` message prefix). */
function codesOf(result: { diagnostics: { code?: string }[] }): string[] {
  return result.diagnostics
    .map((d) => d.code)
    .filter((c): c is string => typeof c === "string" && c.length > 0);
}

function hasCode(result: { diagnostics: { code?: string }[] }, code: string): boolean {
  return codesOf(result).includes(code);
}

function jobsOf(doc: { jobs?: Record<string, unknown> }): Record<string, Record<string, unknown>> {
  return (doc?.jobs ?? {}) as Record<string, Record<string, unknown>>;
}

function steps(job: Record<string, unknown>): Array<Record<string, unknown>> {
  return (job?.steps ?? []) as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 3.1 Value-form, cross-job: auto-inferred needs + job outputs
// ---------------------------------------------------------------------------

describe("share: value-form cross-job", () => {
  const SRC = `
name: Release
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Resolve version
        run: VERSION=$(jq -r .version package.json)
        share:
          version: $VERSION
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish --tag v\${{ share.version }}
`;

  it("appends a GITHUB_OUTPUT writer and derives a step id", () => {
    const { result, errors, doc } = build(SRC);
    expect(result.ok).toBe(true);
    expect(errors).toHaveLength(0);
    const producer = steps(jobsOf(doc).build)[1];
    expect(producer.id).toBe("step_resolve_version");
    expect(String(producer.run)).toContain('echo "version=$VERSION" >> "$GITHUB_OUTPUT"');
  });

  it("wires the producer job.outputs map", () => {
    const { doc } = build(SRC);
    expect((jobsOf(doc).build as { outputs?: Record<string, string> }).outputs).toEqual({
      version: "${{ steps.step_resolve_version.outputs.version }}",
    });
  });

  it("infers needs and rewrites the consumer token to needs.<job>.outputs.<name>", () => {
    const { doc } = build(SRC);
    const publish = jobsOf(doc).publish;
    expect(publish.needs).toEqual(["build"]);
    expect(String(steps(publish)[0].run)).toBe(
      "npm publish --tag v${{ needs.build.outputs.version }}",
    );
  });

  it("leaves no residual share: directive or ${{ share.* }} token", () => {
    const { result } = build(SRC);
    expect(result.yaml).not.toContain("share:");
    expect(result.yaml).not.toContain("${{ share.");
  });
});

// ---------------------------------------------------------------------------
// 3.4 Same-job reference: lowers to steps.*, NO needs / NO job outputs
// ---------------------------------------------------------------------------

describe("share: same-job reference", () => {
  const SRC = `
name: Same Job
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Tag
        run: TAG=$(date +%s)
        share:
          tag: $TAG
      - run: echo "building \${{ share.tag }}"
`;

  it("rewrites to steps.<id>.outputs.<name> without needs or outputs", () => {
    const { result, errors, doc } = build(SRC);
    expect(result.ok).toBe(true);
    expect(errors).toHaveLength(0);
    const job = jobsOf(doc).build;
    expect(job.needs).toBeUndefined();
    expect(job.outputs).toBeUndefined();
    expect(String(steps(job)[1].run)).toBe('echo "building ${{ steps.step_tag.outputs.tag }}"');
  });
});

// ---------------------------------------------------------------------------
// 3.3 JSON fan-out: dotted lowers to fromJSON(target).field, multi-consumer
// ---------------------------------------------------------------------------

describe("share: json fan-out", () => {
  const SRC = `
name: JSON Fanout
on: [push]
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - name: Plan
        share:
          cfg:
            run: ./scripts/plan.sh
            json: true
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: deploy --env \${{ share.cfg.env }}
  notify:
    runs-on: ubuntu-latest
    steps:
      - run: echo "region \${{ share.cfg.region }}"
`;

  it("lowers dotted refs to fromJSON and wires needs on every consumer", () => {
    const { result, errors, doc } = build(SRC);
    expect(result.ok).toBe(true);
    expect(errors).toHaveLength(0);
    expect(String(steps(jobsOf(doc).deploy)[0].run)).toBe(
      "deploy --env ${{ fromJSON(needs.plan.outputs.cfg).env }}",
    );
    expect(String(steps(jobsOf(doc).notify)[0].run)).toBe(
      'echo "region ${{ fromJSON(needs.plan.outputs.cfg).region }}"',
    );
    expect(jobsOf(doc).deploy.needs).toEqual(["plan"]);
    expect(jobsOf(doc).notify.needs).toEqual(["plan"]);
  });
});

// ---------------------------------------------------------------------------
// 3.2 Capture-form: brace-group heredoc with a per-output delimiter
// ---------------------------------------------------------------------------

describe("share: capture-form heredoc", () => {
  const SRC = `
name: Multiline
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Notes
        share:
          notes:
            run: git log --oneline -n 20
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.notes }}"
`;

  it("emits a brace-group heredoc with a runtime-random delimiter and wires the consumer", () => {
    const { result, errors, doc } = build(SRC);
    expect(result.ok).toBe(true);
    expect(errors).toHaveLength(0);
    const run = String(steps(jobsOf(doc).build)[0].run);
    // The closing token is computed at runtime (unguessable from source): a static
    // prefix plus an in-shell nonce, captured once and reused in open + close.
    expect(run).toMatch(/__ACTIO_EOF="ACTIO_EOF_notes_\$\(openssl rand -hex 8/);
    expect(run).toContain('echo "notes<<${__ACTIO_EOF}"');
    expect(run).toMatch(/git log --oneline -n 20/);
    expect(run).toContain('echo "${__ACTIO_EOF}"');
    expect(run).toContain('} >> "$GITHUB_OUTPUT"');
    expect(String(steps(jobsOf(doc).publish)[0].run)).toBe(
      'echo "${{ needs.build.outputs.notes }}"',
    );
  });
});

// ---------------------------------------------------------------------------
// required: true → runtime non-empty guard (value-form)
// ---------------------------------------------------------------------------

describe("share: required guard", () => {
  it("emits a non-empty runtime guard after the writer", () => {
    const { result, errors, doc } = build(`
name: Required
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Resolve version
        run: VERSION=$(jq -r .version package.json)
        share:
          version:
            value: $VERSION
            required: true
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: npm publish --tag v\${{ share.version }}
`);
    expect(result.ok).toBe(true);
    expect(errors).toHaveLength(0);
    const run = String(steps(jobsOf(doc).build)[0].run);
    expect(run).toContain('echo "version=$VERSION" >> "$GITHUB_OUTPUT"');
    expect(run).toContain('[ -n "$VERSION" ] || { echo "::error::empty share value"; exit 1; }');
  });
});

// ---------------------------------------------------------------------------
// Escape: $${{ share.x }} → literal ${{ share.x }} (one $ stripped, not rewritten)
// ---------------------------------------------------------------------------

describe("share: escape", () => {
  it("rewrites a real ref but leaves an escaped one literal", () => {
    // A literal `${{ share.x }}` is intentionally outside GitHub's stock schema
    // (share is actio's namespace), so skip schema validation for this verbatim escape.
    const { result, errors, doc } = build(
      `
name: Escape
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Doc
        run: TAG=$(date +%s)
        share:
          tag: $TAG
      - run: echo "real \${{ share.tag }} literal $\${{ share.tag }}"
`,
      { validate: false },
    );
    expect(result.ok).toBe(true);
    expect(errors).toHaveLength(0);
    const run = String(steps(jobsOf(doc).build)[1].run);
    expect(run).toBe('echo "real ${{ steps.step_doc.outputs.tag }} literal ${{ share.tag }}"');
  });
});

// ---------------------------------------------------------------------------
// Boolean asymmetry: type assertion ONLY, no runtime fromJSON()==true coercion
// ---------------------------------------------------------------------------

describe("share: boolean asymmetry", () => {
  it("does not inject fromJSON(...)==true coercion for a boolean shared-output", () => {
    const { result, errors, doc } = build(`
name: Bool
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Flag
        run: echo computing
        share:
          ready:
            value: "true"
            type: boolean
  gate:
    runs-on: ubuntu-latest
    steps:
      - if: \${{ share.ready }}
        run: echo go
`);
    expect(result.ok).toBe(true);
    expect(errors).toHaveLength(0);
    expect(result.yaml).not.toContain("== true");
    expect(result.yaml).not.toContain("fromJSON(needs.build.outputs.ready)");
    expect(String(steps(jobsOf(doc).gate)[0].if)).toBe("${{ needs.build.outputs.ready }}");
  });
});

// ---------------------------------------------------------------------------
// Compile errors 5.1–5.9 (assert structured codes)
// ---------------------------------------------------------------------------

describe("share: diagnostics", () => {
  it("5.1 rejects an invalid output name", () => {
    const { result } = build(`
name: e
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        share:
          "1bad": $X
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "share-name-invalid")).toBe(true);
  });

  it("5.2 rejects an unknown shared value", () => {
    const { result } = build(`
name: e
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.nope }}"
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "share-unknown")).toBe(true);
  });

  it("5.3 rejects an ambiguous unqualified ref, but a qualified ref resolves", () => {
    const ambiguous = `
name: e
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          x: $A
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
        share:
          x: $B
  c:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.x }}"
`;
    expect(hasCode(build(ambiguous).result, "share-ambiguous")).toBe(true);

    const qualified = ambiguous.replace("${{ share.x }}", "${{ share.a.x }}");
    const { result, errors, doc } = build(qualified);
    expect(result.ok).toBe(true);
    expect(errors).toHaveLength(0);
    expect(String(steps(jobsOf(doc).c)[0].run)).toBe('echo "${{ needs.a.outputs.x }}"');
  });

  it("5.4 rejects a dotted ref to a non-json share", () => {
    const { result } = build(`
name: e
on: [push]
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - run: echo plain
        share:
          cfg: $C
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.cfg.env }}"
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "share-not-json")).toBe(true);
  });

  it("5.5 rejects a needs cycle introduced by inference", () => {
    const { result } = build(`
name: e
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.y }}"
        share:
          x: $A
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.x }}"
        share:
          y: $B
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "share-cycle")).toBe(true);
  });

  it("5.6 rejects a duplicate output name within one job", () => {
    const { result } = build(`
name: e
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo one
        share:
          x: $A
      - run: echo two
        share:
          x: $B
`);
    expect(result.ok).toBe(false);
    expect(hasCode(result, "share-duplicate")).toBe(true);
  });

  it("5.7 warns when share is placed on a job rather than a step", () => {
    const { result, warnings } = build(`
name: e
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    share:
      x: $A
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(true);
    expect(hasCode(result, "share-not-on-step")).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("5.8 hard-errors when a matrix-produced output escapes via job outputs", () => {
    const { result } = build(`
name: e
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - run: echo hi
        share:
          x: $A
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.x }}"
`);
    expect(hasCode(result, "share-matrix-output-clobber")).toBe(true);
    expect(result.ok).toBe(false);
    // Old race warning is gone — replaced by the precise cross-job error.
    expect(hasCode(result, "share-matrix-race")).toBe(false);
  });

  it("5.8b does not flag a matrix share consumed within the same job", () => {
    const { result } = build(`
name: e
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - run: echo hi
        share:
          x: $A
      - run: echo "\${{ share.x }}"
`);
    expect(hasCode(result, "share-matrix-output-clobber")).toBe(false);
    expect(hasCode(result, "share-matrix-race")).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("5.9 warns when a shared value derives from a secret", () => {
    const { result } = build(`
name: e
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        share:
          token: \${{ secrets.NPM_TOKEN }}
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.token }}"
`);
    expect(hasCode(result, "share-secret")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildOutputWriter primitive — the for_each integration seam.
// It must write whatever name it is handed (no global state).
// ---------------------------------------------------------------------------

describe("buildOutputWriter primitive", () => {
  it("builds a value-form writer for an arbitrary name", () => {
    expect(buildOutputWriter({ kind: "value", name: "version", value: "$V" })).toBe(
      'echo "version=$V" >> "$GITHUB_OUTPUT"',
    );
    expect(buildOutputWriter({ kind: "value", name: "build_id", value: "42" })).toBe(
      'echo "build_id=42" >> "$GITHUB_OUTPUT"',
    );
  });

  it("appends a runtime guard when required", () => {
    const out = buildOutputWriter({ kind: "value", name: "v", value: "$V", required: true });
    expect(out).toContain('echo "v=$V" >> "$GITHUB_OUTPUT"');
    expect(out).toContain('[ -n "$V" ] || { echo "::error::empty share value"; exit 1; }');
  });

  it("builds a capture-form heredoc with a runtime-random delimiter from the given prefix", () => {
    const out = buildOutputWriter({
      kind: "capture",
      name: "notes",
      body: "git log",
      delimiter: "ACTIO_EOF_notes",
    });
    // Prefix seeds an in-shell nonce; the nonce (not the prefix) terminates the heredoc.
    expect(out).toMatch(/__ACTIO_EOF="ACTIO_EOF_notes_\$\(openssl rand -hex 8/);
    expect(out).toContain('echo "notes<<${__ACTIO_EOF}"');
    expect(out).toContain("git log");
    expect(out).toContain('echo "${__ACTIO_EOF}"');
    expect(out).toContain('} >> "$GITHUB_OUTPUT"');
  });
});
