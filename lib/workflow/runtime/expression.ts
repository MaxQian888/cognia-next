/**
 * Workflow expression resolver.
 *
 * The visual editor lets users wire data between nodes using mustache-style
 * expressions:
 *
 *     {{ $node['n_start'].out.timestamp }}
 *     {{ $trigger.payload.text }}
 *     {{ $static.counter }}
 *
 * This resolver evaluates such strings against an `ExpressionScope` at run
 * time. It is intentionally NOT a JavaScript interpreter — `Function()` /
 * `eval()` would be a significant attack surface in a desktop app that imports
 * arbitrary workflow JSON. Instead, we accept a fixed grammar:
 *
 *     <token>      := $node['<id>'] | $trigger | $static | $params
 *     <accessor>   := .<field>  | ['<key>']  | ["<key>"]  | [<index>]
 *     <expression> := <token>(<accessor>)*
 *
 * The grammar is intentionally tiny — everything else (string concat,
 * arithmetic, ternaries) belongs in a `data.template` or `data.code` node,
 * which has clearer execution semantics and can be sandboxed.
 *
 * If a string contains zero `{{ }}` segments, it's returned as-is. If it
 * contains one segment and nothing else, the resolver returns the typed
 * value (object / number / boolean) instead of stringifying it. Mixed
 * strings are concatenated as strings, with `null`/`undefined` rendered
 * as empty.
 */

import type { TriggerEvent } from "@/types/workflow/visual"

export interface ExpressionScope {
  /** Outputs from upstream nodes, keyed by node id. */
  upstream: Record<string, unknown>
  /** The current run's trigger event. */
  trigger: TriggerEvent
  /** Workflow-level mutable state. */
  staticData: Record<string, unknown>
  /** This node's resolved params before expression-evaluation (read-only). */
  params: Record<string, unknown>
}

/**
 * Resolves a single expression string. Returns the typed value if the
 * string is a single `{{ … }}` segment with no surrounding text;
 * otherwise returns a stringified concatenation.
 */
export function resolveExpression(input: string, scope: ExpressionScope): unknown {
  if (typeof input !== "string") return input
  if (!input.includes("{{")) return input

  const segments = parseExpression(input)
  if (segments.length === 1 && segments[0].kind === "expr") {
    return evalToken(segments[0].value, scope)
  }
  // Mixed string — concat. Each evaluated piece becomes its string repr.
  return segments
    .map((seg) => {
      if (seg.kind === "literal") return seg.value
      const v = evalToken(seg.value, scope)
      if (v === null || v === undefined) return ""
      if (typeof v === "object") return JSON.stringify(v)
      return String(v)
    })
    .join("")
}

/**
 * Walks an arbitrary structure (string / array / object) and resolves every
 * embedded expression. Used by the step executor to prepare a node's
 * `params` from the authored shape before invoking the executor.
 */
export function resolveDeep<T>(value: T, scope: ExpressionScope): T {
  if (typeof value === "string") {
    return resolveExpression(value, scope) as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => resolveDeep(v, scope)) as T
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = resolveDeep(v, scope)
    }
    return out as T
  }
  return value
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

interface LiteralSegment {
  kind: "literal"
  value: string
}

interface ExprSegment {
  kind: "expr"
  value: string // the inner expression text, trimmed
}

type Segment = LiteralSegment | ExprSegment

export function parseExpression(input: string): Segment[] {
  const result: Segment[] = []
  let i = 0
  while (i < input.length) {
    const open = input.indexOf("{{", i)
    if (open === -1) {
      result.push({ kind: "literal", value: input.slice(i) })
      break
    }
    if (open > i) {
      result.push({ kind: "literal", value: input.slice(i, open) })
    }
    const close = input.indexOf("}}", open + 2)
    if (close === -1) {
      // Unterminated — treat the rest as literal (matches user expectation
      // when they're typing and haven't closed the brace yet).
      result.push({ kind: "literal", value: input.slice(open) })
      break
    }
    const inner = input.slice(open + 2, close).trim()
    result.push({ kind: "expr", value: inner })
    i = close + 2
  }
  return result
}

/**
 * Evaluates a single token expression against the scope. Returns `undefined`
 * when the path doesn't exist (rather than throwing), which mirrors n8n's
 * behavior and keeps unfinished workflows runnable for testing.
 */
export function evalToken(expr: string, scope: ExpressionScope): unknown {
  if (!expr) return undefined
  const tokens = tokenize(expr)
  if (tokens.length === 0) return undefined

  const head = tokens[0]
  let cursor: unknown
  if (head.kind === "node") {
    // $node['n_id']
    cursor = scope.upstream[head.id]
  } else if (head.kind === "ident") {
    switch (head.name) {
      case "$trigger":
        cursor = scope.trigger
        break
      case "$static":
        cursor = scope.staticData
        break
      case "$params":
        cursor = scope.params
        break
      default:
        // Fallback: look the ident up in `upstream`. Executors that need to
        // expose iteration-local state (e.g. `flow.loop` injecting `$item`
        // and `$loop`) write the value into a copy of `upstream` before
        // calling `resolveExpression`. Returning `undefined` for an unknown
        // ident keeps the original "missing path → undefined" semantics.
        cursor = scope.upstream[head.name]
        if (cursor === undefined) return undefined
    }
  } else {
    return undefined
  }
  for (let i = 1; i < tokens.length; i++) {
    if (cursor === null || cursor === undefined) return undefined
    const t = tokens[i]
    if (t.kind === "field") {
      cursor = (cursor as Record<string, unknown>)[t.name]
    } else if (t.kind === "key") {
      cursor = (cursor as Record<string, unknown>)[t.name]
    } else if (t.kind === "index") {
      if (Array.isArray(cursor)) cursor = cursor[t.index]
      else return undefined
    }
  }
  return cursor
}

type Token =
  | { kind: "ident"; name: string }
  | { kind: "node"; id: string }
  | { kind: "field"; name: string }
  | { kind: "key"; name: string }
  | { kind: "index"; index: number }

export function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  // First — head: $node['id'] or $ident
  if (expr.startsWith("$node")) {
    i = 5
    // expect '['
    while (expr[i] === " ") i++
    if (expr[i] !== "[") return []
    i++
    while (expr[i] === " ") i++
    const quote = expr[i]
    if (quote !== "'" && quote !== '"') return []
    i++
    const end = expr.indexOf(quote, i)
    if (end < 0) return []
    const id = expr.slice(i, end)
    i = end + 1
    while (expr[i] === " ") i++
    if (expr[i] !== "]") return []
    i++
    tokens.push({ kind: "node", id })
  } else {
    const m = /^\$[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i))
    if (!m) return []
    tokens.push({ kind: "ident", name: m[0] })
    i += m[0].length
  }
  // Tail accessors
  while (i < expr.length) {
    const ch = expr[i]
    if (ch === ".") {
      i++
      const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(expr.slice(i))
      if (!m) return []
      tokens.push({ kind: "field", name: m[0] })
      i += m[0].length
    } else if (ch === "[") {
      i++
      while (expr[i] === " ") i++
      const quote = expr[i]
      if (quote === "'" || quote === '"') {
        i++
        const end = expr.indexOf(quote, i)
        if (end < 0) return []
        tokens.push({ kind: "key", name: expr.slice(i, end) })
        i = end + 1
      } else {
        const m = /^\d+/.exec(expr.slice(i))
        if (!m) return []
        tokens.push({ kind: "index", index: parseInt(m[0], 10) })
        i += m[0].length
      }
      while (expr[i] === " ") i++
      if (expr[i] !== "]") return []
      i++
    } else if (ch === " ") {
      i++
    } else {
      return []
    }
  }
  return tokens
}
