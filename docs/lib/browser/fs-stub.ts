// Browser stub for Node's `fs`, aliased only for the browser bundle (see
// next.config.mjs). actio-core's schema.ts imports `readFileSync` for the CLI,
// but the playground's transpile() path never calls it, so a throwing stub is
// safe and keeps the node builtin out of the client bundle.
export function readFileSync(): never {
  throw new Error(
    'actio-core: fs.readFileSync is unavailable in the browser playground',
  );
}

export default { readFileSync };
