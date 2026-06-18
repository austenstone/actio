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

describe("when_compile diagnostics", () => {
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
        when_compile: github.ref == 'refs/heads/main'
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[when-compile-runtime-context]")),
    ).toBe(true);
  });

  it("keeps when_compile runtime-root checks in parity with the shared runtime root list", () => {
    for (const root of RUNTIME_CONTEXT_ROOTS) {
      const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        when_compile: ${root}.ref == 'x'
`);
      expect(
        errors.some((diagnostic) => diagnostic.message.includes("[when-compile-runtime-context]")),
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
        when_compile: params.mode
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[when-compile-non-boolean]")),
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
        when_compile: false && params.typoed
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[when-compile-undefined-ref]")),
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
    when_compile: params.deploy
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
      errors.some((diagnostic) => diagnostic.message.includes("[when-compile-dangling-needs]")),
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
        when_compile: ""
`);
    expect(errors.some((diagnostic) => diagnostic.message.includes("[when-compile-empty]"))).toBe(
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
        when_compile: params.keep
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[when-compile-empty-job]")),
    ).toBe(true);
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
          when_compile(params.keep): nope
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[when-compile-merge-non-map]")),
    ).toBe(true);
  });

  it("rejects runtime wrapper syntax in when_compile values", () => {
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
        when_compile: \${{ params.deploy }}
      - run: echo ok
        when_compile: \${{ github.ref == 'refs/heads/main' }}
`);
    expect(errors.some((diagnostic) => diagnostic.message.includes("[params-runtime-sigil]"))).toBe(
      true,
    );
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[when-compile-runtime-context]")),
    ).toBe(true);
  });

  it("rejects wrapper syntax even when no runtime root is referenced", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        when_compile: \${{ true }}
`);
    expect(
      errors.some(
        (diagnostic) =>
          diagnostic.message.includes("[when-compile-runtime-context]") &&
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
        when_compile: \${{ contains('a}}b', '}}') }}
`);
    expect(
      errors.some(
        (diagnostic) =>
          diagnostic.message.includes("[when-compile-runtime-context]") &&
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
        when_compile: params.deploy &&
`);
    expect(errors.some((diagnostic) => diagnostic.message.includes("[when-compile-empty]"))).toBe(
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
        when_compile: true false
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
        when_compile: params.deploy[foo]
`);
    expect(
      leftovers.some((diagnostic) => diagnostic.message.includes("[when-compile-empty]")),
    ).toBe(true);
    expect(
      badBracket.some((diagnostic) => diagnostic.message.includes("[when-compile-empty]")),
    ).toBe(true);
  });

  it("errors on unknown function calls", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        when_compile: nope()
`);
    expect(
      errors.some(
        (diagnostic) =>
          diagnostic.message.includes("[when-compile-non-boolean]") &&
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
        when_compile: "!params.mode"
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
        when_compile: params.mode && true
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
        when_compile: params.deploy < true
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
          when_compile(github.ref == 'refs/heads/main'):
            FLAG: "1"
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[when-compile-runtime-context]")),
    ).toBe(true);
  });

  it("errors when when_compile value is neither string nor boolean", () => {
    const errors = transpileErrors(`name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
        when_compile: 1
`);
    expect(
      errors.some((diagnostic) =>
        diagnostic.message.includes("must resolve to a boolean expression"),
      ),
    ).toBe(true);
  });

  it("errors on residual non-structural when_compile keys", () => {
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
          when_compile: params.deploy
          KEEP: yes
`);
    expect(result.ok).toBe(false);
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("[when-compile-residual]"),
      ),
    ).toBe(true);
    const output = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ env?: { when_compile?: string; KEEP?: string } }> } };
    };
    expect(output.jobs.build.steps[0]?.env?.when_compile).toBeUndefined();
    expect(output.jobs.build.steps[0]?.env?.KEEP).toBe("yes");
  });

  it("errors when a fragment injects a residual when_compile directive", () => {
    const errors = transpileErrors(`name: x
on: [push]
params:
  deploy:
    type: boolean
    default: false
fragments:
  gated:
    - run: echo hidden
      when_compile: params.deploy
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - inject: gated
`);
    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[when-compile-residual]")),
    ).toBe(true);
  });
});

describe("when_compile behavior seams", () => {
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
          when_compile(params.first):
            SHARED: first
          when_compile(params.second):
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
          when_compile(params.first):
            SHARED: first
          when_compile(params.second):
            SHARED: second
`);
    expect(
      warnings.some((diagnostic) => diagnostic.message.includes("[when-compile-merge-collision]")),
    ).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ env?: { SHARED?: string } }> } };
    };
    expect(doc.jobs.build.steps[0]?.env?.SHARED).toBe("second");
  });

  it("evaluates against a seeded loop binding symbol (TODO(for-each-integration))", () => {
    const loopBindingSymbol: SymbolDef = {
      name: "for_each.item",
      kind: "shared-output",
      type: "object",
      compileTimeKnown: true,
      valueKnown: true,
      hasDefault: false,
      required: false,
      taint: { tainted: false, derivedFrom: [] },
      value: { enabled: true },
    };
    const seedLoopBinding: Pass = {
      name: "for_each",
      runsAfter: ["params"],
      apply: (ctx) => {
        ctx.symbols.set(loopBindingSymbol.name, loopBindingSymbol);
      },
    };
    const rendered = transpile(
      `name: x
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo kept
        when_compile: for_each.item.enabled
      - run: echo always
`,
      {
        fileName: "t.actio.yml",
        passes: [seedLoopBinding],
      },
    );
    expect(rendered.ok).toBe(true);
    const doc = parse(rendered.yaml) as {
      jobs: { build: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual(["echo kept", "echo always"]);
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
        when_compile: (params.count >= 3 && params.mode == 'prod') || false
      - run: echo keep-b
        when_compile: contains(params.labels, 'beta')
      - run: echo keep-c
        when_compile: startsWith(params.mode, 'pr') && endsWith(params.mode, 'od')
      - run: echo keep-d
        when_compile: format('{0}-{1}', params.mode, params.count) == 'prod-3'
      - run: echo keep-e
        when_compile: defined(params.profile.flags.ship)
      - run: echo drop-f
        when_compile: params.profile.score < 0
      - run: echo keep-g
        when_compile: params.profile['flags']['ship'] == true
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
        when_compile: params.pi >= 3.14
      - run: echo keep-double-quote
        when_compile: params.quote == 'say "hi"'
      - run: echo keep-single-quote
        when_compile: params.apostrophe == 'pro''d'
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
        when_compile: params.dict[null] == 'enabled'
      - run: echo keep-true-key
        when_compile: params.dict[true] == 'yes'
      - run: echo drop-defined-null
        when_compile: defined(null)
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
        when_compile: defined(params.profile.flags.ship)
`);
    expect(result.ok).toBe(true);
    expect(
      result.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("[when-compile-undefined-ref]"),
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
        when_compile: params.values[2] == 'one'
`);
    expect(
      errors.some(
        (diagnostic) =>
          diagnostic.message.includes("[when-compile-undefined-ref]") &&
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
    when_compile: flag
    runs-on: ubuntu-latest
    when_compile(flag):
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
        when_compile: params.score < 3
      - run: echo lte
        when_compile: params.score <= 2
      - run: echo gt
        when_compile: params.score > 1
      - run: echo gte
        when_compile: params.score >= 2
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
        when_compile: contains(42, 'x')
      - run: echo keep
`);
    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { build: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.build.steps.map((step) => step.run)).toEqual(["echo keep"]);
  });

  it("accepts already-resolved boolean when_compile values from earlier passes", () => {
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
        (first as Record<string, unknown>).when_compile = true;
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
      jobs: { build: { steps: Array<{ run?: string; when_compile?: unknown }> } };
    };
    expect(doc.jobs.build.steps[0]?.run).toBe("echo hi");
    expect(doc.jobs.build.steps[0]).not.toHaveProperty("when_compile");
  });
});
