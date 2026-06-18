import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { type BuildOptions, ciAnnotationsEnabled, runBuild } from "./build.js";

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
    target: "legacy",
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

  it("emits native dependencies when target supports preview locks", async () => {
    const dir = await workdir();
    await writeFile(
      join(dir, "ci.actio.yml"),
      [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - uses: actions/checkout@v4",
        "      - run: echo hi",
        "",
      ].join("\n"),
      "utf8",
    );
    const resolver = {
      resolveToImmutable: async () => "11bd71901bbe5b1630ceea73d27597364c9af683",
      fetchByImmutable: async () => new TextEncoder().encode("actions/checkout@v4.2.2"),
    };
    const code = await runBuild(
      [],
      options(dir, {
        target: "github-actions-native-dependencies-preview",
        nativeDependencyResolver: resolver,
      }),
    );
    expect(code).toBe(0);
    const generated = await readFile(join(dir, "out", "ci.yml"), "utf8");
    const parsed = parse(generated) as Record<string, unknown>;
    expect(parsed.dependencies).toEqual({
      "actions/checkout": {
        ref: "v4",
        sha: "11bd71901bbe5b1630ceea73d27597364c9af683",
        integrity: "sha256:17d613e561ca03069505697e042340a1ddf1ce2d21746aa724226fc5262ff12c",
      },
    });
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
