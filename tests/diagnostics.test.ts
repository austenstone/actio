import { type Diagnostic, formatDiagnostic, formatGithubAnnotation, transpile } from "actio-core";
import { describe, expect, it } from "vitest";

const base: Diagnostic = {
  severity: "error",
  source: "schema",
  message: "Unexpected value 'x'",
  file: ".github/actio/ci.actio.yml",
  range: { start: { line: 8, col: 26 }, end: { line: 8, col: 26 } },
};

describe("formatGithubAnnotation", () => {
  it("emits an ::error workflow command with file/line/col", () => {
    expect(formatGithubAnnotation(base)).toBe(
      "::error file=.github/actio/ci.actio.yml,line=8,col=26,title=actio (schema)::Unexpected value 'x'",
    );
  });

  it("uses ::warning for warnings", () => {
    expect(formatGithubAnnotation({ ...base, severity: "warning" })).toMatch(/^::warning /);
  });

  it("uses ::notice for info diagnostics", () => {
    expect(formatGithubAnnotation({ ...base, severity: "info" })).toMatch(/^::notice /);
  });

  it("includes endLine/endColumn for multi-position ranges", () => {
    const d = { ...base, range: { start: { line: 2, col: 1 }, end: { line: 3, col: 5 } } };
    expect(formatGithubAnnotation(d)).toContain("line=2,col=1,endLine=3,endColumn=5");
  });

  it("appends the hint to the message body", () => {
    const out = formatGithubAnnotation({ ...base, hint: "did you mean a number?" });
    expect(out.endsWith("Unexpected value 'x'%0A%0Ahint: did you mean a number?")).toBe(true);
  });

  it("escapes commas and colons in property values", () => {
    const out = formatGithubAnnotation({ ...base, file: "a,b:c.actio.yml" });
    expect(out).toContain("file=a%2Cb%3Ac.actio.yml");
  });

  it("escapes newlines and percents in the message body", () => {
    const out = formatGithubAnnotation({ ...base, message: "100% off\nline two" });
    expect(out.endsWith("::100%25 off%0Aline two")).toBe(true);
  });

  it("omits file/line props when no range or file is present", () => {
    const d: Diagnostic = { severity: "error", source: "actio", message: "boom" };
    expect(formatGithubAnnotation(d)).toBe("::error title=actio (actio)::boom");
  });

  it("renders a [code] prefix in the message body when code is set", () => {
    const out = formatGithubAnnotation({ ...base, code: "param-type-invalid" });
    expect(out.endsWith("::[param-type-invalid] Unexpected value 'x'")).toBe(true);
  });
});

describe("formatDiagnostic code rendering", () => {
  it("renders [code] before the message when code is set", () => {
    expect(formatDiagnostic({ ...base, code: "param-type-invalid" })).toContain(
      "[param-type-invalid] Unexpected value 'x'",
    );
  });

  it("omits the bracket prefix when code is absent", () => {
    expect(formatDiagnostic(base)).not.toContain("[");
  });
});

describe("YAML run diagnostics", () => {
  it("points plain run scalars with colon-space at GitHub-compatible YAML fixes", () => {
    const source = `name: Repro
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "PR title: \${{ github.event.pull_request.title }}"
`;

    const result = transpile(source, { fileName: "t.actio.yml", validate: false });
    const diagnostic = result.diagnostics.find((d) => d.code === "yaml-run-quote-trap");

    expect(result.ok).toBe(false);
    if (!diagnostic) throw new Error("missing yaml-run-quote-trap diagnostic");
    expect(diagnostic.source).toBe("yaml");
    expect(diagnostic.hint).toContain("GitHub Actions `run:` is still YAML");
    expect(formatDiagnostic(diagnostic, source)).toContain("run: |");
  });

  it("points broken double-quoted run scalars at the same GitHub-compatible YAML fixes", () => {
    const source = `name: Repro
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: "echo "PR title: \${{ github.event.pull_request.title }}""
`;

    const result = transpile(source, { fileName: "t.actio.yml", validate: false });
    const runDiagnostics = result.diagnostics.filter((d) => d.code === "yaml-run-quote-trap");

    expect(result.ok).toBe(false);
    expect(runDiagnostics).toHaveLength(2);
    expect(runDiagnostics.every((d) => d.hint?.includes("single quotes"))).toBe(true);
  });

  it("keeps quoted and block-scalar run values as normal GitHub Actions syntax", () => {
    const singleQuoted = `name: Repro
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: 'echo "PR title: \${{ github.event.pull_request.title }}"'
`;
    const blockScalar = `name: Repro
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo "PR title: \${{ github.event.pull_request.title }}"
`;

    expect(transpile(singleQuoted, { fileName: "t.actio.yml", validate: false }).ok).toBe(true);
    expect(transpile(blockScalar, { fileName: "t.actio.yml", validate: false }).ok).toBe(true);
  });
});
