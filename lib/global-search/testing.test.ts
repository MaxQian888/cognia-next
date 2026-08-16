import { TEST_NOW, makeProviderInput, makeTestContext, testTranslate } from "./testing"

describe("global-search test fixtures", () => {
  it("builds a context with overrides", () => {
    const ctx = makeTestContext({ scope: "chats", activeSessionId: "s1" })
    expect(ctx.scope).toBe("chats")
    expect(ctx.activeSessionId).toBe("s1")
    expect(ctx.now).toBe(TEST_NOW)
  })

  it("translates keys with inline values", () => {
    expect(testTranslate("a.b")).toBe("a.b")
    expect(testTranslate("a.b", {})).toBe("a.b")
    expect(testTranslate("a.b", { n: 1 })).toBe('a.b:{"n":1}')
  })

  it("parses the raw query into a provider input", () => {
    const input = makeProviderInput("from:me hello", { limit: 3 })
    expect(input.query.needle).toBe("hello")
    expect(input.query.filters.roles).toEqual(["user"])
    expect(input.limit).toBe(3)
    expect(input.signal.aborted).toBe(false)
    const custom = makeProviderInput("x", { query: makeProviderInput("y").query })
    expect(custom.query.needle).toBe("y")
  })
})
