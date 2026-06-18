import { type Diagnostic, formatGithubAnnotation } from "actio-core";
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
});
