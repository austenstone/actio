/**
 * YAML 1.1 coercion-trap predicate (#137).
 *
 * Actio parses `.actio.yml` with the YAML 1.2 core schema, so author tokens like
 * `no`, `on`, `1:30`, `2024-01-01`, `1_000` survive parsing as JS *strings*, and
 * the emitter writes them back unquoted. A downstream YAML *1.1* consumer then
 * re-reads those plain tokens with the older schema and coerces them (`no`→false,
 * `1:30`→90, `2024-01-01`→a date, `1_000`→1000). This predicate flags exactly the
 * strings a 1.1 consumer would mis-type so the emitter can defensively quote them.
 *
 * Scope, honestly: the GitHub Actions *workflow* parser largely preserves these
 * as strings in string positions and rejects an unquoted trap *loudly* in typed
 * positions (it does not silently rewrite your file). The live 1.1 footguns are
 * elsewhere — per-action `action.yml` input parsing, the truthy `on:` key, and
 * downstream tooling that reads the generated YAML. So this is defensive
 * hardening against 1.1 consumers, not a claim about the runner's own parser.
 *
 * The catalog is deliberately narrow: it covers only the categories where
 * yaml-core (1.2) emits the string PLAIN *and* a 1.1 consumer corrupts that
 * plain token. Everything else (`true`/`false`, `null`, octal/hex *without*
 * separators, floats, scientific notation, big ints) is already emitted
 * quoted-or-numeric by yaml-core, so a 1.1 consumer reads it identically —
 * quoting those would only churn the output. Genuine JS booleans/numbers never
 * reach this predicate because the caller guards on `typeof value === "string"`.
 */

export type CoercionMode = "off" | "warn" | "fix";

export const COERCION_MODES: ReadonlySet<string> = new Set<CoercionMode>(["off", "warn", "fix"]);

export type CoercionCategory = "boolean" | "binary" | "sexagesimal" | "timestamp" | "underscore";

/** The exact YAML 1.1 boolean casings; `true`/`false` are excluded (yaml-core quotes those). */
const BOOLEAN = /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;

/** YAML 1.1 binary int (`0b101`). Uppercase `0B` is not 1.1-binary, so it is safe. */
const BINARY = /^[-+]?0b[01][01_]*$/;

/** YAML 1.1 base-60 int (`1:30`→90). Each non-leading group is 0-59, so `12:60` is safe. */
const SEXAGESIMAL = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/;

/** YAML 1.1 timestamp (`2024-01-01`, `2024-01-01T00:00:00Z`). Lenient month/day to match the 1.1 resolver. */
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt ][0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:\s*(?:Z|[-+][0-9]{1,2}(?::?[0-9]{2})?))?)?$/;

/**
 * YAML 1.1 underscore-separated numeric (`1_000`→1000, `0x1_F`→31, `.5_0`→0.5).
 * yaml-core (1.2) has no digit separators, so any `_`-bearing numeric emits PLAIN
 * and a 1.1 consumer reads it as a number. The `(?=.*_)` guard requires a real
 * separator so pure-digit/hex strings (`0755`, `0x1A`) — which yaml-core already
 * quotes — are left alone. Lowercase `0x` only; `0X`/`0o` are not 1.1-numeric.
 */
const UNDERSCORE =
  /^(?=.*_)[-+]?(?:0x[0-9a-fA-F_]+|\.[0-9_]+(?:[eE][-+]?[0-9_]+)?|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9_]+)?)$/;

const MATCHERS: ReadonlyArray<readonly [CoercionCategory, RegExp]> = [
  ["boolean", BOOLEAN],
  ["binary", BINARY],
  ["sexagesimal", SEXAGESIMAL],
  ["timestamp", TIMESTAMP],
  ["underscore", UNDERSCORE],
];

/** Category names are disjoint over real inputs, so the first match wins. */
export function coercionTrapCategory(value: string): CoercionCategory | undefined {
  for (const [category, re] of MATCHERS) {
    if (re.test(value)) return category;
  }
  return undefined;
}

/** Human-readable explanation per category, surfaced in `warn`-mode diagnostics. */
export const COERCION_CATEGORY_HINTS: Record<CoercionCategory, string> = {
  boolean: "a YAML 1.1 consumer reads it as a boolean (the 'Norway problem').",
  binary: "a YAML 1.1 consumer reads it as a base-2 integer.",
  sexagesimal: "a YAML 1.1 consumer reads it as a base-60 (sexagesimal) number.",
  timestamp: "a YAML 1.1 consumer reads it as a date/timestamp.",
  underscore: "a YAML 1.1 consumer reads it as a number (`_` is a digit separator).",
};

export function coercionWarning(value: string, category: CoercionCategory): string {
  return `"${value}" is emitted unquoted; ${COERCION_CATEGORY_HINTS[category]} Quote it (coercion: fix) to keep it a string.`;
}
