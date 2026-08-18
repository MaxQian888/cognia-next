import {
  effectiveScope,
  kindsForScope,
  kindsToRun,
  parseDateToken,
  parseGlobalSearchQuery,
  removeFilterToken,
  setFilterToken,
} from "./query-parser"

const NOW = new Date(2026, 7, 16, 15, 30).getTime()
const startOf = (y: number, m: number, d: number) => new Date(y, m - 1, d).getTime()

describe("parseGlobalSearchQuery", () => {
  it("returns plain text as needle with no filters", () => {
    const q = parseGlobalSearchQuery("  Hello World ", { now: NOW })
    expect(q.text).toBe("Hello World")
    expect(q.needle).toBe("hello world")
    expect(q.filters).toEqual({})
    expect(q.tokens).toEqual([])
    expect(q.prefixScope).toBeUndefined()
  })

  it("recognises the > and @ prefixes", () => {
    expect(parseGlobalSearchQuery("> new chat").prefixScope).toBe("commands")
    expect(parseGlobalSearchQuery(">new chat").text).toBe("new chat")
    expect(parseGlobalSearchQuery("@alice").prefixScope).toBe("people")
    expect(parseGlobalSearchQuery("@alice").text).toBe("alice")
  })

  it("parses in: as scope or kind, with aliases", () => {
    expect(parseGlobalSearchQuery("in:messages foo").filters.kinds).toEqual(["message"])
    expect(parseGlobalSearchQuery("in:history foo").filters.kinds).toEqual(["message"])
    expect(parseGlobalSearchQuery("in:chats foo").filters.kinds).toEqual(
      expect.arrayContaining(["session", "message"])
    )
    expect(parseGlobalSearchQuery("in:skill foo").filters.kinds).toEqual(["skill"])
    expect(parseGlobalSearchQuery("in:mcp foo").filters.kinds).toEqual(["mcp-server"])
    expect(parseGlobalSearchQuery("in:contact foo").filters.kinds).toEqual(["inbox-contact"])
    expect(parseGlobalSearchQuery("in:contacts foo").filters.kinds).toEqual(["inbox-contact"])
    expect(parseGlobalSearchQuery("in:inbox foo").filters.kinds).toEqual(["inbox-conversation"])
    expect(parseGlobalSearchQuery("in:pages foo").filters.kinds).toEqual(
      expect.arrayContaining(["navigation", "settings"])
    )
  })

  it("intersects repeated in: tokens", () => {
    const q = parseGlobalSearchQuery("in:chats in:messages foo")
    expect(q.filters.kinds).toEqual(["message"])
    expect(parseGlobalSearchQuery("in:skills in:teams x").filters.kinds).toEqual([])
  })

  it("leaves unknown key:value pairs and URLs in the text", () => {
    const q = parseGlobalSearchQuery("in:nowhere http://x.y/z foo:bar", { now: NOW })
    expect(q.text).toBe("in:nowhere http://x.y/z foo:bar")
    expect(q.tokens).toEqual([])
  })

  it("parses from: roles with aliases and dedupes", () => {
    expect(parseGlobalSearchQuery("from:me x").filters.roles).toEqual(["user"])
    expect(parseGlobalSearchQuery("from:ai from:assistant x").filters.roles).toEqual(["assistant"])
    expect(parseGlobalSearchQuery("from:user from:ai x").filters.roles).toEqual([
      "user",
      "assistant",
    ])
    expect(parseGlobalSearchQuery("from:martian x").text).toBe("from:martian x")
  })

  it("parses is:archived and rejects other is: values", () => {
    expect(parseGlobalSearchQuery("is:archived x").filters.archived).toBe(true)
    expect(parseGlobalSearchQuery("is:pinned x").text).toBe("is:pinned x")
  })

  it("parses date bounds and keeps the tightest one", () => {
    const q = parseGlobalSearchQuery("after:2026-08-01 before:2026-08-10 x", { now: NOW })
    expect(q.filters.after).toBe(startOf(2026, 8, 1))
    expect(q.filters.before).toBe(startOf(2026, 8, 10))
    const tight = parseGlobalSearchQuery("after:2026-08-01 since:2026-08-05 x", { now: NOW })
    expect(tight.filters.after).toBe(startOf(2026, 8, 5))
    const before = parseGlobalSearchQuery("before:2026-08-10 until:2026-08-03 x", { now: NOW })
    expect(before.filters.before).toBe(startOf(2026, 8, 3))
    expect(before.tokens.map((t) => t.key)).toEqual(["before", "before"])
  })

  it("parses workspace: and title:", () => {
    expect(parseGlobalSearchQuery("workspace:current x").filters.workspace).toBe("current")
    expect(parseGlobalSearchQuery("ws:all x").filters.workspace).toBe("all")
    expect(parseGlobalSearchQuery("workspace:foo x").text).toBe("workspace:foo x")
    const t = parseGlobalSearchQuery("title:deploy notes")
    expect(t.filters.titleOnly).toBe(true)
    expect(t.text).toBe("deploy notes")
  })

  it("keeps quoted phrases together and strips the quotes", () => {
    const q = parseGlobalSearchQuery('"in:messages" real', { now: NOW })
    expect(q.text).toBe("in:messages real")
    expect(q.tokens).toEqual([])
    expect(parseGlobalSearchQuery('"hello world"').text).toBe("hello world")
  })

  it("ignores a trailing colon and empty values", () => {
    expect(parseGlobalSearchQuery("from: x").text).toBe("from: x")
    expect(parseGlobalSearchQuery(":x").text).toBe(":x")
  })

  it("records tokens with their raw source for chip removal", () => {
    const raw = "foo from:me  in:messages bar"
    const q = parseGlobalSearchQuery(raw)
    expect(q.tokens).toEqual([
      { key: "from", value: "user", source: "from:me" },
      { key: "in", value: "messages", source: "in:messages" },
    ])
    expect(removeFilterToken(raw, q.tokens[0]!)).toBe("foo in:messages bar")
    expect(removeFilterToken(raw, { key: "x", value: "y", source: "nope" })).toBe(raw)
  })
})

describe("parseDateToken", () => {
  it("handles iso, partial iso, relative and named tokens", () => {
    expect(parseDateToken("2026-08-05", NOW)).toBe(startOf(2026, 8, 5))
    expect(parseDateToken("2026-08", NOW)).toBe(startOf(2026, 8, 1))
    expect(parseDateToken("2026", NOW)).toBe(startOf(2026, 1, 1))
    expect(parseDateToken("today", NOW)).toBe(startOf(2026, 8, 16))
    expect(parseDateToken("yesterday", NOW)).toBe(startOf(2026, 8, 15))
    expect(parseDateToken("7d", NOW)).toBe(startOf(2026, 8, 9))
    expect(parseDateToken("1w", NOW)).toBe(startOf(2026, 8, 9))
    expect(parseDateToken("1m", NOW)).toBe(startOf(2026, 8, 16) - 30 * 86_400_000)
    expect(parseDateToken("1y", NOW)).toBe(startOf(2026, 8, 16) - 365 * 86_400_000)
  })

  it("rejects malformed values", () => {
    expect(parseDateToken("", NOW)).toBeNull()
    expect(parseDateToken("2026-13-01", NOW)).toBeNull()
    expect(parseDateToken("2026-02-30", NOW)).toBeNull()
    expect(parseDateToken("soon", NOW)).toBeNull()
    expect(parseDateToken("5x", NOW)).toBeNull()
  })
})

describe("scope helpers", () => {
  it("resolves the effective scope from prefix or tab", () => {
    expect(effectiveScope(parseGlobalSearchQuery(">x"), "chats")).toBe("commands")
    expect(effectiveScope(parseGlobalSearchQuery("x"), "chats")).toBe("chats")
  })

  it("lists kinds per scope", () => {
    expect(kindsForScope("people")).toEqual(["character", "team", "inbox-contact"])
    expect(kindsForScope("all").length).toBeGreaterThan(10)
  })

  it("intersects in: with the tab, falling back to the filter when disjoint", () => {
    expect(kindsToRun(parseGlobalSearchQuery("in:messages x"), "chats")).toEqual(["message"])
    expect(kindsToRun(parseGlobalSearchQuery("in:skills x"), "people")).toEqual(["skill"])
    expect(kindsToRun(parseGlobalSearchQuery("x"), "people")).toEqual([
      "character",
      "team",
      "inbox-contact",
    ])
  })

  it("setFilterToken replaces an existing token for the key", () => {
    expect(setFilterToken("foo from:me", "from", "assistant")).toBe("foo from:assistant")
    expect(setFilterToken("foo", "in", "messages")).toBe("foo in:messages")
    expect(setFilterToken("", "is", "archived")).toBe("is:archived")
  })
})
