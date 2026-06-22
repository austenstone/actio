import { transpile } from "actio-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Opts = Record<string, unknown>;

/** Transpile and parse the generated YAML back to a JS object for assertions. */
function build(source: string, options: Opts = {}) {
  const result = transpile(source, { fileName: "t.actio.yml", ...options });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  const warnings = result.diagnostics.filter((d) => d.severity === "warning");
  const codes = result.diagnostics.map((d) => d.code);
  return { result, errors, warnings, codes, doc: result.ok ? parse(result.yaml) : undefined };
}

const infer: Opts = { permissions: { mode: "infer" } };

// biome-ignore lint/suspicious/noExplicitAny: test helper reaching into parsed YAML
const job = (doc: unknown, id = "a"): any => (doc as any).jobs[id];
// biome-ignore lint/suspicious/noExplicitAny: test helper reaching into parsed YAML
const root = (doc: unknown): any => doc as any;

/** Single-job workflow wrapper. */
function wf(steps: string, opts = ""): string {
  return `name: x
on: [pull_request]
jobs:
  a:
    runs-on: ubuntu-latest
${opts}    steps:
${steps}
`;
}

describe("permissions: off (default)", () => {
  it("is a no-op when no config is provided (zero output change)", () => {
    const { doc, errors } = build(wf("      - uses: actions/checkout@v4"));
    expect(errors).toEqual([]);
    expect(root(doc).permissions).toBeUndefined();
    expect(job(doc).permissions).toBeUndefined();
  });

  it("is a no-op when mode is explicitly off", () => {
    const { doc } = build(wf("      - uses: actions/checkout@v4"), {
      permissions: { mode: "off" },
    });
    expect(root(doc).permissions).toBeUndefined();
    expect(job(doc).permissions).toBeUndefined();
  });

  it("treats a bare 'off' string the same as no-op", () => {
    const { doc } = build(wf("      - uses: actions/checkout@v4"), { permissions: "off" });
    expect(root(doc).permissions).toBeUndefined();
    expect(job(doc).permissions).toBeUndefined();
  });
});

describe("permissions: infer", () => {
  it("emits the per-job union and a top-level deny-all default", () => {
    const { doc, errors } = build(wf("      - uses: actions/checkout@v4"), infer);
    expect(errors).toEqual([]);
    expect(root(doc).permissions).toEqual({});
    expect(job(doc).permissions).toEqual({ contents: "read" });
  });

  it("merges multiple actions keeping the broader level (write beats read)", () => {
    const { doc } = build(
      wf(`      - uses: actions/checkout@v4
      - uses: actions/labeler@v5`),
      infer,
    );
    expect(job(doc).permissions).toEqual({ contents: "read", "pull-requests": "write" });
  });

  it("maps deploy-pages to pages:write + id-token:write", () => {
    const { doc } = build(wf("      - uses: actions/deploy-pages@v4"), infer);
    expect(job(doc).permissions).toEqual({ "id-token": "write", pages: "write" });
  });

  it("maps the actions/setup-* prefix family to contents:read", () => {
    const { doc } = build(wf("      - uses: actions/setup-node@v4"), infer);
    expect(job(doc).permissions).toEqual({ contents: "read" });
  });

  it("maps the github/codeql-action/* prefix family", () => {
    const { doc } = build(wf("      - uses: github/codeql-action/analyze@v3"), infer);
    expect(job(doc).permissions).toEqual({
      actions: "read",
      contents: "read",
      "security-events": "write",
    });
  });

  it("emits an empty job block for a token-free run step", () => {
    const { doc } = build(wf("      - run: echo hi"), infer);
    expect(job(doc).permissions).toEqual({});
    expect(root(doc).permissions).toEqual({});
  });

  it("places permissions after runs-on in a job and after on at the root", () => {
    const { doc } = build(wf("      - uses: actions/checkout@v4"), infer);
    expect(Object.keys(job(doc))).toEqual(["runs-on", "permissions", "steps"]);
    expect(Object.keys(root(doc))).toEqual(["name", "on", "permissions", "jobs"]);
  });

  it("respects an explicit job-level permissions block (escape hatch wins)", () => {
    const src = wf(
      "      - uses: actions/checkout@v4",
      "    permissions:\n      contents: write\n",
    );
    const { doc } = build(src, infer);
    expect(job(doc).permissions).toEqual({ contents: "write" });
    // The only job opted out, so no deny-all baseline is introduced.
    expect(root(doc).permissions).toBeUndefined();
  });

  it("does not add a top-level default when the root already declares permissions", () => {
    const src = `name: x
on: [pull_request]
permissions: read-all
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const { doc } = build(src, infer);
    expect(root(doc).permissions).toBe("read-all");
    expect(job(doc).permissions).toEqual({ contents: "read" });
  });
});

describe("permissions: unknown actions (safety invariant)", () => {
  it("fires permissions-unknown-action and rescues the job to write-all", () => {
    const { doc, warnings, codes } = build(wf("      - uses: actions/github-script@v7"), infer);
    expect(codes).toContain("permissions-unknown-action");
    expect(warnings.length).toBeGreaterThan(0);
    expect(job(doc).permissions).toBe("write-all");
    // Deny-all baseline still added; the job overrides it back to write-all.
    expect(root(doc).permissions).toEqual({});
  });

  it("does not rescue to write-all when the root already manages permissions", () => {
    const src = `name: x
on: [pull_request]
permissions: read-all
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
`;
    const { doc, codes } = build(src, infer);
    expect(codes).toContain("permissions-unknown-action");
    expect(job(doc).permissions).toBeUndefined();
  });

  it("treats a local composite action as unknown", () => {
    const { codes } = build(wf("      - uses: ./.github/actions/foo"), infer);
    expect(codes).toContain("permissions-unknown-action");
  });

  it("treats a docker action as unknown", () => {
    const { codes } = build(wf("      - uses: docker://alpine:3"), infer);
    expect(codes).toContain("permissions-unknown-action");
  });
});

describe("permissions: user overrides", () => {
  it("resolves an unknown action via config.permissions.actions", () => {
    const { doc, codes } = build(wf("      - uses: my-org/foo@v1"), {
      permissions: { mode: "infer", actions: { "my-org/foo": { issues: "write" } } },
    });
    expect(codes).not.toContain("permissions-unknown-action");
    expect(job(doc).permissions).toEqual({ issues: "write" });
  });

  it("lets an override win over a bundled entry", () => {
    const { doc } = build(wf("      - uses: actions/checkout@v4"), {
      permissions: { mode: "infer", actions: { "actions/checkout": { contents: "write" } } },
    });
    expect(job(doc).permissions).toEqual({ contents: "write" });
  });
});

describe("permissions: run-step token heuristic", () => {
  const tokenStep =
    "      - run: gh pr edit\n        env:\n          GITHUB_TOKEN: ${{ github.token }}";

  it("marks a token-touching run step unknown when inferRunScopes is off", () => {
    const { codes } = build(wf(tokenStep), infer);
    expect(codes).toContain("permissions-unknown-action");
  });

  it("infers scopes from a gh body when inferRunScopes is on", () => {
    const { doc, codes } = build(wf(tokenStep), {
      permissions: { mode: "infer", inferRunScopes: true },
    });
    expect(codes).not.toContain("permissions-unknown-action");
    expect(job(doc).permissions).toEqual({ "pull-requests": "write" });
  });

  it("covers gh issue/release/run heuristics", () => {
    const body = `      - run: |
          gh issue close 1
          gh release create v1
          gh run rerun 5
        env:
          GITHUB_TOKEN: \${{ github.token }}`;
    const { doc } = build(wf(body), { permissions: { mode: "infer", inferRunScopes: true } });
    expect(job(doc).permissions).toEqual({
      actions: "write",
      contents: "write",
      issues: "write",
    });
  });
});

describe("permissions: reusable-workflow call jobs", () => {
  it("warns and skips a baseline for an uncovered call job", () => {
    const src = `name: x
on: [pull_request]
jobs:
  a:
    uses: ./.github/workflows/reusable.yml
`;
    const { doc, codes } = build(src, infer);
    expect(codes).toContain("permissions-reusable-call");
    expect(root(doc).permissions).toBeUndefined();
  });

  it("does not warn when the call job declares its own permissions", () => {
    const src = `name: x
on: [pull_request]
jobs:
  a:
    uses: ./.github/workflows/reusable.yml
    permissions:
      contents: read
  b:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;
    const { doc, codes } = build(src, infer);
    expect(codes).not.toContain("permissions-reusable-call");
    // The covered call job no longer blocks the deny-all baseline.
    expect(root(doc).permissions).toEqual({});
    expect(job(doc, "b").permissions).toEqual({ contents: "read" });
  });
});

describe("permissions: check", () => {
  const checked = (src: string, strict = false) =>
    build(src, { permissions: { mode: "check" }, permissionsStrict: strict });

  const withPerms = (perms: string, step = "      - uses: actions/checkout@v4") =>
    wf(step, `    permissions:\n${perms}`);

  it("warns on an over-granted scope but never rewrites output", () => {
    const { doc, warnings, codes } = checked(withPerms("      contents: write\n"));
    expect(codes).toContain("permissions-over-grant");
    expect(warnings.length).toBeGreaterThan(0);
    // check never mutates: the declared block is left intact.
    expect(job(doc).permissions).toEqual({ contents: "write" });
  });

  it("escalates over-grant to an error (failing the build) under strict --check", () => {
    const { result, errors, codes } = checked(withPerms("      contents: write\n"), true);
    expect(codes).toContain("permissions-over-grant");
    expect(errors.length).toBeGreaterThan(0);
    expect(result.ok).toBe(false);
  });

  it("is silent when the declared block matches the computed minimum", () => {
    const { codes } = checked(withPerms("      contents: read\n"));
    expect(codes).not.toContain("permissions-over-grant");
  });

  it("flags a write-all shorthand as over-granted", () => {
    const src = `name: x
on: [pull_request]
jobs:
  a:
    runs-on: ubuntu-latest
    permissions: write-all
    steps:
      - uses: actions/checkout@v4
`;
    const { codes } = checked(src);
    expect(codes).toContain("permissions-over-grant");
  });

  it("flags a read-all shorthand over a token-free step", () => {
    const src = `name: x
on: [pull_request]
jobs:
  a:
    runs-on: ubuntu-latest
    permissions: read-all
    steps:
      - run: echo hi
`;
    const { codes } = checked(src);
    expect(codes).toContain("permissions-over-grant");
  });

  it("flags a job declaring contents over a token-free step needing nothing", () => {
    const { codes } = checked(withPerms("      contents: read\n", "      - run: echo hi"));
    expect(codes).toContain("permissions-over-grant");
  });

  it("skips a job that declares no permissions", () => {
    const { codes } = checked(wf("      - uses: actions/checkout@v4"));
    expect(codes).not.toContain("permissions-over-grant");
  });

  it("warns permissions-unknown-action and skips the comparison for unknown actions", () => {
    const { codes } = checked(
      withPerms("      contents: write\n", "      - uses: actions/github-script@v7"),
    );
    expect(codes).toContain("permissions-unknown-action");
    expect(codes).not.toContain("permissions-over-grant");
  });
});
