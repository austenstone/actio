import {
  type CoercionCategory,
  type CoercionMode,
  coercionTrapCategory,
  type TranspileResult,
  transpile,
} from "actio-core";
import { describe, expect, it } from "vitest";
import { Document, parse } from "yaml";

/**
 * #137 — emit-side YAML 1.1 coercion guard.
 *
 * Actio parses with YAML 1.2-core, so author tokens like `no`/`1:30`/`1_000`
 * survive as JS strings. A YAML 1.1 consumer (per-action `action.yml` parsing,
 * the `on:` key, downstream tools) then coerces those plain tokens. These tests
 * pin the guard to exactly the five gap categories (boolean/binary/sexagesimal/
 * timestamp/underscore) and prove genuine booleans/numbers are never touched.
 */

/** Compile a workflow whose single `env` value is `raw`, spliced verbatim into source. */
function emitEnv(raw: string, coercion?: CoercionMode): TranspileResult {
  const src = [
    "on: [push]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: echo hi",
    "        env:",
    `          VAL: ${raw}`,
    "",
  ].join("\n");
  return transpile(src, { fileName: "t.actio.yml", validate: false, coercion });
}

/** Read the emitted `env.VAL` back under a chosen YAML version (the 1.1 oracle). */
function envValue(yaml: string, version: "1.1" | "1.2"): unknown {
  const doc = parse(yaml, { version }) as {
    jobs: { build: { steps: Array<{ env: { VAL: unknown } }> } };
  };
  return doc.jobs.build.steps[0].env.VAL;
}

function hasTrapWarning(result: TranspileResult, value: string): boolean {
  return result.diagnostics.some(
    (d) => d.severity === "warning" && d.code === "yaml-coercion-trap" && d.message.includes(value),
  );
}

// One representative author token per gap category. `raw` is the source token,
// `string` is what the user means, `coerced` is the 1.1 value when left unquoted.
const GAP_CASES: ReadonlyArray<{
  category: CoercionCategory;
  raw: string;
  string: string;
}> = [
  { category: "boolean", raw: "no", string: "no" },
  { category: "binary", raw: "0b101", string: "0b101" },
  { category: "sexagesimal", raw: "1:30", string: "1:30" },
  { category: "timestamp", raw: "2024-01-01", string: "2024-01-01" },
  { category: "underscore", raw: "1_000", string: "1_000" },
];

describe("coercion guard — fix mode (default)", () => {
  for (const { category, raw, string } of GAP_CASES) {
    it(`single-quotes the ${category} trap "${raw}" and round-trips it as a string`, () => {
      const result = emitEnv(raw, "fix");
      expect(result.ok).toBe(true);
      expect(result.yaml).toContain(`VAL: '${string}'`);
      // The whole point: a YAML 1.1 consumer now reads it as the intended string.
      expect(envValue(result.yaml, "1.1")).toBe(string);
      expect(typeof envValue(result.yaml, "1.1")).toBe("string");
    });
  }

  it("is the default when no mode is given", () => {
    const result = emitEnv("no");
    expect(result.yaml).toContain("VAL: 'no'");
  });
});

describe("coercion guard — warn mode", () => {
  for (const { category, raw } of GAP_CASES) {
    it(`warns on the ${category} trap "${raw}" and leaves it unquoted`, () => {
      const result = emitEnv(raw, "warn");
      expect(hasTrapWarning(result, raw)).toBe(true);
      expect(result.yaml).toContain(`VAL: ${raw}`);
      expect(result.yaml).not.toContain(`VAL: '${raw}'`);
      // Proof the unquoted token really is a 1.1 footgun.
      expect(typeof envValue(result.yaml, "1.1")).not.toBe("string");
    });
  }

  it("attaches a source range to the warning", () => {
    const result = emitEnv("no", "warn");
    const warning = result.diagnostics.find((d) => d.code === "yaml-coercion-trap");
    expect(warning?.range?.start.line).toBe(8);
  });
});

describe("coercion guard — off mode", () => {
  for (const { raw } of GAP_CASES) {
    it(`leaves the trap "${raw}" untouched with no diagnostic`, () => {
      const result = emitEnv(raw, "off");
      expect(result.yaml).toContain(`VAL: ${raw}`);
      expect(result.yaml).not.toContain(`VAL: '${raw}'`);
      expect(hasTrapWarning(result, raw)).toBe(false);
    });
  }
});

describe("coercion guard — negative cases (no over-quoting)", () => {
  it("does not quote a genuine JS boolean", () => {
    const result = emitEnv("true", "fix");
    expect(result.yaml).toContain("VAL: true");
    expect(result.yaml).not.toContain("VAL: 'true'");
    expect(envValue(result.yaml, "1.2")).toBe(true);
  });

  it("does not quote a genuine JS number", () => {
    const result = emitEnv("20", "fix");
    expect(result.yaml).toContain("VAL: 20");
    expect(result.yaml).not.toContain("VAL: '20'");
    expect(envValue(result.yaml, "1.2")).toBe(20);
  });

  it("leaves yaml-core's own quoting of an already-safe string intact", () => {
    // `"0755"` reaches emit as a JS string; yaml-core double-quotes it, so a 1.1
    // consumer reads a string. Our single-quote guard must not fire.
    const result = emitEnv('"0755"', "fix");
    expect(result.yaml).toContain('VAL: "0755"');
    expect(result.yaml).not.toContain("VAL: '0755'");
    expect(envValue(result.yaml, "1.1")).toBe("0755");
  });
});

describe("coercion guard — high-value fields", () => {
  it("quotes a trap matrix value but not a genuine matrix boolean", () => {
    const src = [
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    strategy:",
      "      matrix:",
      "        ref: [on, main]",
      "        flag: [true, false]",
      "    steps:",
      "      - run: echo hi",
      "",
    ].join("\n");
    const { yaml } = transpile(src, { fileName: "m.actio.yml", validate: false });
    expect(yaml).toContain("- 'on'");
    expect(yaml).toContain("- main");
    expect(yaml).toContain("- true");
    expect(yaml).not.toContain("- 'true'");
  });

  it("quotes a trap `with:` input", () => {
    const src = [
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "        with:",
      "          ref: no",
      "",
    ].join("\n");
    const { yaml } = transpile(src, { fileName: "w.actio.yml", validate: false });
    expect(yaml).toContain("ref: 'no'");
  });
});

describe("coercion guard — idempotence", () => {
  it("re-emitting already-quoted output is byte-stable", () => {
    const first = emitEnv("no", "fix");
    // The generated workflow is macro-free, so it is itself valid Actio source.
    const second = transpile(first.yaml, {
      fileName: "t.actio.yml",
      validate: false,
      header: false,
    });
    const firstBody = transpile(
      [
        "on: [push]",
        "jobs:",
        "  build:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: echo hi",
        "        env:",
        "          VAL: no",
        "",
      ].join("\n"),
      { fileName: "t.actio.yml", validate: false, header: false },
    ).yaml;
    expect(second.yaml).toBe(firstBody);
    expect(second.yaml).toContain("VAL: 'no'");
  });
});

// Curated catalog cross-check — soundness, completeness, no false positives.
// Lists are hand-authored from the empirical yaml@2.9 oracle (NOT fuzzed).
const TRAP_CATALOG: ReadonlyArray<readonly [string, CoercionCategory]> = [
  ...[
    "y",
    "Y",
    "yes",
    "Yes",
    "YES",
    "n",
    "N",
    "no",
    "No",
    "NO",
    "on",
    "On",
    "ON",
    "off",
    "Off",
    "OFF",
  ].map((v) => [v, "boolean"] as const),
  ...["0b101", "0b1101", "-0b10"].map((v) => [v, "binary"] as const),
  ...["1:30", "12:34:56", "12:30", "0:0"].map((v) => [v, "sexagesimal"] as const),
  ...["2024-01-01", "2024-1-1", "2024-01-01T00:00:00Z", "2024-01-01 10:00:00"].map(
    (v) => [v, "timestamp"] as const,
  ),
  ...["1_000", "10_000", "1_0", "1000_", "1__0", "+1_0", "0x1_F", ".5_0", "1_2.3_4", "1_0e3"].map(
    (v) => [v, "underscore"] as const,
  ),
];

// Plain-emitting tokens that a YAML 1.1 consumer nonetheless reads as strings —
// the precision boundary. Force-quoting any of these would be a false positive.
const SAFE_CATALOG: readonly string[] = [
  "true",
  "True",
  "TRUE",
  "false",
  "False",
  "FALSE",
  "yES",
  "oN",
  "null",
  "Null",
  "NULL",
  "~",
  "",
  "0755",
  "010",
  "0o17",
  "0x1A",
  "0xff",
  "1.20",
  "1.10",
  "1e3",
  "1E5",
  ".inf",
  ".nan",
  "0B101",
  "12:60",
  "20240101",
  "12345678901234567890",
  "ubuntu-latest",
  "main",
  "develop",
  "v1.2.3",
  "release/1.0",
  // Underscore-adjacent shapes a 1.1 consumer still reads as strings.
  "_1000",
  "_",
  "0X1_F",
  "0o1_7",
  "1_0:3_0",
  "node_20",
  "ubuntu_20_04",
  "my_var",
];

// Generate-and-oracle completeness: instead of asserting the hand-curated catalog
// matches the regexes (circular — a *missing* category is invisible), drive the
// yaml-1.1 oracle over a generated token space. Any token yaml-core emits PLAIN
// that a 1.1 consumer then mis-types is a real trap the predicate MUST flag — so
// a future missing category surfaces as an un-flagged generated trap.
function oracleTokenSpace(): string[] {
  const tokens = new Set<string>();
  const add = (...xs: string[]) => {
    for (const x of xs) tokens.add(x);
  };
  for (const d of ["0", "1", "9", "12", "100", "755", "000"]) {
    add(d, `_${d}`, `${d}_`, d.split("").join("_"));
  }
  for (const a of ["0", "1", "12", "100"]) {
    for (const b of ["0", "30", "45", "60", "99"]) add(`${a}:${b}`, `${a}_0:${b}`, `${a}:${b}_0`);
  }
  for (const h of ["1A", "ff", "1_F", "A_B", "0"]) add(`0x${h}`, `0X${h}`, `0o${h}`, `0b${h}`);
  for (const f of ["1.0", "1.20", ".5", "1.2_3", "1_0.0", ".5_0", "1e3", "1E5", "1e1_0", "1_0e3"]) {
    add(f, `-${f}`, `+${f}`);
  }
  for (const dt of ["2024-01-01", "2024-1-1", "2024-01-01T00:00:00Z", "2024_01_01", "20240101"]) {
    add(dt);
  }
  for (const w of ["no", "On", "YES", "true", "False", "null", "~", "yES", "oN"]) add(w);
  for (const id of ["node_20", "ubuntu_20_04", "my_var", "release/1.0", "v1.2.3", "_", "x_1_y"]) {
    add(id);
  }
  return [...tokens];
}

/** Oracle: yaml-core emits `token` PLAIN, and a 1.1 consumer reads it as a non-string. */
function oracleMistypes(token: string): boolean {
  const out = new Document({ U: token }).toString();
  if (out !== `U: ${token}\n`) return false; // yaml-core already quoted it → safe
  let read: unknown;
  try {
    read = (parse(out, { version: "1.1" }) as { U: unknown }).U;
  } catch {
    return false;
  }
  return typeof read !== "string";
}

describe("coercion predicate — catalog cross-check", () => {
  it("flags every catalog trap with the right category (completeness + soundness)", () => {
    for (const [value, category] of TRAP_CATALOG) {
      expect(coercionTrapCategory(value), value).toBe(category);
    }
  });

  it("flags no safe string (no false positives)", () => {
    for (const value of SAFE_CATALOG) {
      expect(coercionTrapCategory(value), value).toBeUndefined();
    }
  });

  it("flags every YAML-1.1 trap in a generated token space (generate-and-oracle)", () => {
    const traps = oracleTokenSpace().filter(oracleMistypes);
    // Guard the generator itself against silently covering nothing, and prove the
    // underscore category is load-bearing (real oracle traps land in it).
    expect(traps.length).toBeGreaterThan(20);
    const underscoreTraps = traps.filter((t) => coercionTrapCategory(t) === "underscore");
    expect(underscoreTraps.length).toBeGreaterThan(0);
    for (const token of traps) {
      expect(coercionTrapCategory(token), `oracle trap not flagged: ${token}`).toBeDefined();
    }
  });
});
