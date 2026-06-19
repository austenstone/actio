import { type Pass, type SymbolDef, transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { RUNTIME_CONTEXT_ROOTS } from "../packages/core/src/symbols.js";

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

describe("static_if diagnostics", () => {
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
        static_if: github.ref == 'refs/heads/main'
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-runtime-context]")),
    ).toBe(true);
  });

  it("keeps static_if runtime-root checks in parity with the shared runtime root list", () => {
    for (const root of RUNTIME_CONTEXT_ROOTS) {
      const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static_if: ${root}.ref == 'x'
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
        static_if: params.mode
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
        static_if: false && params.typoed
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
    static_if: params.deploy
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
        static_if: ""
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
        static_if: params.keep
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
          static_if(params.keep): nope
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-merge-non-map]")),
    ).toBe(true);
  });

  it("rejects runtime wrapper syntax in static_if values", () => {
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
        static_if: \${{ params.deploy }}
      - run: echo ok
        static_if: \${{ github.ref == 'refs/heads/main' }}
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
          static_if():
            FLAG: "1"
          KEEP: yes
`);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.message.includes("[static-if-empty]")),
    ).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: {
        build: {
          steps: Array<{ env?: { KEEP?: string; "static_if()"?: { FLAG?: string } } }>;
        };
      };
    };
    expect(doc.jobs.build.steps[0]?.env?.["static_if()"]).toBeUndefined();
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
        static_if: \${{ true }}
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
        static_if: \${{ contains('a}}b', '}}') }}
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
        static_if: params.deploy &&
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
        static_if: true false
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
        static_if: params.deploy[foo]
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
        static_if: nope()
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
        static_if: "!params.mode"
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
        static_if: params.mode && true
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
        static_if: params.deploy < true
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
          static_if(github.ref == 'refs/heads/main'):
            FLAG: "1"
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-runtime-context]")),
    ).toBe(true);
  });

  it("errors when static_if value is neither string nor boolean", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        static_if: 1
`);
    expect(
      errors.some((diagnostic) =>
        diagnostic.message.includes("must resolve to a boolean expression"),
      ),
    ).toBe(true);
  });

  it("errors on residual non-structural static_if keys", () => {
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
          static_if: params.deploy
          KEEP: yes
`);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((diagnostic) => diagnostic.message.includes("[static-if-residual]")),
    ).toBe(true);
    const output = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ env?: { static_if?: string; KEEP?: string } }> } };
    };
    expect(output.jobs.build.steps[0]?.env?.static_if).toBeUndefined();
    expect(output.jobs.build.steps[0]?.env?.KEEP).toBe("yes");
  });

  it("fails loud on residual static_if form B keys under top-level env", () => {
    const source = `name: t
on: push
params:
  deploy:
    type: boolean
    default: true
env:
  static_if(params.deploy):
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
    expect(result.yaml.includes("static_if")).toBe(false);
  });

  it("fails loud on residual static_if form B keys under top-level env with validate disabled", () => {
    const source = `name: t
on: push
params:
  deploy:
    type: boolean
    default: true
env:
  static_if(params.deploy):
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
    expect(result.yaml.includes("static_if")).toBe(false);
  });

  it("allows top-level env without static_if directives", () => {
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

  it("errors when a fragment injects a residual static_if directive", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  deploy:
    type: boolean
    default: false
fragments:
  gated:
    - run: echo hidden
      static_if: params.deploy
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

  it("errors when a fragment injects an empty-paren residual static_if() directive", () => {
    const errors = transpileErrors(`name: x
on: [push]
fragments:
  gated:
    - run: echo hidden
      env:
        static_if():
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

describe("static_if behavior seams", () => {
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
          static_if(params.first):
            SHARED: first
          static_if(params.second):
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
          static_if(params.first):
            SHARED: first
          static_if(params.second):
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

  // Issue #50 re-points the old for_each×static_if seam to the RUNTIME side.
  // When a whole-job runtime for_each auto-rewrites (Case A), its loop var binds
  // to `${{ matrix.<as> }}` — a runtime value not knowable at compile time. A
  // static_if reading that binding therefore fails loud with
  // [static-if-undefined-ref], never a silent miscompile. The POSITIVE static
  // composition (static_if evaluating a compile-time loop binding) is its own
  // seam, tracked as a separate follow-up issue.
  it("fails loud when static_if reads a runtime for_each loop binding (#50)", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - for_each:
          var: item
          in: "\${{ fromJSON(needs.s.outputs.a) }}"
        steps:
          - run: echo hi
            env:
              static_if(item == 'a'):
                K: v
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[static-if-undefined-ref]")),
    ).toBe(true);
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
        static_if: (params.count >= 3 && params.mode == 'prod') || false
      - run: echo keep-b
        static_if: contains(params.labels, 'beta')
      - run: echo keep-c
        static_if: startsWith(params.mode, 'pr') && endsWith(params.mode, 'od')
      - run: echo keep-d
        static_if: format('{0}-{1}', params.mode, params.count) == 'prod-3'
      - run: echo keep-e
        static_if: defined(params.profile.flags.ship)
      - run: echo drop-f
        static_if: params.profile.score < 0
      - run: echo keep-g
        static_if: params.profile['flags']['ship'] == true
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
        static_if: params.pi >= 3.14
      - run: echo keep-double-quote
        static_if: params.quote == 'say "hi"'
      - run: echo keep-single-quote
        static_if: params.apostrophe == 'pro''d'
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
        static_if: params.dict[null] == 'enabled'
      - run: echo keep-true-key
        static_if: params.dict[true] == 'yes'
      - run: echo drop-defined-null
        static_if: defined(null)
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
        static_if: defined(params.profile.flags.ship)
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
        static_if: params.values[2] == 'one'
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
      name: "for_each",
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
    static_if: flag
    runs-on: ubuntu-latest
    static_if(flag):
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
        static_if: params.score < 3
      - run: echo lte
        static_if: params.score <= 2
      - run: echo gt
        static_if: params.score > 1
      - run: echo gte
        static_if: params.score >= 2
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
        static_if: contains(42, 'x')
      - run: echo keep
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual(["echo keep"]);
  });

  it("accepts already-resolved boolean static_if values from earlier passes", () => {
    const seedBoolean: Pass = {
      name: "for_each",
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
        (first as Record<string, unknown>).static_if = true;
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
      jobs: { build: { steps: Array<{ run?: string; static_if?: unknown }> } };
    };
    expect(doc.jobs.build.steps[0]?.run).toBe("echo hi");
    expect(doc.jobs.build.steps[0]).not.toHaveProperty("static_if");
  });
});
