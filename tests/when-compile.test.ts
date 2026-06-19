import { type Pass, type SymbolDef, transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { collectExpressionRoots, RUNTIME_CONTEXT_ROOTS } from "../packages/core/src/symbols.js";

function transpileErrors(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml" });
  return result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
}

function transpileWarnings(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml" });
  return result.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
}

function transpileResult(source: string) {
  return transpile(source, { fileName: "t.actio.yml" });
}

describe("static-if diagnostics", () => {
  it("pins the canonical runtime root allow-list", () => {
    expect([...RUNTIME_CONTEXT_ROOTS]).toEqual([
      "github",
      "needs",
      "steps",
      "secrets",
      "env",
      "inputs",
      "vars",
      "runner",
      "job",
      "matrix",
      "strategy",
    ]);
  });

  it("errors on runtime roots inside structural expressions (E1)", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: github.ref == 'refs/heads/main'
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-runtime-context]")),
    ).toBe(true);
  });

  it("finds roots after double-quoted strings ending in even backslashes", () => {
    expect([...collectExpressionRoots('"literal\\\\" github.ref')]).toContain("github");
  });

  it("keeps static-if runtime-root checks in parity with the shared runtime root list", () => {
    for (const root of RUNTIME_CONTEXT_ROOTS) {
      const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: ${root}.ref == 'x'
`);
      expect(
        errors.some((diagnostic) => diagnostic.message.includes("[static-if-runtime-context]")),
      ).toBe(true);
    }
  });

  it("errors when the expression result is not boolean (E2)", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  mode:
    type: string
    default: prod
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: params.mode
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-non-boolean]")),
    ).toBe(true);
  });

  it("errors on unknown references, even in short-circuit position (E3)", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  deploy:
    type: boolean
    default: false
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: false && params.typoed
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-undefined-ref]")),
    ).toBe(true);
  });

  it("errors on dangling needs when a job is omitted (E4)", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  deploy:
    type: boolean
    default: false
jobs:
  build:
    static-if: params.deploy
    runs-on: ubuntu-latest
    steps:
      - run: echo build
  publish:
    runs-on: ubuntu-latest
    needs: build
    steps:
      - run: echo publish
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-dangling-needs]")),
    ).toBe(true);
  });

  it("errors on empty expressions (E5)", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: ""
`);
    expect(errors.some((diagnostic) => diagnostic.message.includes("[static-if-empty]"))).toBe(
      true,
    );
  });

  it("errors when all steps in a job are omitted", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  keep:
    type: boolean
    default: false
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: params.keep
`);
    expect(errors.some((diagnostic) => diagnostic.message.includes("[static-if-empty-job]"))).toBe(
      true,
    );
  });

  it("errors when form B value is not a map", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  keep:
    type: boolean
    default: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        env:
          static-if(params.keep): nope
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-merge-non-map]")),
    ).toBe(true);
  });

  it("rejects runtime wrapper syntax in static-if values", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  deploy:
    type: boolean
    default: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: \${{ params.deploy }}
      - run: echo ok
        static-if: \${{ github.ref == 'refs/heads/main' }}
`);
    expect(errors.some((diagnostic) => diagnostic.message.includes("[params-runtime-sigil]"))).toBe(
      true,
    );
    expect(
      errors.some(
        (diagnostic) =>
          diagnostic.message.includes("[params-runtime-sigil]") &&
          diagnostic.message.includes('bare compile-time form such as "params.deploy"'),
      ),
    ).toBe(true);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-runtime-context]")),
    ).toBe(true);
  });

  it("treats empty form B predicates as static-if-empty and strips them from output", () => {
    const result = transpileResult(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        env:
          static-if():
            FLAG: "1"
          KEEP: yes
`);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.message.includes("[static-if-empty]")),
    ).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: {
        build: {
          steps: Array<{ env?: { KEEP?: string; "static-if()"?: { FLAG?: string } } }>;
        };
      };
    };
    expect(doc.jobs.build.steps[0]?.env?.["static-if()"]).toBeUndefined();
    expect(doc.jobs.build.steps[0]?.env?.KEEP).toBe("yes");
  });

  it("rejects wrapper syntax even when no runtime root is referenced", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: \${{ true }}
`);
    expect(
      errors.some(
        (diagnostic) =>
          diagnostic.message.includes("[static-if-runtime-context]") &&
          diagnostic.message.includes("bare compile-time expression"),
      ),
    ).toBe(true);
  });

  it("rejects wrapper syntax when runtime literals contain closing braces", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: \${{ contains('a}}b', '}}') }}
`);
    expect(
      errors.some(
        (diagnostic) =>
          diagnostic.message.includes("[static-if-runtime-context]") &&
          diagnostic.message.includes("bare compile-time expression"),
      ),
    ).toBe(true);
  });

  it("errors on parse failures", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  deploy:
    type: boolean
    default: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: params.deploy &&
`);
    expect(errors.some((diagnostic) => diagnostic.message.includes("[static-if-empty]"))).toBe(
      true,
    );
  });

  it("errors on parser leftovers and invalid bracket literals", () => {
    const leftovers = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: true false
`);
    const badBracket = transpileErrors(`name: x
on: [push]
params:
  deploy:
    type: boolean
    default: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: params.deploy[foo]
`);
    expect(leftovers.some((diagnostic) => diagnostic.message.includes("[static-if-empty]"))).toBe(
      true,
    );
    expect(badBracket.some((diagnostic) => diagnostic.message.includes("[static-if-empty]"))).toBe(
      true,
    );
  });

  it("errors on unknown function calls", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: nope()
`);
    expect(
      errors.some(
        (diagnostic) =>
          diagnostic.message.includes("[static-if-non-boolean]") &&
          diagnostic.message.includes("Unknown function"),
      ),
    ).toBe(true);
  });

  it("errors when unary ! receives a non-boolean operand", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  mode:
    type: string
    default: prod
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: "!params.mode"
`);
    expect(
      errors.some((diagnostic) =>
        diagnostic.message.includes("Unary ! requires a boolean operand"),
      ),
    ).toBe(true);
  });

  it("errors when boolean operators receive non-boolean operands", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  mode:
    type: string
    default: prod
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: params.mode && true
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("&& requires boolean operands")),
    ).toBe(true);
  });

  it("errors when compare operators receive non-comparable operands", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  deploy:
    type: boolean
    default: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: params.deploy < true
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("< requires comparable operands")),
    ).toBe(true);
  });

  it("errors when form B expression uses runtime context", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        env:
          static-if(github.ref == 'refs/heads/main'):
            FLAG: "1"
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-runtime-context]")),
    ).toBe(true);
  });

  it("errors when static-if value is neither string nor boolean", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: 1
`);
    expect(
      errors.some((diagnostic) =>
        diagnostic.message.includes("must resolve to a boolean expression"),
      ),
    ).toBe(true);
  });

  it("applies boolean static-if values at job and step scope", () => {
    const result = transpileResult(`name: x
on: [push]
jobs:
  keep:
    static-if: true
    runs-on: ubuntu-latest
    steps:
      - run: echo kept
      - run: echo dropped
        static-if: false
      - run: echo also-kept
        static-if: true
  drop:
    static-if: false
    runs-on: ubuntu-latest
    steps:
      - run: echo hidden
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: Record<string, { steps: Array<{ run?: string; "static-if"?: unknown }> }>;
    };
    expect(Object.keys(doc.jobs)).toEqual(["keep"]);
    expect(doc.jobs.keep?.steps.map((step) => step.run)).toEqual(["echo kept", "echo also-kept"]);
    expect(doc.jobs.keep?.steps.every((step) => !Object.hasOwn(step, "static-if"))).toBe(true);
  });

  it("errors on residual non-structural static-if keys", () => {
    const result = transpileResult(`name: x
on: [push]
params:
  deploy:
    type: boolean
    default: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        env:
          static-if: params.deploy
          KEEP: yes
`);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.message.includes("[static-if-residual]")),
    ).toBe(true);
    const output = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ env?: { "static-if"?: string; KEEP?: string } }> } };
    };
    expect(output.jobs.build.steps[0]?.env?.["static-if"]).toBeUndefined();
    expect(output.jobs.build.steps[0]?.env?.KEEP).toBe("yes");
  });

  it("fails loud on residual static-if form B keys under top-level env", () => {
    const source = `name: t
on: push
params:
  deploy:
    type: boolean
    default: true
env:
  static-if(params.deploy):
    DEPLOY_TOKEN: abc
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const result = transpile(source, { fileName: "t.actio.yml" });
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.message.includes("[static-if-residual]")),
    ).toBe(true);
    expect(result.yaml.includes("static-if")).toBe(false);
  });

  it("fails loud on residual static-if form B keys under top-level env with validate disabled", () => {
    const source = `name: t
on: push
params:
  deploy:
    type: boolean
    default: true
env:
  static-if(params.deploy):
    DEPLOY_TOKEN: abc
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
    const result = transpile(source, { fileName: "t.actio.yml", validate: false });
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.message.includes("[static-if-residual]")),
    ).toBe(true);
    expect(result.yaml.includes("static-if")).toBe(false);
  });

  it("allows top-level env without static-if directives", () => {
    const result = transpileResult(`name: t
on: push
env:
  DEPLOY_TOKEN: abc
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false);
  });

  it("errors when a fragment injects a residual static-if directive", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  deploy:
    type: boolean
    default: false
fragments:
  gated:
    - run: echo hidden
      static-if: params.deploy
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - inject: gated
`);
    expect(errors.some((diagnostic) => diagnostic.message.includes("[static-if-residual]"))).toBe(
      true,
    );
  });

  it("errors when a fragment injects an empty-paren residual static-if() directive", () => {
    const errors = transpileErrors(`name: x
on: [push]
fragments:
  gated:
    - run: echo hidden
      env:
        static-if():
          FLAG: "1"
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - inject: gated
`);
    expect(errors.some((diagnostic) => diagnostic.message.includes("[static-if-residual]"))).toBe(
      true,
    );
  });
});

describe("static-if behavior seams", () => {
  it("warns on form B collisions and uses last writer", () => {
    const result = transpile(
      `name: x
on: [push]
params:
  first:
    type: boolean
    default: true
  second:
    type: boolean
    default: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        env:
          static-if(params.first):
            SHARED: first
          static-if(params.second):
            SHARED: second
`,
      { fileName: "t.actio.yml" },
    );
    expect(result.ok).toBe(true);
    const warnings = transpileWarnings(`name: x
on: [push]
params:
  first:
    type: boolean
    default: true
  second:
    type: boolean
    default: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        env:
          static-if(params.first):
            SHARED: first
          static-if(params.second):
            SHARED: second
`);
    expect(
      warnings.some((diagnostic) => diagnostic.message.includes("[static-if-merge-collision]")),
    ).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ env?: { SHARED?: string } }> } };
    };
    expect(doc.jobs.build.steps[0]?.env?.SHARED).toBe("second");
  });

  // Issue #50 re-points the old for-each×static-if seam to the RUNTIME side.
  // When a whole-job runtime for-each auto-rewrites (Case A), its loop var binds
  // to `${{ matrix.<as> }}` — a runtime value not knowable at compile time. A
  // static-if reading that binding therefore fails loud with
  // [static-if-undefined-ref], never a silent miscompile. The POSITIVE static
  // composition (static-if evaluating a compile-time loop binding) is its own
  // seam, tracked as a separate follow-up issue.
  it("fails loud when static-if reads a runtime for-each loop binding (#50)", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each:
          var: item
          in: "\${{ fromJSON(needs.s.outputs.a) }}"
        steps:
          - run: echo hi
            env:
              static-if(item == 'a'):
                K: v
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-undefined-ref]")),
    ).toBe(true);
  });

  // Issue #72: the POSITIVE static composition of for-each x static-if. When a
  // for-each iterates a compile-time-known list, each iteration's loop binding
  // (item, for-each.item, index, key) is knowable at transpile time, so a
  // static-if referencing the loop var is frozen per iteration inside for-each's
  // static expansion while the binding symbol is in scope. when-compile then
  // owns the structural keep/omit/merge, so its diagnostics stay intact.
  it("evaluates static-if against a compile-time loop binding per iteration (#72)", () => {
    const result = transpileResult(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each: { var: item, in: [a, b] }
        steps:
          - run: echo {{ item }}-always
          - run: echo {{ item }}-only-a
            static-if: item == 'a'
`);
    expect(result.ok).toBe(true);
    expect(
      result.diagnostics.every(
        (diagnostic) => !diagnostic.message.includes("[static-if-undefined-ref]"),
      ),
    ).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual([
      "echo a-always",
      "echo a-only-a",
      "echo b-always",
    ]);
  });

  it("merges a loop-binding static-if(...) block per iteration (#72)", () => {
    const result = transpileResult(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each: { var: item, in: [a, b] }
        steps:
          - run: echo {{ item }}
            env:
              static-if(item == 'a'):
                ONLY_A: "yes"
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run: string; env?: { ONLY_A?: string } }> } };
    };
    expect(doc.jobs.build.steps[0]?.env?.ONLY_A).toBe("yes");
    expect(doc.jobs.build.steps[1]?.env?.ONLY_A).toBeUndefined();
  });

  it("resolves the index binding in static-if per iteration (#72)", () => {
    const result = transpileResult(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for-each: { var: item, in: [a, b, c] }
        steps:
          - run: echo {{ item }}
            static-if: index == 0
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual(["echo a"]);
  });

  it("evaluates static-if per sibling job in a serial static fan-out (#72)", () => {
    const result = transpileResult(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    for-each: { var: item, in: [a, b], parallel: false }
    steps:
      - run: echo {{ item }}-always
      - run: echo {{ item }}-only-a
        static-if: item == 'a'
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: Record<string, { steps: Array<{ run: string }> }>;
    };
    expect(doc.jobs["build-a"]?.steps.map((step) => step.run)).toEqual([
      "echo a-always",
      "echo a-only-a",
    ]);
    expect(doc.jobs["build-b"]?.steps.map((step) => step.run)).toEqual(["echo b-always"]);
  });

  // The runtime/dynamic case must keep failing loud (the #50 invariant): a
  // parallel matrix renders ONE shared body whose loop var lowers to
  // `${{ matrix.<as> }}`, so the binding is genuinely runtime and static-if on
  // it stays unresolved.
  it("still fails loud for static-if on a parallel-matrix loop binding (#72)", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    for-each: { var: item, in: [a, b], parallel: true }
    steps:
      - run: echo hi
        static-if: item == 'a'
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-undefined-ref]")),
    ).toBe(true);
  });

  // for-each only freezes the condition; when-compile still owns structure, so a
  // sibling job whose every step is dropped by a per-iteration static-if still
  // raises the empty-job diagnostic.
  it("preserves the empty-job check when a loop static-if drops every step (#72)", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    for-each: { var: item, in: [a, b], parallel: false }
    steps:
      - run: echo {{ item }}
        static-if: item == 'a'
`);
    expect(errors.some((diagnostic) => diagnostic.message.includes("[static-if-empty-job]"))).toBe(
      true,
    );
  });

  it("supports parser precedence, literals, and stdlib calls", () => {
    const result = transpileResult(`name: x
on: [push]
params:
  mode:
    type: string
    default: prod
  count:
    type: number
    default: 3
  labels:
    type: object
    default:
      - alpha
      - beta
  profile:
    type: object
    default:
      flags:
        ship: true
      score: 7
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo keep-a
        static-if: (params.count >= 3 && params.mode == 'prod') || false
      - run: echo keep-b
        static-if: contains(params.labels, 'beta')
      - run: echo keep-c
        static-if: startsWith(params.mode, 'pr') && endsWith(params.mode, 'od')
      - run: echo keep-d
        static-if: format('{0}-{1}', params.mode, params.count) == 'prod-3'
      - run: echo keep-e
        static-if: defined(params.profile.flags.ship)
      - run: echo drop-f
        static-if: params.profile.score < 0
      - run: echo keep-g
        static-if: params.profile['flags']['ship'] == true
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual([
      "echo keep-a",
      "echo keep-b",
      "echo keep-c",
      "echo keep-d",
      "echo keep-e",
      "echo keep-g",
    ]);
  });

  it("supports decimal comparisons and escaped strings", () => {
    const result = transpileResult(`name: x
on: [push]
params:
  pi:
    type: number
    default: 3.14
  quote:
    type: string
    default: 'say "hi"'
  apostrophe:
    type: string
    default: "pro'd"
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo keep-decimal
        static-if: params.pi >= 3.14
      - run: echo keep-double-quote
        static-if: params.quote == 'say "hi"'
      - run: echo keep-single-quote
        static-if: params.apostrophe == 'pro''d'
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual([
      "echo keep-decimal",
      "echo keep-double-quote",
      "echo keep-single-quote",
    ]);
  });

  it("parses double-quoted static-if strings ending in even backslashes", () => {
    const result = transpileResult(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo keep-even-backslash
        static-if: '"path\\\\" == "path\\\\"'
      - run: echo keep-after-even-backslash
        static-if: '"path\\\\" != "other"'
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual([
      "echo keep-even-backslash",
      "echo keep-after-even-backslash",
    ]);
  });

  it("handles null literal brackets and defined(null) semantics", () => {
    const result = transpileResult(`name: x
on: [push]
params:
  dict:
    type: object
    default:
      null: enabled
      true: yes
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo keep-null-key
        static-if: params.dict[null] == 'enabled'
      - run: echo keep-true-key
        static-if: params.dict[true] == 'yes'
      - run: echo drop-defined-null
        static-if: defined(null)
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual([
      "echo keep-null-key",
      "echo keep-true-key",
    ]);
  });

  it("treats unresolved refs in defined() as false without undefined-ref diagnostics", () => {
    const result = transpileResult(`name: x
on: [push]
params:
  profile:
    type: object
    default: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo always
      - run: echo probe
        static-if: defined(params.profile.flags.ship)
`);
    expect(result.ok).toBe(true);
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("[static-if-undefined-ref]"),
      ),
    ).toBe(false);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual(["echo always"]);
  });

  it("reports undefined refs for out-of-range array access", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  values:
    type: object
    default:
      - one
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static-if: params.values[2] == 'one'
`);
    expect(
      errors.some(
        (diagnostic) =>
          diagnostic.message.includes("[static-if-undefined-ref]") &&
          diagnostic.message.includes("params.values[2]"),
      ),
    ).toBe(true);
  });

  it("resolves direct-root symbols and preserves merged object origins", () => {
    const seed: Pass = {
      name: "for-each",
      runsAfter: ["params"],
      apply: (ctx) => {
        const rootFlag: SymbolDef = {
          name: "flag",
          kind: "shared-output",
          type: "boolean",
          compileTimeKnown: true,
          valueKnown: true,
          hasDefault: false,
          required: false,
          taint: { tainted: false, derivedFrom: [] },
          value: true,
        };
        ctx.symbols.set(rootFlag.name, rootFlag);
      },
    };
    const result = transpile(
      `name: x
on: [push]
jobs:
  build:
    static-if: flag
    runs-on: ubuntu-latest
    static-if(flag):
      concurrency:
        group: ci
    steps:
      - run: echo hi
`,
      { fileName: "t.actio.yml", passes: [seed] },
    );
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { concurrency?: { group?: string }; steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.build.concurrency?.group).toBe("ci");
    expect(doc.jobs.build.steps[0]?.run).toBe("echo hi");
  });

  it("evaluates all comparison operators", () => {
    const result = transpileResult(`name: x
on: [push]
params:
  score:
    type: number
    default: 2
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo lt
        static-if: params.score < 3
      - run: echo lte
        static-if: params.score <= 2
      - run: echo gt
        static-if: params.score > 1
      - run: echo gte
        static-if: params.score >= 2
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual([
      "echo lt",
      "echo lte",
      "echo gt",
      "echo gte",
    ]);
  });

  it("uses contains() non-collection fallback as false", () => {
    const result = transpileResult(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo drop
        static-if: contains(42, 'x')
      - run: echo keep
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual(["echo keep"]);
  });

  it("accepts already-resolved boolean static-if values from earlier passes", () => {
    const seedBoolean: Pass = {
      name: "for-each",
      runsAfter: ["params"],
      apply: (ctx) => {
        const jobs = ctx.data.jobs;
        if (typeof jobs !== "object" || jobs === null) return;
        const build = jobs.build;
        if (typeof build !== "object" || build === null) return;
        const steps = (build as { steps?: unknown }).steps;
        if (!Array.isArray(steps)) return;
        const first = steps[0];
        if (typeof first !== "object" || first === null) return;
        (first as Record<string, unknown>)["static-if"] = true;
      },
    };
    const result = transpileResult(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);
    expect(result.ok).toBe(true);
    const patched = transpile(
      `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`,
      { fileName: "t.actio.yml", passes: [seedBoolean] },
    );
    expect(patched.ok).toBe(true);
    const doc = parse(patched.yaml) as {
      jobs: { build: { steps: Array<{ run?: string; "static-if"?: unknown }> } };
    };
    expect(doc.jobs.build.steps[0]?.run).toBe("echo hi");
    expect(doc.jobs.build.steps[0]).not.toHaveProperty("static-if");
  });
});
