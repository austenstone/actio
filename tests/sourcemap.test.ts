import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SourceMap, resolveGeneratedLine, transpile } from "@actio/core";
import { describe, expect, it } from "vitest";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return readFileSync(join(fixturesDir, name, "input.actio.yml"), "utf8");
}

/** Find the source line a given generated line maps to, via the map's mappings. */
function sourceLineOf(map: SourceMap, generatedLine: number): number | undefined {
  return map.mappings.find((m) => m.generated.line === generatedLine)?.original.line;
}

function genLineOf(yaml: string, needle: string): number {
  const idx = yaml.split("\n").findIndex((l) => l.includes(needle));
  if (idx === -1) throw new Error(`generated line not found: ${needle}`);
  return idx + 1;
}

describe("source map", () => {
  it("is absent by default and present when requested", () => {
    const src = fixture("passthrough");
    expect(transpile(src, { fileName: "input.actio.yml" }).map).toBeUndefined();

    const result = transpile(src, { fileName: "input.actio.yml", sourceMap: true });
    expect(result.map).toBeDefined();
    const map = result.map as SourceMap;
    expect(map.version).toBe(1);
    expect(map.generator).toBe("actio");
    expect(map.file).toBe("input.yml");
    expect(map.sources).toEqual(["input.actio.yml"]);
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  it("does not change the generated YAML", () => {
    const src = fixture("passthrough");
    const a = transpile(src, { fileName: "input.actio.yml" });
    const b = transpile(src, { fileName: "input.actio.yml", sourceMap: true });
    expect(b.yaml).toBe(a.yaml);
  });

  it("maps untouched lines straight through (passthrough)", () => {
    const { yaml, map } = transpile(fixture("passthrough"), {
      fileName: "input.actio.yml",
      sourceMap: true,
    });
    const m = map as SourceMap;
    // `name: Passthrough` is source line 1, generated line 5 (after the banner).
    expect(sourceLineOf(m, genLineOf(yaml, "name: Passthrough"))).toBe(1);
    // `runs-on: ubuntu-latest` is source line 7.
    expect(sourceLineOf(m, genLineOf(yaml, "runs-on:"))).toBe(7);
  });

  it("maps moved nodes back to their fragment definition (fragments)", () => {
    const { yaml, map } = transpile(fixture("fragments"), {
      fileName: "input.actio.yml",
      sourceMap: true,
    });
    const m = map as SourceMap;
    // The injected `checkout` step is emitted under jobs.test.steps[0], but its
    // origin is the fragment definition at source line 5 — not the `- inject:`
    // line (source 13) that occupies that path in the source.
    expect(sourceLineOf(m, genLineOf(yaml, "actions/checkout@v4"))).toBe(5);
    // Origin-driven, not path-driven: the `rangeOfPath` fallback for the final
    // path jobs.test.steps.0 would resolve to the `- inject:` line (13). The IR
    // origin must win, proving the swap consumes provenance over geometry.
    expect(sourceLineOf(m, genLineOf(yaml, "actions/checkout@v4"))).not.toBe(13);
    expect(sourceLineOf(m, genLineOf(yaml, "actions/setup-node@v4"))).toBe(6);
    // The trailing `- run: npm test` step moved from source index 1 (line 14).
    expect(sourceLineOf(m, genLineOf(yaml, "run: npm test"))).toBe(14);
  });

  it("leaves genuinely-generated lines unmapped (dynamic matrix)", () => {
    const { yaml, map } = transpile(fixture("dynamic-matrix"), {
      fileName: "input.actio.yml",
      sourceMap: true,
    });
    const m = map as SourceMap;
    const mappedLines = new Set(m.mappings.map((x) => x.generated.line));
    const total = yaml.split("\n").length;
    // Some generated lines (banner, injected eval/fromJSON plumbing) have no
    // source origin, so the map must be sparse rather than 1:1.
    expect(m.mappings.length).toBeGreaterThan(0);
    expect(m.mappings.length).toBeLessThan(total);
    // Banner lines are never mapped.
    expect(mappedLines.has(1)).toBe(false);
  });

  it("resolveGeneratedLine falls back to the nearest preceding mapping", () => {
    const { yaml, map } = transpile(fixture("passthrough"), {
      fileName: "input.actio.yml",
      sourceMap: true,
    });
    const m = map as SourceMap;
    const runLine = genLineOf(yaml, "run: |");
    const exact = resolveGeneratedLine(m, runLine);
    expect(exact?.file).toBe("input.actio.yml");
    // A line inside the run block (no own mapping) resolves to the run step.
    const inner = resolveGeneratedLine(m, runLine + 1);
    expect(inner?.line).toBe(exact?.line);
  });

  it("remaps schema diagnostics back to source ranges", () => {
    // An invalid step (`frobnicate`) trips schema validation. In the source it
    // sits on line 7; in the generated output it lands on a different line.
    const src = [
      "name: Bad",
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - frobnicate: yes",
      "",
    ].join("\n");

    const plain = transpile(src, { fileName: "bad.actio.yml" });
    const plainSchema = plain.diagnostics.filter((d) => d.source === "schema" && d.range);
    expect(plainSchema.length).toBeGreaterThan(0);
    // Without a map, the diagnostic carries the (misleading) generated line.
    expect(plainSchema.every((d) => d.range?.start.line !== 7)).toBe(true);

    const withMap = transpile(src, { fileName: "bad.actio.yml", sourceMap: true });
    const schema = withMap.diagnostics.filter((d) => d.source === "schema" && d.range);
    expect(schema.length).toBeGreaterThan(0);
    // Remapped, it points at the source `- frobnicate:` line.
    expect(schema.some((d) => d.range?.start.line === 7)).toBe(true);
  });
});
