import { type Document, LineCounter, parseDocument } from "yaml";
import type { Diagnostic, Range } from "./diagnostics.js";
import type { SymbolTable } from "./symbols.js";

/** Plain-JS workflow model. Intentionally loose — we only type macro-relevant bits at use sites. */
export type WorkflowData = Record<string, unknown>;

export type Path = (string | number)[];

export interface JobDefaultsInternalSnapshot {
  jobDefaults?: Record<string, unknown>;
  executors?: Record<string, unknown>;
  inlineStrategyJobs?: Record<string, true>;
  inlineStrategyFailFastJobs?: Record<string, true>;
}

export interface ForEachShareContractEntry {
  keySlug: string;
  outputName: string;
}

export interface ForEachShareContract {
  jobId: string;
  mode: "serial-step" | "serial-jobs" | "parallel-matrix" | "parallel-variant-jobs";
  dynamic: boolean;
  entries: ForEachShareContractEntry[];
}

export interface ParseContextInternal {
  /** Preserved macro templates stripped from `ctx.data` after the job_defaults pass. */
  jobDefaults?: JobDefaultsInternalSnapshot;
  /** v1 handoff contract for #18 share integration. */
  forEachShareContracts?: ForEachShareContract[];
  /** Global default mode for the injection-hoist security pass (per-block knobs override). */
  injectionHoist?: "fix" | "warn" | "error" | "off";
}

/**
 * Author key order, stashed on each mapping as a non-enumerable Symbol so passes
 * (which see plain objects) ignore it, while emit can restore the original order.
 * Plain JS objects hoist integer-like keys, so this is the only faithful record.
 */
export const KEY_ORDER: unique symbol = Symbol("actio.keyOrder");

/** Convert an order-preserving `toJS({ mapAsMap })` tree into plain objects that carry KEY_ORDER. */
function mapTreeToData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(mapTreeToData);
  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    const order: string[] = [];
    for (const [k, v] of value) {
      const key = String(k);
      obj[key] = mapTreeToData(v);
      order.push(key);
    }
    setKeyOrder(obj, order);
    return obj;
  }
  return value;
}

/**
 * Stamp the author's mapping key order onto a plain object via a non-enumerable
 * symbol, invisible to passes but read by emit to restore order. Passes that
 * REBUILD a map (dynamic_matrix) or CLONE a node (cloneNode) must re-apply this,
 * otherwise emit falls back to Object.keys and hoists integer-like keys.
 */
export function setKeyOrder(obj: object, order: string[]): void {
  Object.defineProperty(obj, KEY_ORDER, {
    value: order,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * Where an IR node came from in the original source. `path` indexes the parsed
 * document and stays stable as passes mutate `ctx.data`, so it remains a valid
 * argument to `rangeOfPath` even after a node is moved. This is the hook source
 * maps build on.
 */
export interface Origin {
  path: Path;
  range?: Range;
}

export interface ParseContext {
  fileName: string;
  source: string;
  doc: Document.Parsed;
  lineCounter: LineCounter;
  /** Mutable plain-JS model that passes transform. */
  data: WorkflowData;
  /** Unified symbol table shared across compile passes. */
  symbols: SymbolTable;
  diagnostics: Diagnostic[];
  /** Per-node provenance side-table; never serialized. Populated by the IR layer. */
  origins: WeakMap<object, Origin>;
  /** Non-serialized pass scratch space, namespaced by pass name (e.g. `internal.jobDefaults`). */
  internal: ParseContextInternal;
}

function offsetToPosition(lc: LineCounter, offset: number) {
  const { line, col } = lc.linePos(offset);
  return { line, col };
}

/** Resolve the source range of a node addressed by `path` in the original document. */
export function rangeOfPath(ctx: ParseContext, path: Path): Range | undefined {
  try {
    const node = ctx.doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
    if (node?.range) {
      const [start, , end] = node.range;
      return {
        start: offsetToPosition(ctx.lineCounter, start),
        end: offsetToPosition(ctx.lineCounter, end),
      };
    }
  } catch {
    // best-effort; positions are advisory
  }
  return undefined;
}

/** Parse `.actio.yml` source into a transform context. YAML syntax errors land in `diagnostics`. */
export function parseActio(source: string, fileName: string): ParseContext {
  const lineCounter = new LineCounter();
  // `merge: true` resolves YAML merge keys (`<<: *anchor`) so they collapse into
  // the host mapping. GitHub Actions rejects literal `<<`, so they must not survive.
  const doc = parseDocument(source, { lineCounter, keepSourceTokens: true, merge: true });
  const diagnostics: Diagnostic[] = [];

  for (const err of doc.errors) {
    diagnostics.push({
      severity: "error",
      source: "yaml",
      file: fileName,
      message: err.message,
      range: err.pos
        ? {
            start: offsetToPosition(lineCounter, err.pos[0]),
            end: offsetToPosition(lineCounter, err.pos[1]),
          }
        : undefined,
    });
  }

  for (const warn of doc.warnings) {
    diagnostics.push({
      severity: "warning",
      source: "yaml",
      file: fileName,
      message: warn.message,
    });
  }

  // `mapAsMap` keeps author key order (plain objects hoist integer-like keys);
  // we then materialize plain objects that carry that order on KEY_ORDER.
  const js = doc.toJS({ maxAliasCount: -1, mapAsMap: true });
  const data = (mapTreeToData(js) ?? {}) as WorkflowData;
  return {
    fileName,
    source,
    doc,
    lineCounter,
    data,
    symbols: new Map(),
    diagnostics,
    origins: new WeakMap(),
    internal: {},
  };
}
