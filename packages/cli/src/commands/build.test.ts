import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type BuildOptions, ciAnnotationsEnabled, discover, runBuild } from "./build.js";

const INPUT = [
  "name: CI",
  "on: [push]",
  "jobs:",
  "  build:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: echo hi",
  "",
].join("\n");

function options(cwd: string, overrides: Partial<BuildOptions> = {}): BuildOptions {
  return {
    outDir: "out",
    check: false,
    stdout: false,
    validate: true,
    header: true,
    sourceMap: true,
    annotate: false,
    cwd,
    ...overrides,
  };
}

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "actio-cli-"));
  await writeFile(join(dir, "ci.actio.yml"), INPUT, "utf8");
  return dir;
}

afterEach(() => vi.restoreAllMocks());

describe("runBuild source maps", () => {
  it("writes a .yml.map sidecar next to the workflow", async () => {
    const dir = await workdir();
    const code = await runBuild([], options(dir));
    expect(code).toBe(0);

    const yamlPath = join(dir, "out", "ci.yml");
    const mapPath = join(dir, "out", "ci.yml.map");
    expect(existsSync(yamlPath)).toBe(true);
    expect(existsSync(mapPath)).toBe(true);

    const map = JSON.parse(await readFile(mapPath, "utf8"));
    expect(map.version).toBe(1);
    expect(map.file).toBe("ci.yml");
    expect(map.sources).toEqual(["ci.actio.yml"]);
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  it("omits the sidecar with sourceMap disabled", async () => {
    const dir = await workdir();
    await runBuild([], options(dir, { sourceMap: false }));
    expect(existsSync(join(dir, "out", "ci.yml"))).toBe(true);
    expect(existsSync(join(dir, "out", "ci.yml.map"))).toBe(false);
  });

  it("writes nothing to disk in --stdout mode", async () => {
    const dir = await workdir();
    const spy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const code = await runBuild([], options(dir, { stdout: true }));
    expect(code).toBe(0);
    expect(spy).toHaveBeenCalled();
    expect(existsSync(join(dir, "out", "ci.yml"))).toBe(false);
    expect(existsSync(join(dir, "out", "ci.yml.map"))).toBe(false);
  });

  it("treats a stale source map as drift under --check", async () => {
    const dir = await workdir();
    await runBuild([], options(dir));
    // Up to date: no drift.
    expect(await runBuild([], options(dir, { check: true }))).toBe(0);

    // Corrupt the sidecar so it no longer matches the regenerated map.
    await mkdir(join(dir, "out"), { recursive: true });
    await writeFile(join(dir, "out", "ci.yml.map"), "{}\n", "utf8");
    expect(await runBuild([], options(dir, { check: true }))).toBe(1);
  });
});

describe("discover default-glob exclusions", () => {
  async function tree(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "actio-discover-"));
    await writeFile(join(dir, "ci.actio.yml"), INPUT, "utf8");
    // Collision-prone fixtures: many input.actio.yml all flatten to input.yml.
    await mkdir(join(dir, "tests", "a"), { recursive: true });
    await mkdir(join(dir, "tests", "b"), { recursive: true });
    await writeFile(join(dir, "tests", "a", "input.actio.yml"), INPUT, "utf8");
    await writeFile(join(dir, "tests", "b", "input.actio.yml"), INPUT, "utf8");
    await mkdir(join(dir, "fixtures"), { recursive: true });
    await writeFile(join(dir, "fixtures", "input.actio.yml"), INPUT, "utf8");
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "node_modules", "pkg", "ci.actio.yml"), INPUT, "utf8");
    return dir;
  }

  it("excludes tests/ and fixtures/ trees for a bare (no-pattern) run", async () => {
    const dir = await tree();
    const files = await discover([], dir);
    expect(files).toEqual(["ci.actio.yml"]);
  });

  it("a bare build avoids the flatten-collision and succeeds", async () => {
    const dir = await tree();
    expect(await runBuild([], options(dir))).toBe(0);
  });

  it("honors an explicit pattern that opts back into tests/", async () => {
    const dir = await tree();
    const files = await discover(["tests/**/*.actio.yml"], dir);
    expect(files).toEqual(["tests/a/input.actio.yml", "tests/b/input.actio.yml"]);
  });

  it("always excludes node_modules, even with an explicit pattern", async () => {
    const dir = await tree();
    const files = await discover(["**/*.actio.yml"], dir);
    expect(files).not.toContain("node_modules/pkg/ci.actio.yml");
  });
});

describe("ciAnnotationsEnabled", () => {
  it("is true under GitHub Actions outside the test runner", () => {
    expect(ciAnnotationsEnabled({ GITHUB_ACTIONS: "true" })).toBe(true);
  });

  it("is false when not in GitHub Actions", () => {
    expect(ciAnnotationsEnabled({})).toBe(false);
    expect(ciAnnotationsEnabled({ GITHUB_ACTIONS: "false" })).toBe(false);
  });

  it("is suppressed under Vitest so fixture diagnostics never leak as annotations", () => {
    expect(ciAnnotationsEnabled({ GITHUB_ACTIONS: "true", VITEST: "true" })).toBe(false);
  });
});
