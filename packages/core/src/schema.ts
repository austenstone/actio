import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Canonical published URL of the Actio JSON Schema. Use it in the modeline below. */
export const ACTIO_SCHEMA_URL =
  "https://raw.githubusercontent.com/austenstone/actio/main/packages/core/schema/actio.schema.json";

/** Absolute path to the bundled `actio.schema.json` on disk (works from src and dist). */
export const actioSchemaPath = fileURLToPath(
  new URL("../schema/actio.schema.json", import.meta.url),
);

/** The Actio JSON Schema as a raw string. */
export function actioSchemaJson(): string {
  return readFileSync(actioSchemaPath, "utf8");
}

/** The Actio JSON Schema parsed into an object. */
export function actioSchema(): Record<string, unknown> {
  return JSON.parse(actioSchemaJson());
}

/**
 * `yaml-language-server` modeline that points editors (e.g. VS Code's YAML
 * extension) at the published schema for autocomplete, hover docs, and validation.
 */
export const SCHEMA_MODELINE = `# yaml-language-server: $schema=${ACTIO_SCHEMA_URL}`;
