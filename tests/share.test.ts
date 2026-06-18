import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Transpile and parse the generated YAML back to a JS object for assertions. */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml" });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  const doc = result.ok ? (parse(result.yaml) as Record<string, unknown>) : undefined;
  return { result, errors, warnings, doc };
}

function codes(result: { diagnostics: { code?: string }[] }): string[] {
  return result.diagnostics.map((d) => d.code).filter((c): c is string => Boolean(c));
}

function hasCode(result: { diagnostics: { code?: string }[] }, code: string): boolean {
  return codes(result).includes(code);
}

function jobsOf(doc: Record<string, unknown> | undefined): Record<string, Record<string, unknown>> {
  return ((doc?.jobs ?? {}) as Record<string, Record<string, unknown>>) ?? {};
}

function runOf(step: unknown): string {
  return (step as { run?: string }).run ?? "";
}

// ---------------------------------------------------------------------------
// Happy-path rewriting
// ---------------------------------------------------------------------------

describe("share: producer/consumer wiring", () => {
  it("rewrites a value-form cross-job ref and infers outputs + needs", () => {
    const { result, errors, doc } = build(`
name: ci
on: [push]
jobs:
  produce:
    runs-on: ubuntu-latest
    steps:
      - name: resolve version
        run: echo hi
        share:
          version: "1.2.3"
  consume:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.version }}"
`);
    expect(errors).toEqual([]);
    expect(result.ok).toBe(true);
    const jobs = jobsOf(doc);
    expect(runOf((jobs.produce.steps as unknown[])[0])).toContain(
      'echo "version=1.2.3" >> "$GITHUB_OUTPUT"',
    );
    expect(jobs.produce.outputs).toEqual({
      version: "${{ steps.step_resolve_version.outputs.version }}",
    });
    expect(runOf((jobs.consume.steps as unknown[])[0])).toBe(
      'echo "${{ needs.produce.outputs.version }}"',
    );
    expect(jobs.consume.needs).toEqual(["produce"]);
    // No residual share directive survives.
    expect(result.yaml).not.toContain("share:");
  });

  it("rewrites a same-job ref to steps.* without inferring needs or outputs", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: compute token
        run: echo hi
        share:
          token: abc
      - run: echo "\${{ share.token }}"
`);
    expect(errors).toEqual([]);
    const job = jobsOf(doc).build;
    expect(runOf((job.steps as unknown[])[1])).toBe(
      'echo "${{ steps.step_compute_token.outputs.token }}"',
    );
    expect(job.outputs).toBeUndefined();
    expect(job.needs).toBeUndefined();
  });

  it("captures a multiline command into a heredoc with a deterministic delimiter", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: gen
        share:
          notes:
            run: |
              echo a
              echo b
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.notes }}"
`);
    expect(errors).toEqual([]);
    const run = runOf((jobsOf(doc).build.steps as unknown[])[0]);
    expect(run).toMatch(/echo 'notes<<ACTIO_EOF_NOTES_[0-9A-Z]{6}'/);
    expect(run).toContain('} >> "$GITHUB_OUTPUT"');
    expect(run).toContain("  echo a");
  });

  it("rewrites dotted access on a json producer to fromJSON(...)", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  meta:
    runs-on: ubuntu-latest
    steps:
      - name: collect
        share:
          info:
            run: cat meta.json
            json: true
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.info.version }}"
`);
    expect(errors).toEqual([]);
    expect(runOf((jobsOf(doc).deploy.steps as unknown[])[0])).toBe(
      'echo "${{ fromJSON(needs.meta.outputs.info).version }}"',
    );
  });

  it("emits a required guard for required value shares", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  prep:
    runs-on: ubuntu-latest
    steps:
      - name: derive
        run: echo p
        share:
          tag:
            value: v1
            required: true
  use:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.tag }}"
`);
    expect(errors).toEqual([]);
    expect(runOf((jobsOf(doc).prep.steps as unknown[])[0])).toContain(
      '[ -n "v1" ] || { echo "::error::empty share value"; exit 1; }',
    );
  });

  it("leaves an escaped $${{ share.x }} literal while rewriting the real ref", () => {
    const result = transpile(
      `
name: ci
on: [push]
jobs:
  emit:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        share:
          color: blue
  show:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "literal $\${{ share.color }}"
          echo "real \${{ share.color }}"
`,
      { fileName: "t.actio.yml", validate: false },
    );
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.yaml).toContain('echo "literal ${{ share.color }}"');
    expect(result.yaml).toContain('echo "real ${{ needs.emit.outputs.color }}"');
  });

  it("resolves a qualified share.<job>.<name> ref when the name is ambiguous", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          dup: from-a
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
        share:
          dup: from-b
  c:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.a.dup }}"
`);
    expect(errors).toEqual([]);
    expect(runOf((jobsOf(doc).c.steps as unknown[])[0])).toBe('echo "${{ needs.a.outputs.dup }}"');
    expect(jobsOf(doc).c.needs).toEqual(["a"]);
  });

  it("accepts number and boolean scalar shorthands without runtime coercion", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  p:
    runs-on: ubuntu-latest
    steps:
      - run: echo p
        share:
          count: 5
          flag:
            value: true
            type: boolean
  q:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.count }} \${{ share.flag }}"
`);
    expect(errors).toEqual([]);
    const run = runOf((jobsOf(doc).p.steps as unknown[])[0]);
    expect(run).toContain('echo "count=5" >> "$GITHUB_OUTPUT"');
    // type:boolean is a compile-time assertion only — the value text is untouched.
    expect(run).toContain('echo "flag=true" >> "$GITHUB_OUTPUT"');
  });

  it("is a no-op when no share directives are present", () => {
    const { result, errors, doc } = build(`
name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.sha }}"
`);
    expect(errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(runOf((jobsOf(doc).build.steps as unknown[])[0])).toBe('echo "${{ github.sha }}"');
  });
});

// ---------------------------------------------------------------------------
// Diagnostics (brief §5.1 - §5.9 plus shape extras)
// ---------------------------------------------------------------------------

describe("share: diagnostics", () => {
  it("E-share-invalid-name on a malformed output name", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          "bad name": x
`);
    expect(hasCode(result, "E-share-invalid-name")).toBe(true);
  });

  it("E-share-unknown when a ref names no producer", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          real: x
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.nope }}"
`);
    expect(hasCode(result, "E-share-unknown")).toBe(true);
  });

  it("E-share-ambiguous when two jobs produce the same unqualified name", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          dup: from-a
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
        share:
          dup: from-b
  c:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.dup }}"
`);
    expect(hasCode(result, "E-share-ambiguous")).toBe(true);
  });

  it("E-share-dotted-non-json when dotting a non-json share", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          plain: x
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.plain.field }}"
`);
    expect(hasCode(result, "E-share-dotted-non-json")).toBe(true);
  });

  it("E-share-needs-cycle when share wiring is mutually dependent", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          x: "1"
      - run: echo "\${{ share.y }}"
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo b
        share:
          y: "2"
      - run: echo "\${{ share.x }}"
`);
    expect(hasCode(result, "E-share-needs-cycle")).toBe(true);
  });

  it("E-share-duplicate-name when one step declares a name twice across steps", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo one
        share:
          dup: x
      - run: echo two
        share:
          dup: y
`);
    expect(hasCode(result, "E-share-duplicate-name")).toBe(true);
  });

  it("W-share-on-job when share is declared on a job", () => {
    const { result, warnings } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    share:
      x: "1"
    steps:
      - run: echo a
`);
    expect(hasCode(result, "W-share-on-job")).toBe(true);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("W-share-matrix when a matrix job produces a share", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest]
    steps:
      - run: echo a
        share:
          built: "1"
`);
    expect(hasCode(result, "W-share-matrix")).toBe(true);
  });

  it("W-share-secret when a share value derives from secrets", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          token:
            value: \${{ secrets.TOKEN }}
`);
    expect(hasCode(result, "W-share-secret")).toBe(true);
  });

  it("E-share-shape when share is not a mapping", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share: not-a-map
`);
    expect(hasCode(result, "E-share-shape")).toBe(true);
  });

  it("E-share-shape when a spec is neither scalar nor mapping", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          x:
            - 1
            - 2
`);
    expect(hasCode(result, "E-share-shape")).toBe(true);
  });

  it("E-share-shape when an object spec declares neither value nor run", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          x:
            json: true
`);
    expect(hasCode(result, "E-share-shape")).toBe(true);
  });

  it("E-share-shape when type is not a known share type", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          x:
            value: y
            type: weird
`);
    expect(hasCode(result, "E-share-shape")).toBe(true);
  });

  it("W-share-unknown-key when an object spec carries an unknown key", () => {
    const { result } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          x:
            value: y
            bogus: 1
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.x }}"
`);
    expect(hasCode(result, "W-share-unknown-key")).toBe(true);
  });

  it("ignores a multiline value shorthand by capturing it", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - name: gen
        share:
          blob: |
            line1
            line2
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ share.blob }}"
`);
    expect(errors).toEqual([]);
    expect(runOf((jobsOf(doc).a.steps as unknown[])[0])).toContain("echo 'blob<<ACTIO_EOF_BLOB_");
  });

  it("skips quoted braces inside expressions when locating the close token", () => {
    const { errors, doc } = build(`
name: ci
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo a
        share:
          v: "1"
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ format('{0}', share.v) }} \${{ share.v == '}}' }}"
`);
    expect(errors).toEqual([]);
    const run = runOf((jobsOf(doc).b.steps as unknown[])[0]);
    // The nested share token is rewritten; the quoted '}}' does not close the block early.
    expect(run).toContain("format('{0}', needs.a.outputs.v)");
    expect(run).toContain("needs.a.outputs.v == '}}'");
    expect(run).not.toContain("share");
  });
});
