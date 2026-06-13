// Generalized `when`-expression parser + evaluator.
//
// Extracted from `lib/tray/when.ts` so every plugin surface — UI slots,
// commands, quick actions, context menus, view containers — can gate a
// contribution on a declarative `when` clause, the way VS Code does
// (`"when": "editorHasSelection && chat.active"`).
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
// Predicates are resolved through a caller-supplied `WhenLookup`. The tray
// passes a nested-snapshot walker; the context-key store passes a flat-map
// reader. Unknown predicates resolve to `false` rather than throwing — the
// host UI still renders, the dependent item is just hidden. Parse errors
// surface via `Error` so tests can pin down the bad input.
//
// The parsed AST is memoised across calls so repeated rebuilds (state ticks)
// don't re-tokenize the same expressions. The cache is keyed on the raw
// expression string and is independent of the lookup, so it is safe to share
// between the tray and the context-key store.

/**
 * Resolve a dotted predicate (already split into path segments) to a boolean.
 * Implementations decide how the path maps onto their state model.
 */
export type WhenLookup = (path: string[]) => boolean

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

function evalNode(node: Node, lookup: WhenLookup): boolean {
  switch (node.type) {
    case "or":
      return evalNode(node.left, lookup) || evalNode(node.right, lookup)
    case "and":
      return evalNode(node.left, lookup) && evalNode(node.right, lookup)
    case "not":
      return !evalNode(node.child, lookup)
    case "ident":
      return lookup(node.path)
  }
}

const astCache = new Map<string, Node>()

/** Parse (and memoise) a `when` expression into its AST. Throws on bad input. */
export function parseWhenExpr(expr: string): Node {
  let node = astCache.get(expr)
  if (!node) {
    node = new Parser(tokenize(expr)).parseExpr()
    astCache.set(expr, node)
  }
  return node
}

/**
 * Evaluate a `when` expression against a caller-supplied lookup. Returns
 * `true` when the expression is absent or empty (i.e. "always show"); only an
 * explicit predicate suppresses an item. Throws on a malformed expression —
 * callers that prefer fail-closed should wrap in try/catch (see
 * `hooks/plugins/use-plugin-quick-actions.ts:safeWhen`).
 */
export function evaluateWhenExpr(expr: string | undefined, lookup: WhenLookup): boolean {
  if (!expr || !expr.trim()) return true
  return evalNode(parseWhenExpr(expr), lookup)
}

/** Test-only escape hatch. */
export function __resetWhenCacheForTesting(): void {
  astCache.clear()
}
