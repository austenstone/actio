import { seedOrigins } from "../ir.js";
import type { ParseContext } from "../parser.js";

/** The transform a pass performs. Mutates `ctx.data` in place. */
export type PassFn = (ctx: ParseContext) => void;

/**
 * A named transform in the transpile pipeline. Passes declare the passes they
 * must run *after* via `runsAfter`; the registry topologically sorts them so
 * ordering is data, not a hand-maintained array.
 */
export interface Pass {
  /** Unique identifier, also used to reference this pass in `runsAfter`. */
  name: string;
  /** Names of passes that must run before this one. Unknown names are ignored. */
  runsAfter?: string[];
  apply: PassFn;
}

/**
 * Order passes so every pass runs after the ones it depends on. Stable: passes
 * with no ordering constraint keep their input order. Throws on a dependency
 * cycle. Unknown `runsAfter` names are ignored so partial pass sets still sort.
 */
export function sortPasses(passes: Pass[]): Pass[] {
  const byName = new Map(passes.map((p) => [p.name, p]));
  const sorted: Pass[] = [];
  const done = new Set<string>();
  const onStack = new Set<string>();

  const visit = (pass: Pass): void => {
    if (done.has(pass.name)) return;
    if (onStack.has(pass.name)) {
      throw new Error(`Pass dependency cycle detected at "${pass.name}"`);
    }
    onStack.add(pass.name);
    for (const depName of pass.runsAfter ?? []) {
      const dep = byName.get(depName);
      if (dep) visit(dep);
    }
    onStack.delete(pass.name);
    done.add(pass.name);
    sorted.push(pass);
  };

  for (const pass of passes) visit(pass);
  return sorted;
}

/** Sort the given passes, then run each against `ctx`. */
export function applyPasses(ctx: ParseContext, passes: Pass[]): void {
  seedOrigins(ctx);
  for (const pass of sortPasses(passes)) {
    pass.apply(ctx);
  }
}

/**
 * A mutable collection of passes. Lets external code add or remove transforms
 * without editing core, then run the whole pipeline in dependency order.
 */
export class PassRegistry {
  #passes = new Map<string, Pass>();

  constructor(initial: Iterable<Pass> = []) {
    for (const pass of initial) this.register(pass);
  }

  /** Add a pass. Throws if a pass with the same name is already registered. */
  register(pass: Pass): this {
    if (this.#passes.has(pass.name)) {
      throw new Error(`A pass named "${pass.name}" is already registered`);
    }
    this.#passes.set(pass.name, pass);
    return this;
  }

  /** Remove a pass by name. Returns true if one was removed. */
  unregister(name: string): boolean {
    return this.#passes.delete(name);
  }

  has(name: string): boolean {
    return this.#passes.has(name);
  }

  /** Registered passes in dependency order. */
  list(): Pass[] {
    return sortPasses([...this.#passes.values()]);
  }

  /** Run every registered pass against `ctx` in dependency order. */
  run(ctx: ParseContext): void {
    applyPasses(ctx, [...this.#passes.values()]);
  }
}
