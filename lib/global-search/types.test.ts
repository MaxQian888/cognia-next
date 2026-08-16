import {
  GLOBAL_SEARCH_SCOPES,
  KIND_PRIORITY,
  KIND_SCOPES,
  kindInScope,
  primaryScopeOf,
  type GlobalSearchKind,
} from "./types"

const KINDS = Object.keys(KIND_SCOPES) as GlobalSearchKind[]

describe("global-search types", () => {
  it("gives every kind at least one scoped tab and a priority", () => {
    for (const kind of KINDS) {
      expect(KIND_SCOPES[kind].length).toBeGreaterThan(0)
      expect(typeof KIND_PRIORITY[kind]).toBe("number")
      for (const scope of KIND_SCOPES[kind]) {
        expect(GLOBAL_SEARCH_SCOPES).toContain(scope)
        expect(scope).not.toBe("all")
      }
    }
  })

  it("keeps priorities unique so group order is deterministic", () => {
    const values = KINDS.map((k) => KIND_PRIORITY[k])
    expect(new Set(values).size).toBe(values.length)
  })

  it("puts every kind in the all scope and only in its declared tabs", () => {
    expect(kindInScope("session", "all")).toBe(true)
    expect(kindInScope("session", "chats")).toBe(true)
    expect(kindInScope("session", "messages")).toBe(false)
    expect(kindInScope("message", "chats")).toBe(true)
    expect(kindInScope("message", "messages")).toBe(true)
    expect(kindInScope("action", "commands")).toBe(true)
    expect(kindInScope("action", "pages")).toBe(false)
  })

  it("names the first declared scope as the primary one", () => {
    expect(primaryScopeOf("message")).toBe("chats")
    expect(primaryScopeOf("workflow")).toBe("library")
    expect(primaryScopeOf("navigation")).toBe("pages")
  })
})
