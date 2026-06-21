// Browser stub for Node's `child_process`, aliased only for the browser bundle
// (see next.config.mjs). actio-core's lint.ts imports `spawnSync` to invoke the
// `actionlint` binary, but the playground's transpile() path never lints, so a
// throwing stub keeps the node builtin out of the client bundle.
export function spawnSync(): never {
  throw new Error(
    "actio-core: child_process.spawnSync is unavailable in the browser playground",
  );
}

export default { spawnSync };
