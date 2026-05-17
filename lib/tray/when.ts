// Tiny `when`-expression parser + evaluator for tray-menu visibility.
//
// Grammar (Pratt-style precedence climbing):
//
//   expr        := or
//   or          := and ( "||" and )*
//   and         := unary ( "&&" unary )*
//   unary       := "!" unary | primary
//   primary     := "(" expr ")" | predicate
//   predicate   := IDENT ( "." IDENT )*
//
// Predicates are looked up in a `TrayStateSnapshot`. Unknown predicates
// evaluate to `false` rather than throwing — the menu still renders, the
// dependent item is just hidden. Parse errors surface via `Error` so tests
// can pin down the bad input.

import type { TrayStateSnapshot } from "./types"

type Token =
  | { kind: "ident"; value: string }
  | { kind: "&&" }
  | { kind: "||" }
  | { kind: "!" }
  | { kind: "(" }
  | { kind: ")" }
  | { kind: "eof" }

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < input.length) {
    const c = input[i]
    if (c === " " || c === "\t" || c === "\n") {
      i++
      continue
    }
    if (c === "!") {
      tokens.push({ kind: "!" })
      i++
      continue
    }
    if (c === "(" || c === ")") {
      tokens.push({ kind: c })
      i++
      continue
    }
    if (c === "&" && input[i + 1] === "&") {
      tokens.push({ kind: "&&" })
      i += 2
      continue
    }
    if (c === "|" && input[i + 1] === "|") {
      tokens.push({ kind: "||" })
      i += 2
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i
      while (j < input.length && /[A-Za-z0-9_.]/.test(input[j])) j++
      tokens.push({ kind: "ident", value: input.slice(i, j) })
      i = j
      continue
    }
    throw new Error(`unexpected character '${c}' in when-expression at ${i}`)
  }
  tokens.push({ kind: "eof" })
  return tokens
}

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]
  }
  private consume(): Token {
    return this.tokens[this.pos++]
  }
  private expect(kind: Token["kind"]): Token {
    const tok = this.consume()
    if (tok.kind !== kind) throw new Error(`expected ${kind}, got ${tok.kind}`)
    return tok
  }

  parseExpr(): Node {
    const node = this.parseOr()
    this.expect("eof")
    return node
  }

  private parseOr(): Node {
    let left = this.parseAnd()
    while (this.peek().kind === "||") {
      this.consume()
      const right = this.parseAnd()
      left = { type: "or", left, right }
    }
    return left
  }

  private parseAnd(): Node {
    let left = this.parseUnary()
    while (this.peek().kind === "&&") {
      this.consume()
      const right = this.parseUnary()
      left = { type: "and", left, right }
    }
    return left
  }

  private parseUnary(): Node {
    if (this.peek().kind === "!") {
      this.consume()
      return { type: "not", child: this.parseUnary() }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): Node {
    const tok = this.consume()
    if (tok.kind === "(") {
      const inner = this.parseOr()
      this.expect(")")
      return inner
    }
    if (tok.kind === "ident") {
      return { type: "ident", path: tok.value.split(".") }
    }
    throw new Error(`unexpected token ${tok.kind}`)
  }
}

type Node =
  | { type: "or"; left: Node; right: Node }
  | { type: "and"; left: Node; right: Node }
  | { type: "not"; child: Node }
  | { type: "ident"; path: string[] }

function evalNode(node: Node, snapshot: TrayStateSnapshot): boolean {
  switch (node.type) {
    case "or":
      return evalNode(node.left, snapshot) || evalNode(node.right, snapshot)
    case "and":
      return evalNode(node.left, snapshot) && evalNode(node.right, snapshot)
    case "not":
      return !evalNode(node.child, snapshot)
    case "ident":
      return lookup(snapshot, node.path)
  }
}

function lookup(snapshot: TrayStateSnapshot, path: string[]): boolean {
  if (path[0] === "platform" && path.length === 2) {
    return snapshot.platform.os === path[1]
  }
  let cur: unknown = snapshot
  for (const segment of path) {
    if (cur == null || typeof cur !== "object") return false
    cur = (cur as Record<string, unknown>)[segment]
  }
  return Boolean(cur)
}

/**
 * Evaluate a `when` expression. Returns `true` when the expression is
 * absent or empty (i.e. "always show"); only an explicit predicate suppresses
 * an item.
 *
 * Cache: the parsed AST is memoised across calls so repeated rebuilds
 * (state ticks) don't re-tokenize the same expressions.
 */
const astCache = new Map<string, Node>()

export function evaluateWhen(expr: string | undefined, snapshot: TrayStateSnapshot): boolean {
  if (!expr || !expr.trim()) return true
  let node = astCache.get(expr)
  if (!node) {
    node = new Parser(tokenize(expr)).parseExpr()
    astCache.set(expr, node)
  }
  return evalNode(node, snapshot)
}

/** Test-only escape hatch. */
export function __resetWhenCacheForTesting(): void {
  astCache.clear()
}
