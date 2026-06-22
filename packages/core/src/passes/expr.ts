// The single shared compile-time expression engine. Bet 3/4 and the sibling bets
// (#160 ref graph, #161 cross-file import) all evaluate `{{ }}` through THIS Pratt
// tokenizer/parser/evaluator. Keeping one parser here makes the "no second
// evaluator" invariant grep-checkable (one `class ExprParser`, in this file).
import { hasOddBackslashRun } from "../text.js";

export type Primitive = string | number | boolean | null;
export type PathSegment = string | number | boolean | null;

export interface LiteralNode {
  kind: "literal";
  value: Primitive;
}

export interface RefNode {
  kind: "ref";
  segments: PathSegment[];
}

export interface CallNode {
  kind: "call";
  name: string;
  args: ExprNode[];
}

export interface UnaryNode {
  kind: "unary";
  op: "!" | "-";
  expr: ExprNode;
}

export interface BinaryNode {
  kind: "binary";
  op: "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%";
  left: ExprNode;
  right: ExprNode;
}

export interface ConditionalNode {
  kind: "conditional";
  test: ExprNode;
  consequent: ExprNode;
  alternate: ExprNode;
}

export interface ListNode {
  kind: "list";
  elements: ExprNode[];
}

export interface ObjectEntry {
  key: string;
  value: ExprNode;
}

export interface ObjectNode {
  kind: "object";
  entries: ObjectEntry[];
}

export interface ComprehensionNode {
  kind: "comprehension";
  body: ExprNode;
  varName: string;
  iterable: ExprNode;
}

export type ExprNode =
  | LiteralNode
  | RefNode
  | CallNode
  | UnaryNode
  | BinaryNode
  | ConditionalNode
  | ListNode
  | ObjectNode
  | ComprehensionNode;

export type ExprErrorCode = "parse" | "unknown-name" | "type" | "runtime-fn";

// Typed engine failures so each consumer (static-if, params text path, let) can map
// the SAME thrown error to its own diagnostic code without re-parsing the message.
export class ExprError extends Error {
  readonly code: ExprErrorCode;
  constructor(code: ExprErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ExprError";
  }
}

export interface Token {
  kind: "identifier" | "number" | "string" | "boolean" | "null" | "operator" | "punct" | "eof";
  value: string;
  pos: number;
}

export const TOKEN_OPERATORS = new Set([
  "||",
  "&&",
  "==",
  "!=",
  "<=",
  ">=",
  "<",
  ">",
  "!",
  "+",
  "-",
  "*",
  "/",
  "%",
  "?",
]);

export const TOKEN_PUNCT = new Set(["(", ")", "[", "]", ".", ",", "{", "}", ":"]);

export const isIdentifierStart = (char: string): boolean => /[A-Za-z_]/.test(char);

export const isIdentifierPart = (char: string): boolean => /[A-Za-z0-9_]/.test(char);

export const isComparable = (value: unknown): value is string | number => {
  if (typeof value === "string") return true;
  return typeof value === "number" && Number.isFinite(value);
};

export const refToString = (segments: PathSegment[]): string => {
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

export class Tokenizer {
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
        if (quote === '"' && hasOddBackslashRun(this.source, this.#index)) {
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

export class ExprParser {
  readonly #tokenizer: Tokenizer;
  #lookahead: Token;

  constructor(source: string) {
    this.#tokenizer = new Tokenizer(source);
    this.#lookahead = this.#tokenizer.next();
  }

  parseExpression(): ExprNode {
    const expr = this.parseTernary();
    if (this.#lookahead.kind !== "eof") {
      throw new Error(`Unexpected token "${this.#lookahead.value}"`);
    }
    return expr;
  }

  parseTernary(): ExprNode {
    const test = this.parseOr();
    if (this.matchOperator("?")) {
      const consequent = this.parseTernary();
      this.consume("punct", ":");
      const alternate = this.parseTernary();
      return { kind: "conditional", test, consequent, alternate };
    }
    return test;
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
    let left = this.parseAdditive();
    if (
      this.#lookahead.kind === "operator" &&
      ["==", "!=", "<", "<=", ">", ">="].includes(this.#lookahead.value)
    ) {
      const operator = this.#lookahead.value as BinaryNode["op"];
      this.consume("operator", operator);
      left = { kind: "binary", op: operator, left, right: this.parseAdditive() };
    }
    return left;
  }

  parseAdditive(): ExprNode {
    let left = this.parseMultiplicative();
    while (
      this.#lookahead.kind === "operator" &&
      (this.#lookahead.value === "+" || this.#lookahead.value === "-")
    ) {
      const op = this.#lookahead.value as "+" | "-";
      this.consume("operator", op);
      left = { kind: "binary", op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  parseMultiplicative(): ExprNode {
    let left = this.parseUnary();
    while (
      this.#lookahead.kind === "operator" &&
      (this.#lookahead.value === "*" ||
        this.#lookahead.value === "/" ||
        this.#lookahead.value === "%")
    ) {
      const op = this.#lookahead.value as "*" | "/" | "%";
      this.consume("operator", op);
      left = { kind: "binary", op, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary(): ExprNode {
    if (this.matchOperator("!")) {
      return { kind: "unary", op: "!", expr: this.parseUnary() };
    }
    if (this.matchOperator("-")) {
      return { kind: "unary", op: "-", expr: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary(): ExprNode {
    if (this.matchPunct("(")) {
      const expr = this.parseTernary();
      this.consume("punct", ")");
      return expr;
    }
    if (this.matchPunct("[")) {
      return this.parseListOrComprehension();
    }
    if (this.matchPunct("{")) {
      return this.parseObject();
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
        args.push(this.parseTernary());
        while (this.matchPunct(",")) args.push(this.parseTernary());
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

  // `for`/`in` are CONTEXTUAL identifiers: only special inside `[...]`.
  parseListOrComprehension(): ExprNode {
    if (this.matchPunct("]")) return { kind: "list", elements: [] };
    const first = this.parseTernary();
    if (this.#lookahead.kind === "identifier" && this.#lookahead.value === "for") {
      this.consume("identifier", "for");
      const varName = this.consume("identifier").value;
      this.consume("identifier", "in");
      const iterable = this.parseTernary();
      this.consume("punct", "]");
      return { kind: "comprehension", body: first, varName, iterable };
    }
    const elements = [first];
    while (this.matchPunct(",")) elements.push(this.parseTernary());
    this.consume("punct", "]");
    return { kind: "list", elements };
  }

  parseObject(): ExprNode {
    const entries: ObjectEntry[] = [];
    if (this.matchPunct("}")) return { kind: "object", entries };
    entries.push(this.parseObjectEntry());
    while (this.matchPunct(",")) entries.push(this.parseObjectEntry());
    this.consume("punct", "}");
    return { kind: "object", entries };
  }

  parseObjectEntry(): ObjectEntry {
    const token = this.#lookahead;
    let key: string;
    if (token.kind === "identifier") key = this.consume("identifier").value;
    else if (token.kind === "string") key = this.consume("string").value;
    else throw new Error(`Expected object key, found "${token.value}"`);
    this.consume("punct", ":");
    return { key, value: this.parseTernary() };
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

export const collectRefNodes = (
  expr: ExprNode,
  refs: RefNode[] = [],
  bound: ReadonlySet<string> = new Set(),
): RefNode[] => {
  switch (expr.kind) {
    case "ref": {
      const head = expr.segments[0];
      if (!(typeof head === "string" && bound.has(head))) refs.push(expr);
      return refs;
    }
    case "unary":
      return collectRefNodes(expr.expr, refs, bound);
    case "binary":
      collectRefNodes(expr.left, refs, bound);
      collectRefNodes(expr.right, refs, bound);
      return refs;
    case "call":
      for (const arg of expr.args) collectRefNodes(arg, refs, bound);
      return refs;
    case "conditional":
      collectRefNodes(expr.test, refs, bound);
      collectRefNodes(expr.consequent, refs, bound);
      collectRefNodes(expr.alternate, refs, bound);
      return refs;
    case "list":
      for (const element of expr.elements) collectRefNodes(element, refs, bound);
      return refs;
    case "object":
      for (const entry of expr.entries) collectRefNodes(entry.value, refs, bound);
      return refs;
    case "comprehension": {
      collectRefNodes(expr.iterable, refs, bound);
      const inner = new Set(bound);
      inner.add(expr.varName);
      collectRefNodes(expr.body, refs, inner);
      return refs;
    }
    case "literal":
      return refs;
  }
};

export interface RefUsage {
  segments: PathSegment[];
  hasStrictUsage: boolean;
  hasDefinedProbeUsage: boolean;
}

export const collectRefUsage = (
  expr: ExprNode,
  usage = new Map<string, RefUsage>(),
  options: { inDefinedProbeArg: boolean } = { inDefinedProbeArg: false },
  bound: ReadonlySet<string> = new Set(),
): Map<string, RefUsage> => {
  switch (expr.kind) {
    case "ref": {
      const head = expr.segments[0];
      if (typeof head === "string" && bound.has(head)) return usage;
      const key = refToString(expr.segments);
      const existing = usage.get(key);
      if (existing) {
        if (options.inDefinedProbeArg) existing.hasDefinedProbeUsage = true;
        else existing.hasStrictUsage = true;
        return usage;
      }
      usage.set(key, {
        segments: expr.segments,
        hasStrictUsage: !options.inDefinedProbeArg,
        hasDefinedProbeUsage: options.inDefinedProbeArg,
      });
      return usage;
    }
    case "unary":
      return collectRefUsage(expr.expr, usage, options, bound);
    case "binary":
      collectRefUsage(expr.left, usage, options, bound);
      collectRefUsage(expr.right, usage, options, bound);
      return usage;
    case "call":
      expr.args.forEach((arg, index) => {
        const inDefinedProbeArg = expr.name === "defined" && index === 0 && arg.kind === "ref";
        collectRefUsage(arg, usage, { inDefinedProbeArg }, bound);
      });
      return usage;
    case "conditional":
      collectRefUsage(expr.test, usage, options, bound);
      collectRefUsage(expr.consequent, usage, options, bound);
      collectRefUsage(expr.alternate, usage, options, bound);
      return usage;
    case "list":
      for (const element of expr.elements) collectRefUsage(element, usage, options, bound);
      return usage;
    case "object":
      for (const entry of expr.entries) collectRefUsage(entry.value, usage, options, bound);
      return usage;
    case "comprehension": {
      collectRefUsage(expr.iterable, usage, options, bound);
      const inner = new Set(bound);
      inner.add(expr.varName);
      collectRefUsage(expr.body, usage, options, inner);
      return usage;
    }
    case "literal":
      return usage;
  }
};

const RUNTIME_ONLY_FUNCTIONS = new Set([
  "hashFiles",
  "success",
  "failure",
  "always",
  "cancelled",
  "fromJSON",
]);

export const evalCall = (name: string, args: unknown[]): unknown => {
  if (RUNTIME_ONLY_FUNCTIONS.has(name)) {
    throw new ExprError(
      "runtime-fn",
      `Function "${name}" is runtime-only and cannot be evaluated at compile time`,
    );
  }
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
  if (name === "upper") {
    const [value] = args;
    if (typeof value !== "string") throw new ExprError("type", "upper requires a string argument");
    return value.toUpperCase();
  }
  if (name === "lower") {
    const [value] = args;
    if (typeof value !== "string") throw new ExprError("type", "lower requires a string argument");
    return value.toLowerCase();
  }
  if (name === "concat") {
    return args.map((value) => String(value ?? "")).join("");
  }
  if (name === "split") {
    const [value, separator] = args;
    if (typeof value !== "string" || typeof separator !== "string") {
      throw new ExprError("type", "split requires string arguments");
    }
    return value.split(separator);
  }
  if (name === "replace") {
    const [value, search, replacement] = args;
    if (
      typeof value !== "string" ||
      typeof search !== "string" ||
      typeof replacement !== "string"
    ) {
      throw new ExprError("type", "replace requires string arguments");
    }
    return value.replaceAll(search, replacement);
  }
  if (name === "join") {
    const [list, separator] = args;
    if (!Array.isArray(list)) {
      throw new ExprError("type", "join requires a list as its first argument");
    }
    return list
      .map((value) => String(value ?? ""))
      .join(typeof separator === "string" ? separator : ",");
  }
  if (name === "toJSON") {
    const [value] = args;
    return JSON.stringify(value);
  }
  throw new ExprError("unknown-name", `Unknown function "${name}"`);
};

export interface EvalEnv {
  resolveRef(segments: PathSegment[]): { resolved: boolean; value?: unknown };
  scope: ReadonlyMap<string, unknown>;
}

const indexInto = (value: unknown, segment: PathSegment): unknown => {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return typeof segment === "number" ? value[segment] : undefined;
  if (typeof value === "object") return (value as Record<string, unknown>)[String(segment)];
  return undefined;
};

const evalRef = (expr: RefNode, env: EvalEnv): unknown => {
  const head = expr.segments[0];
  if (typeof head === "string" && env.scope.has(head)) {
    let value = env.scope.get(head);
    for (let i = 1; i < expr.segments.length; i++) {
      value = indexInto(value, expr.segments[i] as PathSegment);
    }
    return value;
  }
  const resolved = env.resolveRef(expr.segments);
  if (!resolved.resolved) {
    throw new ExprError("unknown-name", `Unknown name "${refToString(expr.segments)}"`);
  }
  return resolved.value;
};

const requireNumbers = (op: string, left: unknown, right: unknown): [number, number] => {
  if (typeof left !== "number" || typeof right !== "number") {
    throw new ExprError("type", `${op} requires numeric operands`);
  }
  return [left, right];
};

const evalBinary = (expr: BinaryNode, env: EvalEnv): unknown => {
  const left = evalExpr(expr.left, env);
  const right = evalExpr(expr.right, env);
  switch (expr.op) {
    case "||":
      if (typeof left !== "boolean" || typeof right !== "boolean") {
        throw new ExprError("type", "|| requires boolean operands");
      }
      return left || right;
    case "&&":
      if (typeof left !== "boolean" || typeof right !== "boolean") {
        throw new ExprError("type", "&& requires boolean operands");
      }
      return left && right;
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case "<":
      if (!isComparable(left) || !isComparable(right))
        throw new ExprError("type", "< requires comparable operands");
      return left < right;
    case "<=":
      if (!isComparable(left) || !isComparable(right))
        throw new ExprError("type", "<= requires comparable operands");
      return left <= right;
    case ">":
      if (!isComparable(left) || !isComparable(right))
        throw new ExprError("type", "> requires comparable operands");
      return left > right;
    case ">=":
      if (!isComparable(left) || !isComparable(right))
        throw new ExprError("type", ">= requires comparable operands");
      return left >= right;
    case "+": {
      const [a, b] = requireNumbers("+", left, right);
      return a + b;
    }
    case "-": {
      const [a, b] = requireNumbers("-", left, right);
      return a - b;
    }
    case "*": {
      const [a, b] = requireNumbers("*", left, right);
      return a * b;
    }
    case "/": {
      const [a, b] = requireNumbers("/", left, right);
      return a / b;
    }
    case "%": {
      const [a, b] = requireNumbers("%", left, right);
      return a % b;
    }
  }
};

const evalComprehension = (expr: ComprehensionNode, env: EvalEnv): unknown[] => {
  const iterable = evalExpr(expr.iterable, env);
  if (!Array.isArray(iterable)) {
    throw new ExprError("type", "Comprehension iterable must be a list");
  }
  return iterable.map((item) => {
    const scope = new Map(env.scope);
    scope.set(expr.varName, item);
    return evalExpr(expr.body, { resolveRef: env.resolveRef, scope });
  });
};

export const evalExpr = (expr: ExprNode, env: EvalEnv): unknown => {
  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "ref":
      return evalRef(expr, env);
    case "call":
      return evalCall(
        expr.name,
        expr.args.map((arg) => evalExpr(arg, env)),
      );
    case "unary": {
      const value = evalExpr(expr.expr, env);
      if (expr.op === "!") {
        if (typeof value !== "boolean") {
          throw new ExprError("type", "Unary ! requires a boolean operand");
        }
        return !value;
      }
      if (typeof value !== "number") {
        throw new ExprError("type", "Unary - requires a numeric operand");
      }
      return -value;
    }
    case "conditional": {
      const test = evalExpr(expr.test, env);
      if (typeof test !== "boolean") {
        throw new ExprError("type", "Ternary condition must be a boolean");
      }
      return test ? evalExpr(expr.consequent, env) : evalExpr(expr.alternate, env);
    }
    case "list":
      return expr.elements.map((element) => evalExpr(element, env));
    case "object": {
      const result: Record<string, unknown> = {};
      for (const entry of expr.entries) result[entry.key] = evalExpr(entry.value, env);
      return result;
    }
    case "comprehension":
      return evalComprehension(expr, env);
    case "binary":
      return evalBinary(expr, env);
  }
};

export const parseExpressionOrThrow = (raw: string): ExprNode => {
  try {
    return new ExprParser(raw).parseExpression();
  } catch (error) {
    if (error instanceof ExprError) throw error;
    throw new ExprError("parse", error instanceof Error ? error.message : "parse failed");
  }
};

export const parseExpression = (raw: string): ExprNode | undefined => {
  try {
    return parseExpressionOrThrow(raw);
  } catch {
    return undefined;
  }
};
