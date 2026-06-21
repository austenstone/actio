/**
 * YAML 1.1 coercion-trap predicate (#137).
 *
 * Actio parses `.actio.yml` with the YAML 1.2 core schema, so author tokens like
 * `no`, `on`, `1:30`, `2024-01-01` survive parsing as JS *strings*. The emitter
 * writes them back unquoted, but GitHub Actions' runner re-reads the generated
 * YAML with a 1.1-ish schema that silently coerces them (`no`→false, `1:30`→90,
 * `2024-01-01`→a date). This predicate flags exactly the strings that a 1.1
 * consumer would mis-type so the emitter can defensively single-quote them.
 *
 * The catalog is deliberately narrow: it covers only the categories where
 * yaml-core (1.2) emits the string PLAIN *and* a 1.1 consumer corrupts that
 * plain token. Everything else (`true`/`false`, `null`, octal/hex, floats,
 * scientific notation, big ints) is already emitted quoted-or-numeric by
 * yaml-core, so a 1.1 consumer reads it identically — quoting those would only
 * churn the output. Genuine JS booleans/numbers never reach this predicate
 * because the caller guards on `typeof value === "string"`.
 */

export type CoercionMode = "off" | "warn" | "fix";

export const COERCION_MODES: ReadonlySet<string> = new Set<CoercionMode>(["off", "warn", "fix"]);

export type CoercionCategory = "boolean" | "binary" | "sexagesimal" | "timestamp";

/** The exact YAML 1.1 boolean casings; `true`/`false` are excluded (yaml-core quotes those). */
const BOOLEAN = /^(?:y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;

/** YAML 1.1 binary int (`0b101`). Uppercase `0B` is not 1.1-binary, so it is safe. */
const BINARY = /^[-+]?0b[01][01_]*$/;

/** YAML 1.1 base-60 int (`1:30`→90). Each non-leading group is 0-59, so `12:60` is safe. */
const SEXAGESIMAL = /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/;

/** YAML 1.1 timestamp (`2024-01-01`, `2024-01-01T00:00:00Z`). Lenient month/day to match the 1.1 resolver. */
const TIMESTAMP =
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt ][0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:\s*(?:Z|[-+][0-9]{1,2}(?::?[0-9]{2})?))?)?$/;

const MATCHERS: ReadonlyArray<readonly [CoercionCategory, RegExp]> = [
  ["boolean", BOOLEAN],
  ["binary", BINARY],
  ["sexagesimal", SEXAGESIMAL],
  ["timestamp", TIMESTAMP],
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
  boolean: "GitHub Actions reads it as a boolean (the YAML 1.1 'Norway problem').",
  binary: "GitHub Actions reads it as a base-2 integer.",
  sexagesimal: "GitHub Actions reads it as a base-60 (sexagesimal) number.",
  timestamp: "GitHub Actions reads it as a date/timestamp.",
};

export function coercionWarning(value: string, category: CoercionCategory): string {
  return `"${value}" is emitted unquoted; ${COERCION_CATEGORY_HINTS[category]} Quote it (coercion: fix) to keep it a string.`;
}
