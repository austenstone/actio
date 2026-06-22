import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPasses, builtinPasses, parseActio, transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Resolve a top-level `let:` block and return the bound `let.<name>` symbol. */
function letSymbol(letBody: string, name: string) {
  const ctx = parseActio(
    `name: x\non: [push]\n${letBody}\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`,
    "t.actio.yml",
  );
  applyPasses(ctx, builtinPasses);
  return ctx.symbols.get(`let.${name}`);
}

/** Value of a single `let.<name>` whose body is the given whole-value expression. */
function letValue(expr: string) {
  return letSymbol(`let:\n  v: "${expr}"`, "v")?.value;
}

/** Transpile and surface error codes for diagnostic assertions. */
function build(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml", validate: true });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  return {
    errors,
    codes: errors.map((d) => d.code),
    doc: result.ok ? parse(result.yaml) : undefined,
    yaml: result.yaml,
  };
}

describe("single compile-time evaluator invariant", () => {
  const collectTs = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return collectTs(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });

  it("declares exactly one ExprParser class, in expr.ts", () => {
    const files = collectTs(join(repoRoot, "packages/core/src"));
    const declarations = files.filter((file) =>
      /\bclass\s+ExprParser\s*\{/.test(readFileSync(file, "utf8")),
    );
    expect(declarations.map((f) => f.replace(repoRoot, ""))).toEqual([
      "packages/core/src/passes/expr.ts",
    ]);
  });

  it("retains no bespoke params expression parser (parseCompileExpr deleted)", () => {
    const files = collectTs(join(repoRoot, "packages/core/src"));
    const offenders = files.filter((file) => /parseCompileExpr/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("compile-time expression engine: arithmetic", () => {
  it("honours multiplicative-over-additive precedence", () => {
    expect(letValue("{{ 1 + 2 * 3 }}")).toBe(7);
  });

  it("supports parenthesised grouping", () => {
    expect(letValue("{{ (1 + 2) * 3 }}")).toBe(9);
  });

  it("subtracts left-associatively", () => {
    expect(letValue("{{ 10 - 2 - 3 }}")).toBe(5);
  });

  it("divides with JS semantics", () => {
    expect(letValue("{{ 7 / 2 }}")).toBe(3.5);
  });

  it("computes modulo", () => {
    expect(letValue("{{ 10 % 3 }}")).toBe(1);
  });

  it("negates with unary minus", () => {
    expect(letValue("{{ -5 + 8 }}")).toBe(3);
  });

  it("stores the typed number, not its string form", () => {
    expect(letSymbol(`let:\n  v: "{{ 2 + 2 }}"`, "v")?.type).toBe("number");
  });
});

describe("compile-time expression engine: comparisons and logic", () => {
  it.each([
    ["{{ 1 < 2 }}", true],
    ["{{ 2 <= 2 }}", true],
    ["{{ 3 > 4 }}", false],
    ["{{ 4 >= 4 }}", true],
    ["{{ 1 == 1 }}", true],
    ["{{ 1 != 2 }}", true],
    ["{{ true && false }}", false],
    ["{{ true || false }}", true],
  ])("evaluates %s", (expr, expected) => {
    expect(letValue(expr)).toBe(expected);
  });

  it("negates a boolean with unary !", () => {
    expect(letValue("{{ !false }}")).toBe(true);
  });
});

describe("compile-time expression engine: ternary", () => {
  it("selects the consequent when the condition is true", () => {
    expect(letValue("{{ 1 < 2 ? 10 : 20 }}")).toBe(10);
  });

  it("selects the alternative when the condition is false", () => {
    expect(letValue("{{ 1 > 2 ? 10 : 20 }}")).toBe(20);
  });
});

describe("compile-time expression engine: list comprehension and literals", () => {
  it("maps a list comprehension to a concrete array", () => {
    expect(letValue("{{ [x * 2 for x in [1, 2, 3]] }}")).toEqual([2, 4, 6]);
  });

  it("evaluates an empty list literal", () => {
    expect(letValue("{{ [] }}")).toEqual([]);
  });

  it("evaluates a list literal", () => {
    expect(letValue("{{ [1, 2, 3] }}")).toEqual([1, 2, 3]);
  });

  it("evaluates an object literal", () => {
    expect(letValue("{{ {a: 1, b: 2} }}")).toEqual({ a: 1, b: 2 });
  });
});

describe("compile-time expression engine: stdlib", () => {
  it.each([
    ["{{ upper('hi') }}", "HI"],
    ["{{ lower('HI') }}", "hi"],
    ["{{ concat('a', 'b', 'c') }}", "abc"],
    ["{{ replace('aXbXc', 'X', '-') }}", "a-b-c"],
    ["{{ join(['a', 'b'], '-') }}", "a-b"],
    ["{{ format('{0}-{1}', 'a', 'b') }}", "a-b"],
    ["{{ contains('abc', 'b') }}", true],
    ["{{ startsWith('abc', 'a') }}", true],
    ["{{ endsWith('abc', 'c') }}", true],
    ["{{ defined('x') }}", true],
    ["{{ toJSON('a') }}", '"a"'],
  ])("evaluates %s", (expr, expected) => {
    expect(letValue(expr)).toEqual(expected);
  });

  it("splits a string into a list", () => {
    expect(letValue("{{ split('a,b,c', ',') }}")).toEqual(["a", "b", "c"]);
  });

  it("serialises a structured value with toJSON", () => {
    expect(letValue("{{ toJSON([1, 2]) }}")).toBe("[1,2]");
  });
});

describe("let macro: binding and references", () => {
  it("binds a literal number without a sigil", () => {
    const sym = letSymbol("let:\n  count: 3", "count");
    expect(sym?.value).toBe(3);
    expect(sym?.type).toBe("number");
  });

  it("binds a plain string literal", () => {
    expect(letSymbol('let:\n  who: "world"', "who")?.value).toBe("world");
  });

  it("references an earlier let via {{ let.* }}", () => {
    const doubled = letSymbol('let:\n  base: 4\n  doubled: "{{ let.base * 2 }}"', "doubled");
    expect(doubled?.value).toBe(8);
  });

  it("references a param via {{ params.* }}", () => {
    const sym = letSymbol(
      'params:\n  base: { type: number, default: 5 }\nlet:\n  next: "{{ params.base + 1 }}"',
      "next",
    );
    expect(sym?.value).toBe(6);
  });

  it("interpolates {{ let.* }} into a no-eval text zone and strips let on emit", () => {
    const { errors, doc, yaml } = build(`name: x
on: [push]
let:
  base: 4
  doubled: "{{ let.base * 2 }}"
defaults:
  run:
    shell: "build-{{ let.doubled }}"
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(errors).toEqual([]);
    expect(doc.defaults.run.shell).toBe("build-8");
    expect(yaml).not.toContain("let:");
  });

  it("resolves a let-only file with no params", () => {
    expect(letSymbol('let:\n  only: "{{ 1 + 1 }}"', "only")?.value).toBe(2);
  });
});

describe("let macro: diagnostics", () => {
  const errorsFor = (letBody: string) =>
    build(`name: x
on: [push]
${letBody}
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);

  it("reports expr-parse-error on a malformed expression", () => {
    expect(errorsFor('let:\n  v: "{{ 1 + }}"').codes).toContain("expr-parse-error");
  });

  it("reports expr-unknown-name on an unknown function", () => {
    expect(errorsFor('let:\n  v: "{{ nope() }}"').codes).toContain("expr-unknown-name");
  });

  it("reports expr-unknown-name on an unresolved reference", () => {
    expect(errorsFor('let:\n  v: "{{ params.missing }}"').codes).toContain("expr-unknown-name");
  });

  it("reports expr-type-error on an arithmetic type mismatch", () => {
    expect(errorsFor("let:\n  v: \"{{ 1 + 'a' }}\"").codes).toContain("expr-type-error");
  });

  it("reports expr-runtime-fn on a runtime-only function", () => {
    expect(errorsFor("let:\n  v: \"{{ hashFiles('x') }}\"").codes).toContain("expr-runtime-fn");
  });

  it("reports let-redeclared when a let shadows a param", () => {
    const { codes } = errorsFor("params:\n  foo: { type: number, default: 1 }\nlet:\n  foo: 2");
    expect(codes).toContain("let-redeclared");
  });

  it("reports let-not-compile-time for a runtime context reference", () => {
    expect(errorsFor('let:\n  v: "{{ github.sha }}"').codes).toContain("let-not-compile-time");
  });

  it("reports let-not-compile-time for a ${{ }} runtime expression", () => {
    expect(errorsFor('let:\n  v: "${{ github.sha }}"').codes).toContain("let-not-compile-time");
  });

  it("reports let-not-compile-time for a circular dependency", () => {
    const { codes } = errorsFor('let:\n  a: "{{ let.b }}"\n  b: "{{ let.a }}"');
    expect(codes).toContain("let-not-compile-time");
  });

  it("reports let-shape-invalid when let is not a mapping", () => {
    expect(errorsFor("let: [1, 2, 3]").codes).toContain("let-shape-invalid");
  });

  it.each([
    ["{{ 1 - 'a' }}", "subtraction on a non-number"],
    ["{{ 1 * 'a' }}", "multiplication on a non-number"],
    ["{{ 1 / 'a' }}", "division on a non-number"],
    ["{{ 1 % 'a' }}", "modulo on a non-number"],
    ["{{ -'a' }}", "unary minus on a non-number"],
    ["{{ 5 ? 1 : 2 }}", "ternary on a non-boolean condition"],
    ["{{ 1 || true }}", "logical or on a non-boolean"],
    ["{{ [x for x in 5] }}", "comprehension over a non-list"],
    ["{{ upper(5) }}", "upper on a non-string"],
    ["{{ lower(5) }}", "lower on a non-string"],
    ["{{ split(5, ',') }}", "split on a non-string"],
    ["{{ replace(5, 'a', 'b') }}", "replace on a non-string"],
    ["{{ join(5, ',') }}", "join on a non-list"],
  ])("reports expr-type-error for %s", (expr) => {
    expect(errorsFor(`let:\n  v: "${expr}"`).codes).toContain("expr-type-error");
  });
});
