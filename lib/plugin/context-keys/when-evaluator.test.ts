import {
  evaluateWhenExpr,
  parseWhenExpr,
  __resetWhenCacheForTesting,
  type WhenLookup,
} from "./when-evaluator"

/** Flat-map lookup: `chat.active` → keys["chat.active"]. */
function flat(keys: Record<string, boolean>): WhenLookup {
  return (path) => Boolean(keys[path.join(".")])
}

describe("evaluateWhenExpr", () => {
  afterEach(() => __resetWhenCacheForTesting())

  it("returns true for an absent or empty expression (always show)", () => {
    expect(evaluateWhenExpr(undefined, flat({}))).toBe(true)
    expect(evaluateWhenExpr("", flat({}))).toBe(true)
    expect(evaluateWhenExpr("   ", flat({}))).toBe(true)
  })

  it("resolves a single predicate via the lookup", () => {
    expect(evaluateWhenExpr("chat.active", flat({ "chat.active": true }))).toBe(true)
    expect(evaluateWhenExpr("chat.active", flat({ "chat.active": false }))).toBe(false)
  })

  it("treats an unknown predicate as false (item hidden, host still renders)", () => {
    expect(evaluateWhenExpr("nope.missing", flat({}))).toBe(false)
  })

  it("evaluates && with short-circuit semantics", () => {
    expect(evaluateWhenExpr("a && b", flat({ a: true, b: true }))).toBe(true)
    expect(evaluateWhenExpr("a && b", flat({ a: true, b: false }))).toBe(false)
    expect(evaluateWhenExpr("a && b", flat({ a: false, b: true }))).toBe(false)
  })

  it("evaluates || ", () => {
    expect(evaluateWhenExpr("a || b", flat({ a: false, b: true }))).toBe(true)
    expect(evaluateWhenExpr("a || b", flat({ a: false, b: false }))).toBe(false)
  })

  it("evaluates ! negation", () => {
    expect(evaluateWhenExpr("!a", flat({ a: false }))).toBe(true)
    expect(evaluateWhenExpr("!a", flat({ a: true }))).toBe(false)
    expect(evaluateWhenExpr("!!a", flat({ a: true }))).toBe(true)
  })

  it("respects parentheses over default precedence", () => {
    // && binds tighter than || by default.
    expect(evaluateWhenExpr("a || b && c", flat({ a: false, b: true, c: false }))).toBe(false)
    expect(evaluateWhenExpr("(a || b) && c", flat({ a: false, b: true, c: false }))).toBe(false)
    expect(evaluateWhenExpr("(a || b) && c", flat({ a: false, b: true, c: true }))).toBe(true)
  })

  it("handles a realistic compound clause", () => {
    const keys = { "chat.active": true, "chat.streaming": false, "platform.tauri": true }
    expect(evaluateWhenExpr("chat.active && !chat.streaming && platform.tauri", flat(keys))).toBe(
      true
    )
    expect(evaluateWhenExpr("chat.active && chat.streaming", flat(keys))).toBe(false)
  })

  it("throws on a malformed expression", () => {
    expect(() => evaluateWhenExpr("a &&", flat({ a: true }))).toThrow()
    expect(() => evaluateWhenExpr("a # b", flat({ a: true }))).toThrow(/unexpected character/)
    expect(() => evaluateWhenExpr("(a", flat({ a: true }))).toThrow()
  })

  it("memoises the parsed AST across calls", () => {
    // Parse once, then evaluate the cached AST with two different lookups.
    const ast1 = parseWhenExpr("x && y")
    const ast2 = parseWhenExpr("x && y")
    expect(ast1).toBe(ast2)
    expect(evaluateWhenExpr("x && y", flat({ x: true, y: true }))).toBe(true)
    expect(evaluateWhenExpr("x && y", flat({ x: true, y: false }))).toBe(false)
  })

  it("supports nested-path lookups for non-flat state models (tray-style)", () => {
    const snapshot = { chat: { streaming: true }, platform: { os: "windows" } }
    const nested: WhenLookup = (path) => {
      if (path[0] === "platform" && path.length === 2) return snapshot.platform.os === path[1]
      let cur: unknown = snapshot
      for (const seg of path) {
        if (cur == null || typeof cur !== "object") return false
        cur = (cur as Record<string, unknown>)[seg]
      }
      return Boolean(cur)
    }
    expect(evaluateWhenExpr("chat.streaming && platform.windows", nested)).toBe(true)
    expect(evaluateWhenExpr("platform.macos", nested)).toBe(false)
  })
})
