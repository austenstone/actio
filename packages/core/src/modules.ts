/**
 * Cross-file import seam (#161). The core stays a pure string->string transpiler:
 * file IO lives behind this injectable resolver so a pass never touches the
 * filesystem. Tests inject an in-memory resolver; the CLI provides a filesystem
 * one. The selector grammar (relative path + `.actio.yml`/`.yaml` + `#name`) is
 * validated inside the import pass *before* `resolve` is called, so a resolver
 * only maps an already-vetted path to its source.
 */

/** A module the resolver located: its canonical id (for cycles + diagnostics) and raw source. */
export interface ResolvedModule {
  /** Canonical module id (e.g. normalized path). Stable key for cycle detection. */
  id: string;
  /** Raw `.actio.yml` source text. */
  source: string;
}

/** Maps a vetted local import spec to a module, or `undefined` when no regular file exists. */
export interface ModuleResolver {
  resolve(spec: string, fromFile: string): ResolvedModule | undefined;
}
