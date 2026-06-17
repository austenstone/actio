import { type Document, LineCounter, parseDocument } from "yaml";
import type { Diagnostic, Range } from "./diagnostics.js";

/** Plain-JS workflow model. Intentionally loose — we only type macro-relevant bits at use sites. */
// biome-ignore lint/suspicious/noExplicitAny: the workflow model is dynamic by nature
export type WorkflowData = Record<string, any>;

export type Path = (string | number)[];

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
  diagnostics: Diagnostic[];
  /** Per-node provenance side-table; never serialized. Populated by the IR layer. */
  origins: WeakMap<object, Origin>;
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
  const doc = parseDocument(source, { lineCounter, keepSourceTokens: true });
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

  const data = (doc.toJS({ maxAliasCount: -1 }) ?? {}) as WorkflowData;
  return { fileName, source, doc, lineCounter, data, diagnostics, origins: new WeakMap() };
}
