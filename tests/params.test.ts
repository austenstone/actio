import { applyPasses, builtinPasses, type Pass, parseActio, transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function errorsFor(source: string) {
  const result = transpile(source, { fileName: "t.actio.yml" });
  return result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
}

function errorMessages(source: string): string[] {
  return errorsFor(source).map((diagnostic) => diagnostic.message);
}

describe("params symbols", () => {
  it("registers compile-time-known symbols with unified SymbolDef shape", () => {
    const ctx = parseActio(
      `name: x
on: [push]
params:
  target:
    type: enum
    values: [dev, prod]
    default: dev
  retries:
    type: number
    default: 3
  required_input:
    type: string
  bootstrap:
    type: stepList
    default:
      - run: npm ci
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`,
      "t.actio.yml",
    );

    applyPasses(ctx, builtinPasses);

    expect(ctx.data.params).toBeUndefined();
    expect(ctx.symbols.get("params.target")).toMatchObject({
      kind: "param-scalar",
      type: "enum",
      compileTimeKnown: true,
      hasDefault: true,
      valueKnown: true,
      required: false,
      taint: { tainted: false, derivedFrom: [] },
    });
    expect(ctx.symbols.get("params.retries")).toMatchObject({
      kind: "param-scalar",
      type: "number",
      compileTimeKnown: true,
      hasDefault: true,
      valueKnown: true,
      required: false,
      taint: { tainted: false, derivedFrom: [] },
    });
    expect(ctx.symbols.get("params.required_input")).toMatchObject({
      kind: "param-scalar",
      type: "string",
      compileTimeKnown: false,
      hasDefault: false,
      valueKnown: false,
      required: true,
      taint: { tainted: false, derivedFrom: [] },
    });
    expect(ctx.symbols.get("params.bootstrap")).toMatchObject({
      kind: "param-stepList",
      type: "stepList",
      compileTimeKnown: true,
      hasDefault: true,
      valueKnown: true,
      required: false,
      taint: { tainted: false, derivedFrom: [] },
    });
  });
});

describe("params diagnostics", () => {
  it("errors when top-level params is not a mapping", () => {
    const errors = errorMessages(`name: x
on: [push]
params: nope
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);

    expect(errors.some((message) => message.includes("[params-shape-invalid]"))).toBe(true);
  });

  it("errors when an individual param definition is not an object", () => {
    const errors = errorMessages(`name: x
on: [push]
params:
  env: prod
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);

    expect(errors.some((message) => message.includes("[param-definition-invalid]"))).toBe(true);
  });

  it("errors on invalid param type", () => {
    const errors = errorMessages(`name: x
on: [push]
params:
  env:
    type: nope
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);

    expect(errors.some((message) => message.includes("[param-type-invalid]"))).toBe(true);
  });

  it("errors when enum values are missing", () => {
    const errors = errorMessages(`name: x
on: [push]
params:
  env:
    type: enum
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);

    expect(errors.some((message) => message.includes("[param-enum-values]"))).toBe(true);
  });

  it("errors when enum values are not all strings", () => {
    const errors = errorMessages(`name: x
on: [push]
params:
  env:
    type: enum
    values: [dev, 123]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);

    expect(errors.some((message) => message.includes("[param-enum-values]"))).toBe(true);
  });

  it("errors when a default does not match declared type", () => {
    const errors = errorMessages(`name: x
on: [push]
params:
  retries:
    type: number
    default: nope
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);

    expect(errors.some((message) => message.includes("[param-default-type]"))).toBe(true);
  });

  it("errors on runtime-sigil params references", () => {
    const errors = errorsFor(`name: x
on: [push]
params:
  env:
    type: string
    default: prod
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ params.env }}"
`);

    expect(errors.some((diagnostic) => diagnostic.message.includes("[params-runtime-sigil]"))).toBe(
      true,
    );
  });

  it("errors when runtime expressions nest params usage under fromJSON", () => {
    const errors = errorsFor(`name: x
on: [push]
params:
  config:
    type: object
    default:
      image: app
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ fromJSON(params.config).image }}"
`);

    expect(errors.some((diagnostic) => diagnostic.message.includes("[params-runtime-sigil]"))).toBe(
      true,
    );
  });

  it("errors when params root is used inside runtime function arguments", () => {
    const errors = errorsFor(`name: x
on: [push]
params:
  env:
    type: string
    default: prod
  targets:
    type: object
    default: [x, y]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ toJSON(params.env) }}"
      - run: echo "\${{ contains(params.targets, 'x') }}"
`);

    const runtimeSigilErrors = errors.filter((diagnostic) =>
      diagnostic.message.includes("[params-runtime-sigil]"),
    );
    expect(runtimeSigilErrors.length).toBe(2);
  });

  it("errors when params root is used within nested runtime expressions", () => {
    const errors = errorsFor(`name: x
on: [push]
params:
  name:
    type: string
    default: a
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ format('{0}', params.name) }}"
`);

    expect(errors.some((diagnostic) => diagnostic.message.includes("[params-runtime-sigil]"))).toBe(
      true,
    );
  });

  it("does not flag params when it is a non-root path segment in runtime expressions", () => {
    const errors = errorsFor(`name: x
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - id: params
        run: echo "x=ok" >> "$GITHUB_OUTPUT"
      - run: echo "\${{ steps.params.outputs.x }}"
`);

    expect(errors.some((diagnostic) => diagnostic.message.includes("[params-runtime-sigil]"))).toBe(
      false,
    );
  });

  it("does not flag identifiers that only contain params as a substring", () => {
    const errors = errorsFor(`name: x
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ vars.myparams }}"
`);

    expect(errors.some((diagnostic) => diagnostic.message.includes("[params-runtime-sigil]"))).toBe(
      false,
    );
  });

  it("does not flag params text inside runtime string literals", () => {
    const errors = errorsFor(`name: x
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ format('params.x', github.ref) }}"
`);

    expect(errors.some((diagnostic) => diagnostic.message.includes("[params-runtime-sigil]"))).toBe(
      false,
    );
  });

  it("does not treat compile-time sigils as runtime params usage", () => {
    const errors = errorsFor(`name: x
on: [push]
params:
  x:
    type: string
    default: ok
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "{{ params.x }}"
`);

    expect(errors.some((diagnostic) => diagnostic.message.includes("[params-runtime-sigil]"))).toBe(
      false,
    );
  });

  it("errors when interpolating non-scalars without toJSON", () => {
    const errors = errorsFor(`name: x
on: [push]
params:
  config:
    type: object
    default:
      image: app
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "{{ params.config }}"
`);

    expect(errors.some((diagnostic) => diagnostic.message.includes("[interp-non-scalar]"))).toBe(
      true,
    );
  });

  it("errors on unresolved compile-time interpolation", () => {
    const errors = errorsFor(`name: x
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "{{ params.missing }}"
`);

    expect(errors.some((diagnostic) => diagnostic.message.includes("[interp-unresolved]"))).toBe(
      true,
    );
  });

  it("validates enum defaults against allowed values", () => {
    const errors = errorsFor(`name: x
on: [push]
params:
  env:
    type: enum
    values: [dev, prod]
    default: staging
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);

    expect(errors.some((diagnostic) => diagnostic.message.includes("[param-enum-default]"))).toBe(
      true,
    );
  });

  it("errors when a param definition contains unknown keys", () => {
    const errors = errorsFor(`name: x
on: [push]
params:
  env:
    type: string
    default: prod
    description: Production environment
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`);

    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[param-definition-key-unknown]")),
    ).toBe(true);
  });

  it("errors when a scalar param is used in a steps position", () => {
    const errors = errorsFor(`name: x
on: [push]
params:
  script:
    type: string
    default: echo hi
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps: params.script
`);

    expect(
      errors.some((diagnostic) => diagnostic.message.includes("[param-structural-type]")),
    ).toBe(true);
  });
});

describe("params interpolation", () => {
  it("resolves bare stepList references structurally in steps positions", () => {
    const result = transpile(
      `name: x
on: [push]
params:
  bootstrap:
    type: stepList
    default:
      - uses: actions/checkout@v4
      - run: npm test
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps: params.bootstrap
`,
      { fileName: "t.actio.yml" },
    );

    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { deploy: { steps: Array<{ uses?: string; run?: string }> } };
    };
    expect(doc.jobs.deploy.steps).toEqual([{ uses: "actions/checkout@v4" }, { run: "npm test" }]);
  });

  it("resolves bare scalar references structurally in directive value positions", () => {
    const result = transpile(
      `name: x
on: [push]
params:
  script:
    type: string
    default: echo hello
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: params.script
`,
      { fileName: "t.actio.yml" },
    );

    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { deploy: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.deploy.steps[0]?.run).toBe("echo hello");
  });

  it("resolves compile-time interpolation that enters via fragments during pass execution", () => {
    const ctx = parseActio(
      `name: x
on: [push]
params:
  greeting:
    type: string
    default: hello
fragments:
  setup:
    - run: echo "{{ params.greeting }}"
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - inject: setup
`,
      "t.actio.yml",
    );

    applyPasses(ctx, builtinPasses);

    expect(
      (ctx.data.jobs as { deploy: { steps: Array<{ run?: string }> } }).deploy.steps[0]?.run,
    ).toBe('echo "hello"');
  });

  it("resolves {{ params.* }} and toJSON(params.*) into final literals", () => {
    const result = transpile(
      `name: x
on: [push]
params:
  env:
    type: string
    default: prod
  config:
    type: object
    default:
      shards: [a, b]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "env={{ params.env }}"
      - run: echo '{{ toJSON(params.config) }}'
`,
      { fileName: "t.actio.yml" },
    );

    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { deploy: { steps: Array<{ run?: string }> } };
    };
    const runs = doc.jobs.deploy.steps.map((step) => step.run);
    expect(runs).toContain('echo "env=prod"');
    expect(runs).toContain(`echo '{"shards":["a","b"]}'`);
  });

  it("resolves runtime expressions that are not params without compile-token leakage", () => {
    const result = transpile(
      `name: x
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.ref }}"
`,
      { fileName: "t.actio.yml" },
    );

    expect(result.ok).toBe(true);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    expect(result.yaml).toContain("${{ github.ref }}");
  });

  it("errors on unclosed compile-time interpolation", () => {
    const errors = errorMessages(`name: x
on: [push]
params:
  env:
    type: string
    default: prod
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "{{ params.env"
`);

    expect(errors.some((message) => message.includes("[interp-unresolved]"))).toBe(true);
  });

  it("errors on invalid compile-time expression syntax", () => {
    const errors = errorMessages(`name: x
on: [push]
params:
  env:
    type: string
    default: prod
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "{{ params.env@bad }}"
`);

    expect(errors.some((message) => message.includes("[interp-unresolved]"))).toBe(true);
  });

  it("errors when resolving a nested path that does not exist on a known symbol", () => {
    const errors = errorMessages(`name: x
on: [push]
params:
  config:
    type: object
    default:
      image: app
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "{{ params.config.tag }}"
`);

    expect(errors.some((message) => message.includes("[interp-unresolved]"))).toBe(true);
  });

  it("resolves symbols registered at root key paths", () => {
    const source = `name: x
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "{{ share.value }}"
`;
    const seedShareSymbol: Pass = {
      name: "seed_share_symbol",
      runsAfter: ["params"],
      apply: (ctx) => {
        ctx.symbols.set("share.value", {
          name: "share.value",
          kind: "shared-output",
          type: "string",
          compileTimeKnown: true,
          valueKnown: true,
          hasDefault: false,
          required: false,
          taint: { tainted: false, derivedFrom: [] },
          value: "ok",
        });
      },
    };
    const result = transpile(source, {
      fileName: "t.actio.yml",
      passes: [seedShareSymbol],
    });

    expect(result.ok).toBe(true);
    const doc = parse(result.yaml) as {
      jobs: { deploy: { steps: Array<{ run?: string }> } };
    };
    expect(doc.jobs.deploy.steps[0]?.run).toBe('echo "ok"');
  });

  it("errors when toJSON(...) cannot serialize a resolved value", () => {
    const source = `name: x
on: [push]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: echo "{{ toJSON(share.fn) }}"
`;
    const seedFunctionSymbol: Pass = {
      name: "seed_share_fn_symbol",
      runsAfter: ["params"],
      apply: (ctx) => {
        ctx.symbols.set("share.fn", {
          name: "share.fn",
          kind: "shared-output",
          type: "object",
          compileTimeKnown: true,
          valueKnown: true,
          hasDefault: false,
          required: false,
          taint: { tainted: false, derivedFrom: [] },
          value: () => "nope",
        });
      },
    };
    const result = transpile(source, {
      fileName: "t.actio.yml",
      passes: [seedFunctionSymbol],
    });

    const errors = result.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => diagnostic.message);
    expect(errors.some((message) => message.includes("[interp-unresolved]"))).toBe(true);
  });
});
