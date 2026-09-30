/**
 * Excel formula parser for the workbook evaluator (`formula-eval.ts`).
 *
 * Parses a stored formula (no leading `=`) into an AST. References are read
 * through `readReferenceAt` — the same grammar `formula-refs.ts` rewrites on
 * structural edits — so a reference the rewriter shifts is exactly one the
 * evaluator reads.
 *
 * Two failures are kept apart on purpose:
 * - `FormulaSyntaxError`: the text is not a formula (unbalanced parentheses,
 *   a dangling operator). Excel would refuse to accept it.
 * - `FormulaUnsupportedError`: valid Excel this engine does not evaluate —
 *   3D and external-workbook references, structured table references, defined
 *   names, the intersection and union operators. The evaluator keeps such a
 *   cell's cached value rather than overwriting it with a wrong one.
 *
 * Operator precedence follows Excel, highest first: `:` (inside a reference
 * token), unary minus, `%`, `^`, `* /`, `+ -`, `&`, comparisons. Negation
 * binds tighter than `^`, so `-2^2` is 4, as in Excel.
 */

import { readReferenceAt, type RefBody } from "./formula-refs"

export const FORMULA_ERROR_CODES = [
  "#NULL!",
  "#DIV/0!",
  "#VALUE!",
  "#REF!",
  "#NAME?",
  "#NUM!",
  "#N/A",
  "#GETTING_DATA",
  "#SPILL!",
  "#CALC!",
] as const
export type FormulaErrorCode = (typeof FORMULA_ERROR_CODES)[number]

export type ComparisonOperator = "=" | "<>" | "<" | ">" | "<=" | ">="
export type BinaryOperator = "+" | "-" | "*" | "/" | "^" | "&" | ComparisonOperator

/** A literal inside an array constant (`{1,2;"a",TRUE}`). */
export type ArrayLiteral = number | string | boolean | { error: FormulaErrorCode }

export type FormulaNode =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "error"; code: FormulaErrorCode }
  | { kind: "ref"; sheet?: string; body: RefBody }
  | { kind: "array"; rows: ArrayLiteral[][] }
  | { kind: "unary"; op: "+" | "-"; operand: FormulaNode }
  | { kind: "percent"; operand: FormulaNode }
  | { kind: "binary"; op: BinaryOperator; left: FormulaNode; right: FormulaNode }
  /** `args` holds `null` for an omitted argument (`IF(A1,,2)`). */
  | { kind: "call"; name: string; args: Array<FormulaNode | null> }

export class FormulaSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FormulaSyntaxError"
  }
}

export class FormulaUnsupportedError extends Error {
  constructor(
    message: string,
    /** Set when the construct is a name Excel would resolve (a function or defined name). */
    readonly unknownName?: string
  ) {
    super(message)
    this.name = "FormulaUnsupportedError"
  }
}

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "error"; code: FormulaErrorCode }
  | { type: "ref"; sheet?: string; body: RefBody }
  | { type: "word"; value: string }
  | { type: "op"; value: string }
  | { type: "punct"; value: "(" | ")" | "," | ";" | "{" | "}" }

const WORD_CHAR = /[\p{L}\p{N}_.$\\]/u
const NUMBER = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
const ERROR_LITERAL = /#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!)/iy
/** Prefixes Excel writes in front of functions newer than the file format. */
const FUTURE_FUNCTION_PREFIX = /^_(?:XLFN|XLWS)\./

/** Parse one stored formula (without `=`). */
export function parseFormula(formula: string): FormulaNode {
  const tokens = tokenize(formula)
  let position = 0
  const peek = (): Token | undefined => tokens[position]
  const take = (): Token | undefined => tokens[position++]
  const isOp = (token: Token | undefined, ...values: string[]) =>
    token?.type === "op" && values.includes(token.value)
  const isPunct = (token: Token | undefined, value: string) =>
    token?.type === "punct" && token.value === value
  const expect = (value: string) => {
    const token = take()
    if (!(token?.type === "punct" && token.value === value))
      throw new FormulaSyntaxError(`expected "${value}"`)
  }

  const comparison = (): FormulaNode => {
    let left = concatenation()
    while (isOp(peek(), "=", "<>", "<", ">", "<=", ">=")) {
      const op = (take() as { value: ComparisonOperator }).value
      left = { kind: "binary", op, left, right: concatenation() }
    }
    return left
  }
  const concatenation = (): FormulaNode => {
    let left = additive()
    while (isOp(peek(), "&")) {
      take()
      left = { kind: "binary", op: "&", left, right: additive() }
    }
    return left
  }
  const additive = (): FormulaNode => {
    let left = multiplicative()
    while (isOp(peek(), "+", "-")) {
      const op = (take() as { value: "+" | "-" }).value
      left = { kind: "binary", op, left, right: multiplicative() }
    }
    return left
  }
  const multiplicative = (): FormulaNode => {
    let left = exponent()
    while (isOp(peek(), "*", "/")) {
      const op = (take() as { value: "*" | "/" }).value
      left = { kind: "binary", op, left, right: exponent() }
    }
    return left
  }
  // Excel's `^` is left-associative: 2^3^2 is 64.
  const exponent = (): FormulaNode => {
    let left = percent()
    while (isOp(peek(), "^")) {
      take()
      left = { kind: "binary", op: "^", left, right: percent() }
    }
    return left
  }
  const percent = (): FormulaNode => {
    let operand = unary()
    while (isOp(peek(), "%")) {
      take()
      operand = { kind: "percent", operand }
    }
    return operand
  }
  const unary = (): FormulaNode => {
    if (isOp(peek(), "+", "-")) {
      const op = (take() as { value: "+" | "-" }).value
      return { kind: "unary", op, operand: unary() }
    }
    return primary()
  }
  const primary = (): FormulaNode => {
    const token = take()
    if (!token) throw new FormulaSyntaxError("unexpected end of formula")
    switch (token.type) {
      case "number":
        return { kind: "number", value: token.value }
      case "string":
        return { kind: "string", value: token.value }
      case "error":
        return { kind: "error", code: token.code }
      case "ref":
        return {
          kind: "ref",
          ...(token.sheet !== undefined ? { sheet: token.sheet } : {}),
          body: token.body,
        }
      case "word":
        return word(token.value)
      case "punct":
        if (token.value === "(") {
          const inner = comparison()
          expect(")")
          return inner
        }
        if (token.value === "{") return arrayConstant()
        throw new FormulaSyntaxError(`unexpected "${token.value}"`)
      case "op":
        throw new FormulaSyntaxError(`unexpected operator "${token.value}"`)
    }
  }
  const word = (value: string): FormulaNode => {
    if (isPunct(peek(), "(")) {
      take()
      const name = value.toUpperCase().replace(FUTURE_FUNCTION_PREFIX, "")
      const args: Array<FormulaNode | null> = []
      if (isPunct(peek(), ")")) {
        take()
        return { kind: "call", name, args }
      }
      for (;;) {
        args.push(isPunct(peek(), ",") || isPunct(peek(), ")") ? null : comparison())
        const next = take()
        if (next?.type === "punct" && next.value === ")") break
        if (!(next?.type === "punct" && next.value === ",")) {
          throw new FormulaSyntaxError(`expected "," or ")" in ${name}()`)
        }
      }
      return { kind: "call", name, args }
    }
    const upper = value.toUpperCase()
    if (upper === "TRUE" || upper === "FALSE") return { kind: "boolean", value: upper === "TRUE" }
    throw new FormulaUnsupportedError(`defined names are not evaluated: ${value}`, value)
  }
  const arrayConstant = (): FormulaNode => {
    const rows: ArrayLiteral[][] = [[]]
    for (;;) {
      rows[rows.length - 1].push(arrayLiteral())
      const next = take()
      if (next?.type === "punct" && next.value === "}") break
      if (next?.type === "punct" && next.value === ";") rows.push([])
      else if (!(next?.type === "punct" && next.value === ","))
        throw new FormulaSyntaxError('expected ",", ";" or "}" in an array constant')
    }
    if (rows.some((row) => row.length !== rows[0].length))
      throw new FormulaSyntaxError("array constant rows must have the same length")
    return { kind: "array", rows }
  }
  const arrayLiteral = (): ArrayLiteral => {
    let sign = 1
    while (isOp(peek(), "+", "-")) if ((take() as { value: string }).value === "-") sign = -sign
    const token = take()
    if (token?.type === "number") return sign * token.value
    if (sign === 1 && token?.type === "string") return token.value
    if (sign === 1 && token?.type === "error") return { error: token.code }
    if (sign === 1 && token?.type === "word") {
      const upper = token.value.toUpperCase()
      if (upper === "TRUE" || upper === "FALSE") return upper === "TRUE"
    }
    throw new FormulaSyntaxError("array constants may only contain literals")
  }

  if (tokens.length === 0) throw new FormulaSyntaxError("formula is empty")
  const tree = comparison()
  if (position < tokens.length) {
    const rest = tokens[position]
    if (rest.type === "ref" || rest.type === "word" || isPunct(rest, "("))
      throw new FormulaUnsupportedError("the intersection operator is not evaluated")
    throw new FormulaSyntaxError(
      `unexpected "${rest.type === "punct" || rest.type === "op" ? rest.value : rest.type}"`
    )
  }
  return tree
}

function tokenize(formula: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < formula.length) {
    const char = formula[index]
    if (/\s/.test(char)) {
      index += 1
      continue
    }
    if (char === '"') {
      let value = ""
      let cursor = index + 1
      for (;;) {
        if (cursor >= formula.length) throw new FormulaSyntaxError("unterminated string")
        if (formula[cursor] === '"') {
          if (formula[cursor + 1] === '"') {
            value += '"'
            cursor += 2
            continue
          }
          break
        }
        value += formula[cursor]
        cursor += 1
      }
      tokens.push({ type: "string", value })
      index = cursor + 1
      continue
    }
    if (char === "[")
      throw new FormulaUnsupportedError(
        "structured and external-workbook references are not evaluated"
      )
    if (char === "#") {
      ERROR_LITERAL.lastIndex = index
      const match = ERROR_LITERAL.exec(formula)
      if (!match) throw new FormulaSyntaxError(`unknown error literal at ${index + 1}`)
      tokens.push({ type: "error", code: match[0].toUpperCase() as FormulaErrorCode })
      index += match[0].length
      continue
    }
    const startsWord = WORD_CHAR.test(char) && !WORD_CHAR.test(formula[index - 1] ?? "")
    if (char === "'" || startsWord) {
      const ref = readReferenceAt(formula, index)
      if (ref) {
        if (ref.prefix && ref.prefix.names.length > 1)
          throw new FormulaUnsupportedError("3D references are not evaluated")
        tokens.push({
          type: "ref",
          ...(ref.prefix ? { sheet: ref.prefix.names[0] } : {}),
          body: ref.body,
        })
        index = ref.end
        continue
      }
      if (char === "'") throw new FormulaSyntaxError("quoted text must name a sheet reference")
    }
    if (/[0-9.]/.test(char)) {
      NUMBER.lastIndex = index
      const match = NUMBER.exec(formula)
      if (match) {
        tokens.push({ type: "number", value: Number(match[0]) })
        index += match[0].length
        continue
      }
    }
    if (startsWord) {
      let end = index
      while (end < formula.length && WORD_CHAR.test(formula[end])) end += 1
      tokens.push({ type: "word", value: formula.slice(index, end) })
      index = end
      continue
    }
    const two = formula.slice(index, index + 2)
    if (two === "<>" || two === "<=" || two === ">=") {
      tokens.push({ type: "op", value: two })
      index += 2
      continue
    }
    if ("+-*/^&=<>%".includes(char)) {
      tokens.push({ type: "op", value: char })
      index += 1
      continue
    }
    if ("(),;{}".includes(char)) {
      tokens.push({ type: "punct", value: char as "(" | ")" | "," | ";" | "{" | "}" })
      index += 1
      continue
    }
    if (char === ":" || char === "!")
      throw new FormulaUnsupportedError(
        `the "${char}" operator outside a reference is not evaluated`
      )
    throw new FormulaSyntaxError(`unexpected character "${char}"`)
  }
  return tokens
}
