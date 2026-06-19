// Browser stub for Node's `url`, aliased only for the browser bundle (see
// next.config.mjs). actio-core's schema.ts calls `fileURLToPath` at module load
// to compute a (browser-unused) schema path; returning the stringified input is
// enough. `new URL(...)` uses the global URL constructor, not this module.
export function fileURLToPath(input: string | URL): string {
  return String(input);
}

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export default { fileURLToPath, URL, URLSearchParams };
