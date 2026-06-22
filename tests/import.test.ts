import type { ModuleResolver, PinPolicy, TranspileOptions } from "actio-core";
import { deepMerge, transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Flat in-memory resolver: module ids are the spec minus any leading `./`/`../`. */
const idOf = (spec: string) => spec.replace(/^(\.\.?\/)+/, "");

const resolverOf = (modules: Record<string, string>): ModuleResolver => ({
  resolve(spec) {
    const id = idOf(spec);
    return id in modules ? { id, source: modules[id] } : undefined;
  },
});

type Built = {
  ok: boolean;
  yaml: string;
  codes: string[];
  messages: string[];
  doc: Record<string, unknown>;
  pinTargets: { key: string }[];
};

const build = (
  source: string,
  modules?: Record<string, string>,
  opts: Partial<TranspileOptions> = {},
): Built => {
  const result = transpile(source, {
    fileName: "input.actio.yml",
    validate: true,
    modules: modules ? resolverOf(modules) : undefined,
    ...opts,
  });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  return {
    ok: result.ok,
    yaml: result.yaml,
    codes: errors.map((d) => d.code).filter((c): c is string => Boolean(c)),
    messages: errors.map((d) => d.message),
    doc: result.yaml ? (parse(result.yaml) ?? {}) : {},
    pinTargets: (result.pinTargets ?? []).map((t) => ({ key: t.key })),
  };
};

const importer = (body: string) => `name: ci\non: [push]\n${body}`;

describe("cross-file import: step inject", () => {
  it("splices a template step-list, binds with: params, resolves source templates", () => {
    const lib = `
let:
  greeting: from-module
templates:
  greet:
    params:
      who: { type: string }
    steps:
      - run: echo "{{ let.greeting }} {{ args.who }}"
`;
    const r = build(
      importer(`jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: ./lib.actio.yml#greet
        with:
          who: world
`),
      { "lib.actio.yml": lib },
    );
    expect(r.ok).toBe(true);
    const steps = (r.doc.jobs as Record<string, { steps: { run: string }[] }>).a.steps;
    // let.greeting resolves in the MODULE's lexical scope, args.who from importer with:
    expect(steps[0].run).toBe('echo "from-module world"');
  });

  it("keeps {{ }} lexical to the source file, not the importer", () => {
    const lib = `
let:
  greeting: from-module
templates:
  greet:
    steps:
      - run: echo {{ let.greeting }}
`;
    const r = build(
      importer(`let:
  greeting: from-importer
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: ./lib.actio.yml#greet
`),
      { "lib.actio.yml": lib },
    );
    expect(r.ok).toBe(true);
    const steps = (r.doc.jobs as Record<string, { steps: { run: string }[] }>).a.steps;
    expect(steps[0].run).toBe("echo from-module");
  });

  it("resolves the source file's _anchors", () => {
    const lib = `
_anchors:
  co: &co { uses: actions/checkout@v4 }
templates:
  withAnchor:
    steps:
      - *co
      - run: build
`;
    const r = build(
      importer(`jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: ./lib.actio.yml#withAnchor
`),
      { "lib.actio.yml": lib },
    );
    expect(r.ok).toBe(true);
    const steps = (r.doc.jobs as Record<string, { steps: Record<string, string>[] }>).a.steps;
    expect(steps[0].uses).toBe("actions/checkout@v4");
    expect(steps[1].run).toBe("build");
  });

  it("splices a parameterless fragment", () => {
    const lib = `
fragments:
  setup:
    - uses: actions/checkout@v4
    - run: npm ci
`;
    const r = build(
      importer(`jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: ./lib.actio.yml#setup
      - run: npm test
`),
      { "lib.actio.yml": lib },
    );
    expect(r.ok).toBe(true);
    const steps = (r.doc.jobs as Record<string, { steps: Record<string, string>[] }>).a.steps;
    expect(steps.map((s) => s.uses ?? s.run)).toEqual([
      "actions/checkout@v4",
      "npm ci",
      "npm test",
    ]);
  });
});

describe("cross-file import: job-body inject", () => {
  const lib = `
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - run: deploy
`;

  it("inlines an imported job; local key becomes the emitted id", () => {
    const r = build(
      importer(`jobs:
  release:
    inject: ./lib.actio.yml#deploy
`),
      { "lib.actio.yml": lib },
    );
    expect(r.ok).toBe(true);
    const jobs = r.doc.jobs as Record<string, unknown>;
    expect(Object.keys(jobs)).toEqual(["release"]);
  });

  it("deep-merges sibling overrides: maps merge, scalars win", () => {
    const r = build(
      importer(`jobs:
  release:
    inject: ./lib.actio.yml#deploy
    permissions:
      contents: write
`),
      { "lib.actio.yml": lib },
    );
    expect(r.ok).toBe(true);
    const job = (r.doc.jobs as Record<string, { permissions: Record<string, string> }>).release;
    // contents overridden, id-token preserved from import (deep map merge)
    expect(job.permissions).toEqual({ contents: "write", "id-token": "write" });
  });

  it("replaces arrays rather than concatenating them", () => {
    const r = build(
      importer(`jobs:
  release:
    inject: ./lib.actio.yml#deploy
    steps:
      - run: only-this
`),
      { "lib.actio.yml": lib },
    );
    expect(r.ok).toBe(true);
    const job = (r.doc.jobs as Record<string, { steps: { run: string }[] }>).release;
    expect(job.steps.map((s) => s.run)).toEqual(["only-this"]);
  });
});

describe("cross-file import: native passthrough", () => {
  it("passes uses: action and reusable workflow refs through byte-for-byte", () => {
    const lib = `
templates:
  t:
    steps:
      - uses: actions/checkout@v4
      - uses: owner/repo/.github/workflows/ci.yml@v1
`;
    const r = build(
      importer(`jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: ./lib.actio.yml#t
`),
      { "lib.actio.yml": lib },
    );
    expect(r.ok).toBe(true);
    expect(r.yaml).toContain("uses: actions/checkout@v4");
    expect(r.yaml).toContain("uses: owner/repo/.github/workflows/ci.yml@v1");
  });

  it("pins imported uses: refs via the terminal pin pass", () => {
    const sha = "b".repeat(40);
    const lib = `
templates:
  t:
    steps:
      - uses: owner/act@v1
`;
    const policy: PinPolicy = {
      enabled: true,
      thirdParty: true,
      github: false,
      docker: true,
      allow: [],
      comment: "tag",
    };
    const r = build(
      importer(`jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: ./lib.actio.yml#t
`),
      { "lib.actio.yml": lib },
      { pin: { policy, resolutions: { "owner/act@v1": { digest: sha } } } },
    );
    expect(r.yaml).toContain(`uses: owner/act@${sha}`);
    expect(r.pinTargets.map((t) => t.key)).toContain("owner/act@v1");
  });
});

describe("cross-file import: diagnostics", () => {
  const lib = `
templates:
  greet:
    params:
      who: { type: string }
    steps:
      - run: echo {{ args.who }}
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: deploy
`;
  const mods = { "lib.actio.yml": lib };

  const stepInject = (selector: string, withBlock = "") =>
    build(
      importer(`jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: ${selector}${withBlock}
`),
      mods,
    );

  it("import-module-not-found: no resolver injected", () => {
    const r = build(
      importer(`jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: ./lib.actio.yml#greet
`),
    );
    expect(r.codes).toContain("import-module-not-found");
  });

  it("import-module-not-found: job-body inject with no resolver", () => {
    const r = build(
      importer(`jobs:
  deploy:
    inject: ./lib.actio.yml#deployJob
`),
    );
    expect(r.codes).toContain("import-module-not-found");
  });

  it("import-module-not-found: resolver yields nothing", () => {
    const r = stepInject("./missing.actio.yml#greet");
    expect(r.codes).toContain("import-module-not-found");
  });

  it("import-define-not-found: name absent from module (step)", () => {
    const r = stepInject("./lib.actio.yml#nope");
    expect(r.codes).toContain("import-define-not-found");
  });

  it("import-define-not-found: job name absent from module", () => {
    const r = build(
      importer(`jobs:
  release:
    inject: ./lib.actio.yml#ghost
`),
      mods,
    );
    expect(r.codes).toContain("import-define-not-found");
  });

  it("import-local-ref-version: selector carries an @ref", () => {
    const r = stepInject("./lib.actio.yml@v1#greet");
    expect(r.codes).toContain("import-local-ref-version");
  });

  it("import-unknown-param: with: key is not a declared param", () => {
    const r = stepInject(
      "./lib.actio.yml#greet",
      `
        with:
          bogus: 1`,
    );
    expect(r.codes).toContain("import-unknown-param");
  });

  it("import-malformed-module: missing #name", () => {
    expect(stepInject("./lib.actio.yml").codes).toContain("import-malformed-module");
  });

  it("import-malformed-module: two # in selector", () => {
    expect(stepInject("./lib.actio.yml#a#b").codes).toContain("import-malformed-module");
  });

  it("import-malformed-module: non-relative path", () => {
    expect(stepInject("lib.actio.yml#greet").codes).toContain("import-malformed-module");
  });

  it("import-malformed-module: wrong extension (.yml)", () => {
    expect(stepInject("./lib.yml#greet").codes).toContain("import-malformed-module");
  });

  it("import-malformed-module: invalid define name", () => {
    expect(stepInject("./lib.actio.yml#1bad").codes).toContain("import-malformed-module");
  });

  it("import-malformed-module: unparseable module source", () => {
    const r = build(
      importer(`jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: ./broken.actio.yml#greet
`),
      { "broken.actio.yml": "name: x\non: [push]\njobs: [oops" },
    );
    expect(r.codes).toContain("import-malformed-module");
  });
});

describe("cross-file import: cycle detection", () => {
  it("errors on A -> B -> A with the full chain", () => {
    const a = `
templates:
  x:
    steps:
      - inject: ./b.actio.yml#y
`;
    const b = `
templates:
  y:
    steps:
      - inject: ./a.actio.yml#x
`;
    const r = build(
      importer(`jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: ./a.actio.yml#x
`),
      { "a.actio.yml": a, "b.actio.yml": b },
    );
    expect(r.codes).toContain("import-cycle");
    const cycle = r.messages.find((m) => m.includes("->"));
    expect(cycle).toContain("a.actio.yml -> b.actio.yml -> a.actio.yml");
  });

  it("errors on direct self-import", () => {
    const self = `
templates:
  loop:
    steps:
      - inject: ./self.actio.yml#loop
`;
    const r = build(
      importer(`jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - inject: ./self.actio.yml#loop
`),
      { "self.actio.yml": self },
    );
    expect(r.codes).toContain("import-cycle");
  });
});

describe("deepMerge (GitLab include semantics)", () => {
  it("merges maps recursively, last write wins", () => {
    expect(deepMerge({ a: { x: 1, y: 2 } }, { a: { y: 3, z: 4 } })).toEqual({
      a: { x: 1, y: 3, z: 4 },
    });
  });

  it("replaces arrays instead of concatenating", () => {
    expect(deepMerge({ a: [1, 2, 3] }, { a: [9] })).toEqual({ a: [9] });
  });

  it("overrides scalars and adds new keys", () => {
    expect(deepMerge({ a: 1, b: 2 }, { a: 5, c: 9 })).toEqual({ a: 5, b: 2, c: 9 });
  });

  it("returns the override when types differ", () => {
    expect(deepMerge({ a: 1 }, [1, 2])).toEqual([1, 2]);
    expect(deepMerge([1], { a: 1 })).toEqual({ a: 1 });
  });
});
