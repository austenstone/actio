import { LineCounter, type Node, isMap, isScalar, isSeq, parseDocument } from "yaml";
import type { Position, Range } from "./diagnostics.js";
import type { ParseContext, Path } from "./parser.js";

/**
 * Source maps are reconstructed at emit time rather than threaded through the
 * passes. Passes mutate a plain-JS `ctx.data` and clone via `structuredClone`,
 * which drops any origin tags — so tagging would need invasive hot-path changes
 * and would duplicate the provenance mechanism the typed IR is meant to own.
 *
 * Instead we index the original document by path + value, re-parse the emitted
 * YAML for line numbers, and match generated nodes back to source positions.
 *
 * `makeResolveOrigin(ctx)` is the single upgrade seam: it returns the lone
 * `(node, path) => Range | undefined` function `buildSourceMap` resolves
 * through. When the typed IR lands its provenance side-table, that factory body
 * becomes `originOf(ctx, nodeAt(ctx.data, path))?.range ?? rangeOfPath(ctx, path)`
 * and the heuristic index helpers below are deleted — nothing else changes.
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

const PATH_SEP = "\u0000";

function pathKey(path: Path): string {
  return path.join(PATH_SEP);
}

function pathDotted(path: Path): string {
  return path.map((p) => String(p)).join(".");
}

function startLine(node: Node, lc: LineCounter): number | undefined {
  const range = (node as { range?: [number, number, number] }).range;
  if (!range) return undefined;
  return lc.linePos(range[0]).line;
}

function nodeRange(node: Node, lc: LineCounter): Range | undefined {
  const range = (node as { range?: [number, number, number] }).range;
  if (!range) return undefined;
  const [start, , end] = range;
  return { start: lc.linePos(start), end: lc.linePos(end) };
}

/** Hash containers by value so moved/cloned nodes still resolve. Scalars are
 * skipped — bare values collide too readily to map confidently. */
function containerHash(node: Node): string | undefined {
  if (isMap(node) || isSeq(node)) {
    try {
      return JSON.stringify(node.toJSON());
    } catch {
      return undefined;
    }
  }
  return undefined;
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

interface SourceEntry {
  path: Path;
  range: Range;
}

function indexSource(ctx: ParseContext) {
  const byPath = new Map<string, Range>();
  const byHash = new Map<string, SourceEntry[]>();
  walk(ctx.doc.contents as Node | null, [], ctx.lineCounter, (node, path) => {
    const range = nodeRange(node, ctx.lineCounter);
    if (!range) return;
    byPath.set(pathKey(path), range);
    const hash = containerHash(node);
    if (hash !== undefined) {
      const list = byHash.get(hash) ?? [];
      list.push({ path, range });
      byHash.set(hash, list);
    }
  });
  return { byPath, byHash };
}

function sharedPrefix(a: Path, b: Path): number {
  let n = 0;
  while (n < a.length && n < b.length && String(a[n]) === String(b[n])) n++;
  return n;
}

/**
 * THE upgrade seam. Returns the lone resolver `buildSourceMap` calls. Today it
 * matches generated nodes back to source ranges heuristically; swapping to IR
 * provenance means replacing only this factory's body (and deleting the
 * `indexSource`/`containerHash`/`sharedPrefix` helpers) with an `originOf`
 * lookup. `buildSourceMap` and the map format are untouched by that swap.
 *
 * Containers resolve by value identity first: a transform can move a node to a
 * path that a *different* source node already occupies (e.g. a fragment step
 * lands on `steps.0`, where the source had `- inject:`), so matching on path
 * alone would point at the wrong line. Value-hash with a nearest-path-prefix
 * tiebreak picks the true origin, and naturally degrades to the exact path when
 * the value is unique. Scalars can't be hashed safely, so they use path only.
 */
function makeResolveOrigin(ctx: ParseContext): (node: Node, path: Path) => Range | undefined {
  const index = indexSource(ctx);
  return (node, path) => {
    const hash = containerHash(node);
    if (hash !== undefined) {
      const candidates = index.byHash.get(hash);
      if (candidates && candidates.length > 0) {
        let best = candidates[0];
        let bestScore = -1;
        for (const candidate of candidates) {
          const score = sharedPrefix(candidate.path, path);
          if (score > bestScore) {
            bestScore = score;
            best = candidate;
          }
        }
        return best.range;
      }
    }
    return index.byPath.get(pathKey(path));
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
    const range = resolveOrigin(node, path);
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
