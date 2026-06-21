import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defineConfig, type Pass, transpile } from "actio-core";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { loadActioConfig, resolveBuildOptions } from "../packages/cli/src/config.js";

const WORKFLOW = `name: x
on: [push]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

/** A custom pass that stamps a top-level env var so we can observe it in output. */
const addEnv: Pass = {
  name: "add-env",
  runsAfter: ["fragments"],
  apply: (ctx) => {
    (ctx.data as Record<string, unknown>).env = { ACTIO_PASS: "ran" };
  },
};

const tmpDirs: string[] = [];
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "actio-config-"));
  tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, "utf8");
  }
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("defineConfig", () => {
  it("returns its input unchanged", () => {
    const cfg = { outDir: "out", passes: [addEnv] };
    expect(defineConfig(cfg)).toBe(cfg);
  });
});

describe("custom passes through transpile", () => {
  it("runs a config-supplied pass that mutates the emitted YAML", () => {
    const out = transpile(WORKFLOW, { fileName: "t.actio.yml", passes: [addEnv] });
    expect(out.ok).toBe(true);
    expect(parse(out.yaml).env).toEqual({ ACTIO_PASS: "ran" });
  });

  it("leaves output identical when no passes are supplied", () => {
    const out = transpile(WORKFLOW, { fileName: "t.actio.yml" });
    expect(parse(out.yaml).env).toBeUndefined();
  });
});

describe("loadActioConfig discovery", () => {
  it("loads a .json config", async () => {
    const dir = fixture({ "actio.config.json": JSON.stringify({ outDir: "from-json" }) });
    const loaded = await loadActioConfig(dir);
    expect(loaded?.config.outDir).toBe("from-json");
  });

  it("loads a .ts config with a custom pass", async () => {
    const dir = fixture({
      "actio.config.ts": `export default {
  outDir: "from-ts",
  passes: [{ name: "add-env", apply: (ctx) => { ctx.data.env = { ACTIO_PASS: "ran" }; } }],
};
`,
    });
    const loaded = await loadActioConfig(dir);
    expect(loaded?.config.outDir).toBe("from-ts");
    expect(loaded?.config.passes?.[0].name).toBe("add-env");
  });

  it("loads a .js config", async () => {
    const dir = fixture({ "actio.config.js": "export default { validate: false };\n" });
    const loaded = await loadActioConfig(dir);
    expect(loaded?.config.validate).toBe(false);
  });

  it("finds a config in a parent directory", async () => {
    const dir = fixture({ "actio.config.json": JSON.stringify({ header: false }) });
    const nested = path.join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    const loaded = await loadActioConfig(nested);
    expect(loaded?.config.header).toBe(false);
  });

  it("returns null when no config exists", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "actio-empty-"));
    tmpDirs.push(dir);
    expect(await loadActioConfig(dir)).toBeNull();
  });

  it("loads an explicit config path that discovery would never reach", async () => {
    const dir = fixture({ "nested/actio.config.json": JSON.stringify({ outDir: "explicit" }) });
    const loaded = await loadActioConfig(dir, "nested/actio.config.json");
    expect(loaded?.config.outDir).toBe("explicit");
  });

  it("throws when an explicit config path is missing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "actio-missing-"));
    tmpDirs.push(dir);
    await expect(loadActioConfig(dir, "nope.config.ts")).rejects.toThrow(/not found/);
  });
});

describe("resolveBuildOptions precedence", () => {
  const base = { files: [], flags: {}, forceCheck: false, argv: [] as string[] };

  it("falls back to built-in defaults with no config or flags", () => {
    const { options } = resolveBuildOptions({ ...base, config: {} });
    expect(options).toMatchObject({
      outDir: ".github/workflows",
      validate: true,
      header: true,
      check: false,
      stdout: false,
      target: "legacy",
    });
  });

  it("applies config values over defaults", () => {
    const { options, patterns } = resolveBuildOptions({
      ...base,
      config: { outDir: "cfg-out", validate: false, files: ["src/*.actio.yml"] },
    });
    expect(options.outDir).toBe("cfg-out");
    expect(options.validate).toBe(false);
    expect(patterns).toEqual(["src/*.actio.yml"]);
  });

  it("lets an explicit CLI flag override the config file", () => {
    const { options } = resolveBuildOptions({
      ...base,
      flags: { outDir: "cli-out" },
      argv: ["build", "--out-dir", "cli-out", "--no-validate"],
      config: { outDir: "cfg-out", validate: true },
    });
    expect(options.outDir).toBe("cli-out");
    expect(options.validate).toBe(false);
  });

  it("prefers CLI positional files over config files", () => {
    const { patterns } = resolveBuildOptions({
      ...base,
      files: ["cli.actio.yml"],
      config: { files: ["cfg.actio.yml"] },
    });
    expect(patterns).toEqual(["cli.actio.yml"]);
  });

  it("threads config passes into build options", () => {
    const { options } = resolveBuildOptions({ ...base, config: { passes: [addEnv] } });
    expect(options.passes).toEqual([addEnv]);
  });

  it("threads config target into build options", () => {
    const { options } = resolveBuildOptions({
      ...base,
      config: { target: "github-actions-native-dependencies-preview" },
    });
    expect(options.target).toBe("github-actions-native-dependencies-preview");
  });

  it("lets an explicit --target flag override config target", () => {
    const { options } = resolveBuildOptions({
      ...base,
      flags: { target: "legacy" },
      argv: ["build", "--target", "legacy"],
      config: { target: "github-actions-native-dependencies-preview" },
    });
    expect(options.target).toBe("legacy");
  });

  it("rejects unknown target profiles", () => {
    expect(() =>
      resolveBuildOptions({
        ...base,
        flags: { target: "not-a-target" },
        argv: ["build", "--target", "not-a-target"],
        config: {},
      }),
    ).toThrow(/target must be one of/);
  });

  it("defaults annotate on and lets --no-annotate turn it off", () => {
    expect(resolveBuildOptions({ ...base, config: {} }).options.annotate).toBe(true);
    expect(resolveBuildOptions({ ...base, config: { annotate: false } }).options.annotate).toBe(
      false,
    );
    const off = resolveBuildOptions({
      ...base,
      argv: ["build", "--no-annotate"],
      config: { annotate: true },
    });
    expect(off.options.annotate).toBe(false);
  });

  it("defaults lint off and reads it from config", () => {
    expect(resolveBuildOptions({ ...base, config: {} }).options.lint).toBe("off");
    expect(resolveBuildOptions({ ...base, config: { lint: "error" } }).options.lint).toBe("error");
  });

  it("lets an explicit --lint flag override config lint", () => {
    const { options } = resolveBuildOptions({
      ...base,
      flags: { lint: "warn" },
      argv: ["build", "--lint", "warn"],
      config: { lint: "error" },
    });
    expect(options.lint).toBe("warn");
  });

  it("rejects unknown lint modes", () => {
    expect(() =>
      resolveBuildOptions({
        ...base,
        flags: { lint: "loud" },
        argv: ["build", "--lint", "loud"],
        config: {},
      }),
    ).toThrow(/lint must be one of/);
    expect(() => resolveBuildOptions({ ...base, config: { lint: "loud" as never } })).toThrow(
      /lint must be one of/,
    );
  });
});
