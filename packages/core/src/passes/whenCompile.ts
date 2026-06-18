import { deriveNode, visitJobs } from "../ir.js";
import type { ParseContext, Path } from "../parser.js";
import { collectExpressionRoots, RUNTIME_CONTEXT_ROOT_SET } from "../symbols.js";
import { isObject, pushDiagnostic } from "./helpers.js";
import type { Pass } from "./registry.js";

type Primitive = string | number | boolean | null;
type PathSegment = string | number | boolean | null;

interface LiteralNode {
  kind: "literal";
  value: Primitive;
}

interface RefNode {
  kind: "ref";
  segments: PathSegment[];
}

interface CallNode {
  kind: "call";
  name: string;
  args: ExprNode[];
}

interface UnaryNode {
  kind: "unary";
  op: "!";
  expr: ExprNode;
}

interface BinaryNode {
  kind: "binary";
  op: "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=";
  left: ExprNode;
  right: ExprNode;
}

type ExprNode = LiteralNode | RefNode | CallNode | UnaryNode | BinaryNode;

interface Token {
  kind: "identifier" | "number" | "string" | "boolean" | "null" | "operator" | "punct" | "eof";
  value: string;
  pos: number;
}

const FORM_B_KEY_RE = /^when_compile\((.+)\)$/;

const diagnosticMessage = (code: string, message: string): string => `[${code}] ${message}`;

const TOKEN_OPERATORS = new Set(["||", "&&", "==", "!=", "<=", ">=", "<", ">", "!"]);

const TOKEN_PUNCT = new Set(["(", ")", "[", "]", ".", ","]);

const isIdentifierStart = (char: string): boolean => /[A-Za-z_]/.test(char);

const isIdentifierPart = (char: string): boolean => /[A-Za-z0-9_]/.test(char);

const isComparable = (value: unknown): value is string | number => {
  if (typeof value === "string") return true;
  return typeof value === "number" && Number.isFinite(value);
};

const refToString = (segments: PathSegment[]): string => {
  if (segments.length === 0) return "";
  const [head, ...tail] = segments;
  const renderedHead =
    head === undefined ? "" : typeof head === "string" ? head : `[${JSON.stringify(head)}]`;
  return tail.reduce<string>((acc, segment) => {
    if (typeof segment === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) {
      return `${acc}.${segment}`;
    }
    return `${acc}[${JSON.stringify(segment)}]`;
  }, renderedHead);
};

const isJobPath = (path: Path): boolean =>
  path.length === 2 && path[0] === "jobs" && typeof path[1] === "string";

const isStepPath = (path: Path): boolean =>
  path.length === 4 &&
  path[0] === "jobs" &&
  typeof path[1] === "string" &&
  path[2] === "steps" &&
  typeof path[3] === "number";

const hintForRuntimeContext =
  "when_compile only supports compile-time roots (params.*, for_each.*, define.*). Use if: for runtime contexts.";

class Tokenizer {
  readonly source: string;
  #index = 0;

  constructor(source: string) {
    this.source = source;
  }

  next(): Token {
    this.skipWhitespace();
    if (this.#index >= this.source.length) return { kind: "eof", value: "", pos: this.#index };

    const start = this.#index;
    const two = this.source.slice(this.#index, this.#index + 2);
    if (TOKEN_OPERATORS.has(two)) {
      this.#index += 2;
      return { kind: "operator", value: two, pos: start };
    }

    const char = this.source[this.#index] ?? "";
    if (TOKEN_OPERATORS.has(char)) {
      this.#index++;
      return { kind: "operator", value: char, pos: start };
    }
    if (TOKEN_PUNCT.has(char)) {
      this.#index++;
      return { kind: "punct", value: char, pos: start };
    }
    if (char === "'" || char === '"') return this.readString(char);
    if (/\d/.test(char)) return this.readNumber();
    if (isIdentifierStart(char)) return this.readIdentifier();

    throw new Error(`Unexpected token "${char}" at index ${start}`);
  }

  skipWhitespace(): void {
    while (this.#index < this.source.length && /\s/.test(this.source[this.#index] ?? "")) {
      this.#index++;
    }
  }

  readIdentifier(): Token {
    const start = this.#index;
    this.#index++;
    while (this.#index < this.source.length && isIdentifierPart(this.source[this.#index] ?? "")) {
      this.#index++;
    }
    const value = this.source.slice(start, this.#index);
    if (value === "true" || value === "false") return { kind: "boolean", value, pos: start };
    if (value === "null") return { kind: "null", value, pos: start };
    return { kind: "identifier", value, pos: start };
  }

  readNumber(): Token {
    const start = this.#index;
    while (this.#index < this.source.length && /\d/.test(this.source[this.#index] ?? "")) {
      this.#index++;
    }
    if ((this.source[this.#index] ?? "") === ".") {
      this.#index++;
      while (this.#index < this.source.length && /\d/.test(this.source[this.#index] ?? "")) {
        this.#index++;
      }
    }
    return { kind: "number", value: this.source.slice(start, this.#index), pos: start };
  }

  readString(quote: string): Token {
    const start = this.#index;
    this.#index++;
    let value = "";
    while (this.#index < this.source.length) {
      const char = this.source[this.#index] ?? "";
      if (char === quote) {
        if (quote === "'" && this.source[this.#index + 1] === "'") {
          value += "'";
          this.#index += 2;
          continue;
        }
        if (quote === '"' && this.source[this.#index - 1] === "\\") {
          value = `${value.slice(0, -1)}${quote}`;
          this.#index++;
          continue;
        }
        this.#index++;
        return { kind: "string", value, pos: start };
      }
      value += char;
      this.#index++;
    }
    throw new Error(`Unterminated string literal at index ${start}`);
  }
}

class ExprParser {
  readonly #tokenizer: Tokenizer;
  #lookahead: Token;

  constructor(source: string) {
    this.#tokenizer = new Tokenizer(source);
    this.#lookahead = this.#tokenizer.next();
  }

  parseExpression(): ExprNode {
    const expr = this.parseOr();
    if (this.#lookahead.kind !== "eof") {
      throw new Error(`Unexpected token "${this.#lookahead.value}"`);
    }
    return expr;
  }

  parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.matchOperator("||")) {
      left = { kind: "binary", op: "||", left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd(): ExprNode {
    let left = this.parseCmp();
    while (this.matchOperator("&&")) {
      left = { kind: "binary", op: "&&", left, right: this.parseCmp() };
    }
    return left;
  }

  parseCmp(): ExprNode {
    let left = this.parseUnary();
    if (
      this.#lookahead.kind === "operator" &&
      ["==", "!=", "<", "<=", ">", ">="].includes(this.#lookahead.value)
    ) {
      const operator = this.#lookahead.value as BinaryNode["op"];
      this.consume("operator", operator);
      left = { kind: "binary", op: operator, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary(): ExprNode {
    if (this.matchOperator("!")) {
      return { kind: "unary", op: "!", expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary(): ExprNode {
    if (this.matchPunct("(")) {
      const expr = this.parseOr();
      this.consume("punct", ")");
      return expr;
    }
    if (this.#lookahead.kind === "string") {
      const token = this.#lookahead;
      this.consume("string");
      return { kind: "literal", value: token.value };
    }
    if (this.#lookahead.kind === "number") {
      const token = this.#lookahead;
      this.consume("number");
      return { kind: "literal", value: Number(token.value) };
    }
    if (this.#lookahead.kind === "boolean") {
      const token = this.#lookahead;
      this.consume("boolean");
      return { kind: "literal", value: token.value === "true" };
    }
    if (this.#lookahead.kind === "null") {
      this.consume("null");
      return { kind: "literal", value: null };
    }
    if (this.#lookahead.kind === "identifier") {
      return this.parseIdentifierStart();
    }
    throw new Error(`Expected expression, found "${this.#lookahead.value}"`);
  }

  parseIdentifierStart(): ExprNode {
    const identifier = this.consume("identifier").value;
    if (this.matchPunct("(")) {
      const args: ExprNode[] = [];
      if (!this.matchPunct(")")) {
        args.push(this.parseOr());
        while (this.matchPunct(",")) args.push(this.parseOr());
        this.consume("punct", ")");
      }
      return { kind: "call", name: identifier, args };
    }
    const segments: PathSegment[] = [identifier];
    while (true) {
      if (this.matchPunct(".")) {
        const next = this.consume("identifier");
        segments.push(next.value);
        continue;
      }
      if (this.matchPunct("[")) {
        const literal = this.parseLiteralToken();
        segments.push(literal);
        this.consume("punct", "]");
        continue;
      }
      break;
    }
    return { kind: "ref", segments };
  }

  parseLiteralToken(): Primitive {
    const token = this.#lookahead;
    if (token.kind === "string") {
      this.consume("string");
      return token.value;
    }
    if (token.kind === "number") {
      this.consume("number");
      return Number(token.value);
    }
    if (token.kind === "boolean") {
      this.consume("boolean");
      return token.value === "true";
    }
    if (token.kind === "null") {
      this.consume("null");
      return null;
    }
    throw new Error(`Expected literal inside bracket access, found "${token.value}"`);
  }

  consume(kind: Token["kind"], value?: string): Token {
    const token = this.#lookahead;
    if (token.kind !== kind) throw new Error(`Expected ${kind}, found "${token.value}"`);
    if (value !== undefined && token.value !== value) {
      throw new Error(`Expected "${value}", found "${token.value}"`);
    }
    this.#lookahead = this.#tokenizer.next();
    return token;
  }

  matchOperator(operator: string): boolean {
    if (this.#lookahead.kind === "operator" && this.#lookahead.value === operator) {
      this.consume("operator", operator);
      return true;
    }
    return false;
  }

  matchPunct(punct: string): boolean {
    if (this.#lookahead.kind === "punct" && this.#lookahead.value === punct) {
      this.consume("punct", punct);
      return true;
    }
    return false;
  }
}

const collectRefNodes = (expr: ExprNode, refs: RefNode[] = []): RefNode[] => {
  if (expr.kind === "ref") refs.push(expr);
  if (expr.kind === "unary") collectRefNodes(expr.expr, refs);
  if (expr.kind === "binary") {
    collectRefNodes(expr.left, refs);
    collectRefNodes(expr.right, refs);
  }
  if (expr.kind === "call") {
    for (const arg of expr.args) collectRefNodes(arg, refs);
  }
  return refs;
};

const normalizePathSegment = (segment: PathSegment): string | number => {
  if (typeof segment === "number") return segment;
  if (typeof segment === "string") return segment;
  return String(segment);
};

const resolveSymbolReference = (
  ctx: ParseContext,
  segments: PathSegment[],
): { resolved: boolean; value?: unknown } => {
  const root = segments[0];
  if (typeof root !== "string") return { resolved: false };

  let symbolKey: string | undefined;
  let offset = 0;
  if (segments.length >= 2 && typeof segments[1] === "string") {
    const candidate = `${root}.${segments[1]}`;
    if (ctx.symbols.has(candidate)) {
      symbolKey = candidate;
      offset = 2;
    }
  }
  if (!symbolKey && ctx.symbols.has(root)) {
    symbolKey = root;
    offset = 1;
  }
  if (!symbolKey) return { resolved: false };

  const symbol = ctx.symbols.get(symbolKey);
  if (!symbol) return { resolved: false };
  const valueKnown = symbol.valueKnown ?? symbol.compileTimeKnown;
  if (!valueKnown) return { resolved: false };

  let current: unknown = symbol.value;
  for (const segment of segments.slice(offset)) {
    const key = normalizePathSegment(segment);
    if (Array.isArray(current) && typeof key === "number" && Number.isInteger(key) && key >= 0) {
      if (key >= current.length) return { resolved: false };
      current = current[key];
      continue;
    }
    if (isObject(current) && Object.hasOwn(current, String(key))) {
      current = current[String(key)];
      continue;
    }
    return { resolved: false };
  }
  return { resolved: true, value: current };
};

const levenshtein = (left: string, right: string): number => {
  const matrix: number[][] = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, col) => (row === 0 ? col : col === 0 ? row : 0)),
  );
  for (let row = 1; row <= left.length; row++) {
    for (let col = 1; col <= right.length; col++) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      const rowValues = matrix[row];
      if (!rowValues) continue;
      rowValues[col] = Math.min(
        (matrix[row - 1]?.[col] ?? Number.MAX_SAFE_INTEGER) + 1,
        (rowValues[col - 1] ?? Number.MAX_SAFE_INTEGER) + 1,
        (matrix[row - 1]?.[col - 1] ?? Number.MAX_SAFE_INTEGER) + cost,
      );
    }
  }
  return matrix[left.length]?.[right.length] ?? Number.MAX_SAFE_INTEGER;
};

const suggestParamName = (ctx: ParseContext, paramName: string): string | undefined => {
  const candidates = [...ctx.symbols.keys()]
    .filter((key) => key.startsWith("params."))
    .map((key) => key.slice("params.".length))
    .filter((name) => name.length > 0);
  if (candidates.length === 0) return undefined;
  const ranked = [...candidates]
    .map((candidate) => ({ candidate, score: levenshtein(paramName, candidate) }))
    .sort((left, right) => left.score - right.score);
  const best = ranked[0];
  if (!best) return undefined;
  return best.score <= 3 ? best.candidate : undefined;
};

const evalCall = (name: string, args: unknown[]): unknown => {
  if (name === "contains") {
    const [haystack, needle] = args;
    if (typeof haystack === "string") return haystack.includes(String(needle ?? ""));
    if (Array.isArray(haystack)) return haystack.includes(needle);
    return false;
  }
  if (name === "startsWith") {
    const [value, prefix] = args;
    return typeof value === "string" && typeof prefix === "string"
      ? value.startsWith(prefix)
      : false;
  }
  if (name === "endsWith") {
    const [value, suffix] = args;
    return typeof value === "string" && typeof suffix === "string" ? value.endsWith(suffix) : false;
  }
  if (name === "format") {
    const [template, ...rest] = args;
    if (typeof template !== "string") return template;
    return rest.reduce<string>(
      (formatted, value, index) => formatted.replaceAll(`{${index}}`, String(value ?? "")),
      template,
    );
  }
  if (name === "defined") {
    const [value] = args;
    return value !== undefined && value !== null;
  }
  throw new Error(`Unknown function "${name}"`);
};

const evalExpr = (expr: ExprNode, refs: Map<string, unknown>): unknown => {
  if (expr.kind === "literal") return expr.value;
  if (expr.kind === "ref") {
    return refs.get(refToString(expr.segments));
  }
  if (expr.kind === "call") {
    return evalCall(
      expr.name,
      expr.args.map((arg) => evalExpr(arg, refs)),
    );
  }
  if (expr.kind === "unary") {
    const value = evalExpr(expr.expr, refs);
    if (typeof value !== "boolean") throw new Error("Unary ! requires a boolean operand");
    return !value;
  }
  const left = evalExpr(expr.left, refs);
  const right = evalExpr(expr.right, refs);
  switch (expr.op) {
    case "||":
      if (typeof left !== "boolean" || typeof right !== "boolean") {
        throw new Error("|| requires boolean operands");
      }
      return left || right;
    case "&&":
      if (typeof left !== "boolean" || typeof right !== "boolean") {
        throw new Error("&& requires boolean operands");
      }
      return left && right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case "<":
      if (!isComparable(left) || !isComparable(right))
        throw new Error("< requires comparable operands");
      return left < right;
    case "<=":
      if (!isComparable(left) || !isComparable(right))
        throw new Error("<= requires comparable operands");
      return left <= right;
    case ">":
      if (!isComparable(left) || !isComparable(right))
        throw new Error("> requires comparable operands");
      return left > right;
    case ">=":
      if (!isComparable(left) || !isComparable(right))
        throw new Error(">= requires comparable operands");
      return left >= right;
  }
};

const parseExpression = (raw: string): ExprNode | undefined => {
  try {
    return new ExprParser(raw).parseExpression();
  } catch {
    return undefined;
  }
};

const extractRuntimeWrapperExpression = (raw: string): string | undefined => {
  const wrapped = raw.match(/^\s*\$\{\{([\s\S]*)\}\}\s*$/);
  return wrapped?.[1]?.trim();
};

const evaluateWhenCompile = (
  ctx: ParseContext,
  rawExpression: string,
  path: Path,
): boolean | undefined => {
  const trimmed = rawExpression.trim();
  if (trimmed.length === 0) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "when-compile-empty",
        "when_compile requires a non-empty boolean expression",
      ),
      path,
    );
    return undefined;
  }

  const wrapped = extractRuntimeWrapperExpression(trimmed);
  if (wrapped !== undefined) {
    const wrapperRoots = collectExpressionRoots(
      wrapped,
      new Set([...RUNTIME_CONTEXT_ROOT_SET, "params"]),
    );
    if (wrapperRoots.has("params")) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "params-runtime-sigil",
          `Runtime expression "\${{ ${wrapped} }}" is invalid for params; use "{{ params.* }}"`,
        ),
        path,
      );
      return undefined;
    }
    const runtimeRoot = [...wrapperRoots].find((root) => RUNTIME_CONTEXT_ROOT_SET.has(root));
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "when-compile-runtime-context",
        runtimeRoot
          ? `when_compile cannot reference runtime context "${runtimeRoot}.*"`
          : "when_compile takes a bare compile-time expression; `${{ }}` is runtime-only",
      ),
      path,
      { hint: "Drop `${{ }}` and use a bare expression such as `params.deploy`." },
    );
    return undefined;
  }

  const parsed = parseExpression(trimmed);
  if (!parsed) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage("when-compile-empty", `Cannot parse when_compile expression "${trimmed}"`),
      path,
    );
    return undefined;
  }

  const refs = collectRefNodes(parsed);
  const roots = new Set<string>();
  for (const ref of refs) {
    const root = ref.segments[0];
    if (typeof root === "string") roots.add(root);
  }
  const runtimeRoot = [...roots].find((root) => RUNTIME_CONTEXT_ROOT_SET.has(root));
  if (runtimeRoot) {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "when-compile-runtime-context",
        `when_compile cannot reference runtime context "${runtimeRoot}.*"`,
      ),
      path,
      { hint: hintForRuntimeContext },
    );
    return undefined;
  }

  const resolvedRefs = new Map<string, unknown>();
  let hadUndefinedReference = false;
  for (const ref of refs) {
    const refKey = refToString(ref.segments);
    if (resolvedRefs.has(refKey)) continue;
    const resolved = resolveSymbolReference(ctx, ref.segments);
    if (!resolved.resolved) {
      hadUndefinedReference = true;
      const root = ref.segments[0];
      const second = ref.segments[1];
      const maybeSuggestion =
        root === "params" && typeof second === "string" ? suggestParamName(ctx, second) : undefined;
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "when-compile-undefined-ref",
          `when_compile references unknown value "${refKey}"`,
        ),
        path,
        {
          hint: maybeSuggestion
            ? `Did you mean "params.${maybeSuggestion}"?`
            : "Declare the value in params or seed it as a compile-time symbol before when_compile.",
        },
      );
      continue;
    }
    resolvedRefs.set(refKey, resolved.value);
  }
  if (hadUndefinedReference) return undefined;

  let value: unknown;
  try {
    value = evalExpr(parsed, resolvedRefs);
  } catch (error) {
    const message = error instanceof Error ? error.message : "failed evaluation";
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage("when-compile-non-boolean", `when_compile evaluation failed: ${message}`),
      path,
    );
    return undefined;
  }

  if (typeof value !== "boolean") {
    pushDiagnostic(
      ctx,
      "error",
      diagnosticMessage(
        "when-compile-non-boolean",
        `when_compile expression must resolve to boolean, got ${value === null ? "null" : typeof value}`,
      ),
      path,
    );
    return undefined;
  }
  return value;
};

const evaluateWhenCompileValue = (
  ctx: ParseContext,
  rawExpression: unknown,
  path: Path,
): boolean | undefined => {
  if (typeof rawExpression === "boolean") return rawExpression;
  if (typeof rawExpression === "string") return evaluateWhenCompile(ctx, rawExpression, path);
  pushDiagnostic(
    ctx,
    "error",
    diagnosticMessage(
      "when-compile-non-boolean",
      "when_compile must resolve to a boolean expression",
    ),
    path,
  );
  return undefined;
};

const OMIT = Symbol("actio.when_compile.omit");

type TransformedValue = unknown | typeof OMIT;

const transformNode = (ctx: ParseContext, value: unknown, path: Path): TransformedValue => {
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    value.forEach((item, index) => {
      const transformed = transformNode(ctx, item, [...path, index]);
      if (transformed !== OMIT) next.push(transformed);
    });
    return next;
  }

  if (!isObject(value)) return value;

  const allowFormA = isJobPath(path) || isStepPath(path);
  const formAExpression = value.when_compile;
  if (allowFormA && formAExpression !== undefined) {
    const keep = evaluateWhenCompileValue(ctx, formAExpression, [...path, "when_compile"]);
    if (keep === false) return OMIT;
    delete value.when_compile;
  }

  const keys = Object.keys(value);
  const formBKeys: string[] = [];
  for (const key of keys) {
    if (key === "when_compile") continue;
    const expression = key.match(FORM_B_KEY_RE)?.[1];
    if (expression) {
      formBKeys.push(key);
      continue;
    }
    const transformed = transformNode(ctx, value[key], [...path, key]);
    if (transformed === OMIT) delete value[key];
    else value[key] = transformed;
  }

  for (const key of formBKeys) {
    const expression = key.match(FORM_B_KEY_RE)?.[1] ?? "";
    const mergeValue = value[key];
    delete value[key];

    const keep = evaluateWhenCompile(ctx, expression, [...path, key]);
    if (keep !== true) continue;

    if (!isObject(mergeValue)) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "when-compile-merge-non-map",
          `when_compile(${expression}) must map to an object value for conditional merge`,
        ),
        [...path, key],
      );
      continue;
    }

    for (const [mergeKey, mergeChild] of Object.entries(mergeValue)) {
      const transformed = transformNode(ctx, mergeChild, [...path, key, mergeKey]);
      if (transformed === OMIT) continue;
      if (Object.hasOwn(value, mergeKey)) {
        pushDiagnostic(
          ctx,
          "warning",
          diagnosticMessage(
            "when-compile-merge-collision",
            `when_compile merge key "${mergeKey}" overrides an existing value`,
          ),
          [...path, key, mergeKey],
        );
      }
      value[mergeKey] = transformed;
      if (isObject(transformed) || Array.isArray(transformed)) {
        deriveNode(ctx, value, transformed as object);
      }
    }
  }

  return value;
};

const normalizeNeeds = (needs: unknown): string[] => {
  if (typeof needs === "string") return [needs];
  return Array.isArray(needs)
    ? needs.filter((value): value is string => typeof value === "string")
    : [];
};

export const whenCompilePass = (ctx: ParseContext): void => {
  const jobs = ctx.data.jobs;
  if (!isObject(jobs)) return;

  const omittedJobs = new Set<string>();
  for (const [jobId, rawJob] of Object.entries(jobs)) {
    const beforeSteps =
      isObject(rawJob) && Array.isArray(rawJob.steps) ? rawJob.steps.length : undefined;
    const transformed = transformNode(ctx, rawJob, ["jobs", jobId]);
    if (transformed === OMIT) {
      omittedJobs.add(jobId);
      delete jobs[jobId];
      continue;
    }
    jobs[jobId] = transformed;
    if (
      beforeSteps &&
      isObject(transformed) &&
      Array.isArray(transformed.steps) &&
      transformed.steps.length === 0
    ) {
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "when-compile-empty-job",
          `Job "${jobId}" has no steps after when_compile filtering; gate the job instead`,
        ),
        ["jobs", jobId, "steps"],
      );
    }
  }

  if (omittedJobs.size > 0) {
    visitJobs(ctx, ({ id, job, path }) => {
      const danglingNeeds = normalizeNeeds(job.needs).filter((need) => omittedJobs.has(need));
      if (danglingNeeds.length === 0) return;
      pushDiagnostic(
        ctx,
        "error",
        diagnosticMessage(
          "when-compile-dangling-needs",
          `Job "${id}" still needs omitted job(s): ${danglingNeeds.join(", ")}`,
        ),
        [...path, "needs"],
      );
    });
  }
};

export const whenCompile: Pass = {
  name: "when_compile",
  runsAfter: ["params", "for_each"],
  apply: whenCompilePass,
};
