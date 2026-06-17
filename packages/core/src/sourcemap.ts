import { LineCounter, type Node, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Position, Range } from "./diagnostics.js";
import { originOf } from "./ir.js";
import { type ParseContext, type Path, type WorkflowData, rangeOfPath } from "./parser.js";

/**
 * Source maps are reconstructed at emit time rather than threaded through the
 * passes. Provenance lives in the typed IR's `ctx.origins` side-table: passes
 * pin each original job/step/fragment's origin before mutating, and carry it
 * onto clones/derived nodes, so a node that a macro moves still points at its
 * true source. We never re-derive provenance here — we re-parse the emitted body
 * for line numbers and resolve each node through the IR.
 *
 * `makeResolveOrigin(ctx)` is the single resolution seam: it returns the lone
 * `(path) => Range | undefined` function `buildSourceMap` resolves through.
 */

export interface SourceMapping {
  /** 1-based line in the generated workflow (including any banner). */
  generated: { line: number };
  /** Index into `SourceMap.sources`. */
  source: number;
  /** 1-based position in the original `.actio.yml`. */
  original: Position;
  /** Dotted data path of the node — a debugging aid and IR hook. */
  path?: string;
}

export interface SourceMap {
  version: 1;
  generator: "actio";
  /** Generated file name (best-effort; the CLI writes the map beside it). */
  file: string;
  /** Original source files, indexed by `SourceMapping.source`. */
  sources: string[];
  /** Sparse, sorted by generated line. Only confidently-resolved lines appear. */
  mappings: SourceMapping[];
}

export interface BuildSourceMapOptions {
  /** Number of banner lines prepended to the body, to offset generated lines. */
  headerLines: number;
}

function pathDotted(path: Path): string {
  return path.map((p) => String(p)).join(".");
}

function startLine(node: Node, lc: LineCounter): number | undefined {
  const range = (node as { range?: [number, number, number] }).range;
  if (!range) return undefined;
  return lc.linePos(range[0]).line;
}

type Visitor = (node: Node, path: Path) => void;

function walk(node: Node | null, path: Path, lc: LineCounter, visit: Visitor): void {
  if (!node) return;
  if (path.length > 0) visit(node, path);
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = pair.key;
      if (!isScalar(key)) continue;
      walk(pair.value as Node | null, [...path, String(key.value)], lc, visit);
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, i) => walk(item as Node | null, [...path, i], lc, visit));
  }
}

/** Resolve the live `ctx.data` node addressed by a final-document `path`. */
function nodeAt(data: WorkflowData, path: Path): unknown {
  let cur: unknown = data;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[key as string | number];
  }
  return cur;
}

/**
 * THE resolution seam, wired to the typed IR's provenance side-table. The
 * generated-body walk yields re-parsed AST nodes (fresh identities), so we index
 * back into the live `ctx.data` by the node's final path to recover the object
 * the IR seeded an origin for. `originOf` returns the true *pre-move* source
 * range for nodes a pass relocated (fragment-injected / retry-fanned steps, the
 * `dynamic_matrix` setup job). Un-origined nodes — top-level keys, job scalars —
 * fall back to their range at the final path, exact because they never move.
 * Truly-synthetic nodes resolve to neither and stay unmapped.
 */
function makeResolveOrigin(ctx: ParseContext): (path: Path) => Range | undefined {
  return (path) => {
    const live = nodeAt(ctx.data, path);
    const origin = live !== null && typeof live === "object" ? originOf(ctx, live) : undefined;
    return origin?.range ?? rangeOfPath(ctx, path);
  };
}

/** Reconstruct a line-level source map from the original document and the
 * emitted body. `body` must be the generated YAML *without* the banner. */
export function buildSourceMap(
  ctx: ParseContext,
  body: string,
  options: BuildSourceMapOptions,
): SourceMap {
  const resolveOrigin = makeResolveOrigin(ctx);

  const lc = new LineCounter();
  const generated = parseDocument(body, { lineCounter: lc });

  const perLine = new Map<number, { mapping: SourceMapping; depth: number }>();
  walk(generated.contents as Node | null, [], lc, (node, path) => {
    const line = startLine(node, lc);
    if (line === undefined) return;
    const range = resolveOrigin(path);
    if (!range) return;
    const genLine = options.headerLines + line;
    const existing = perLine.get(genLine);
    if (existing && existing.depth >= path.length) return;
    perLine.set(genLine, {
      depth: path.length,
      mapping: {
        generated: { line: genLine },
        source: 0,
        original: range.start,
        path: pathDotted(path),
      },
    });
  });

  const mappings = [...perLine.values()]
    .map((v) => v.mapping)
    .sort((a, b) => a.generated.line - b.generated.line);

  return {
    version: 1,
    generator: "actio",
    file: ctx.fileName.replace(/\.actio\.yml$/, ".yml"),
    sources: [ctx.fileName],
    mappings,
  };
}

/** Resolve a generated line to its source position. Falls back to the nearest
 * preceding mapped line so positions inside a mapped construct still resolve. */
export function resolveGeneratedLine(
  map: SourceMap,
  generatedLine: number,
): { file: string; line: number; col: number } | undefined {
  let match: SourceMapping | undefined;
  for (const mapping of map.mappings) {
    if (mapping.generated.line > generatedLine) break;
    match = mapping;
  }
  if (!match) return undefined;
  return {
    file: map.sources[match.source] ?? map.sources[0],
    line: match.original.line,
    col: match.original.col,
  };
}
