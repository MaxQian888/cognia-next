import {
  GLOBAL_SEARCH_SCOPES,
  KIND_PRIORITY,
  KIND_SCOPES,
  kindInScope,
  primaryScopeOf,
  type GlobalSearchKind,
} from "./types"
import enGlobalSearch from "@/i18n/messages/en/globalSearch.json"
import zhGlobalSearch from "@/i18n/messages/zh-CN/globalSearch.json"

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

  /**
   * Four surfaces label a row with `t(`kinds.${item.kind}`)`, which is a
   * DYNAMIC key: `lint:i18n` skips those, and the Jest intl mock answers with
   * the key, so a kind with no catalogue entry renders as the literal string
   * "kinds.git-branch" in production and nothing anywhere says so. This is the
   * only thing that checks.
   */
  it("gives every kind a label in both catalogues", () => {
    const en = (enGlobalSearch as { kinds: Record<string, string> }).kinds
    const zh = (zhGlobalSearch as { kinds: Record<string, string> }).kinds
    const missing = KINDS.filter((kind) => !en[kind] || !zh[kind])
    expect(missing).toEqual([])
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

  it("files IM conversations under chats and IM contacts under people", () => {
    expect(KIND_SCOPES["inbox-conversation"]).toEqual(["chats"])
    expect(KIND_SCOPES["inbox-contact"]).toEqual(["people"])
    expect(kindInScope("inbox-conversation", "library")).toBe(false)
    expect(kindInScope("inbox-contact", "people")).toBe(true)
    // Contacts rank right after conversations, at the tail of the static order.
    expect(KIND_PRIORITY["inbox-contact"]).toBeGreaterThan(KIND_PRIORITY["inbox-conversation"])
  })
})
