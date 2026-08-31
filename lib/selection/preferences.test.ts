import {
  migrateSelectionToolbarMode,
  normalizeHostnameRules,
  normalizeSelectionActionLayout,
} from "./preferences"

describe("migrateSelectionToolbarMode", () => {
  it("prefers the new mode and migrates the legacy enabled bit", () => {
    expect(migrateSelectionToolbarMode("manual", false)).toBe("manual")
    expect(migrateSelectionToolbarMode(undefined, true)).toBe("automatic")
    expect(migrateSelectionToolbarMode(undefined, false)).toBe("off")
    expect(migrateSelectionToolbarMode(undefined, undefined)).toBe("off")
  })

  it("fails closed for malformed persisted modes", () => {
    expect(migrateSelectionToolbarMode("always" as never, true)).toBe("automatic")
  })
})

describe("normalizeHostnameRules", () => {
  it("stores only normalized hostname rules", () => {
    expect(
      normalizeHostnameRules([
        "Example.COM",
        "*.Docs.Example.com",
        "https://accounts.example.com/path?token=secret#fragment",
        "example.com",
        "not a host",
        "https://user:pass@example.net/private",
      ])
    ).toEqual(["example.com", "*.docs.example.com", "accounts.example.com", "example.net"])
  })

  it("rejects ports, non-http schemes, blanks, and malformed wildcard rules", () => {
    expect(
      normalizeHostnameRules([
        "",
        "https://example.com:8443",
        "file:///tmp/private",
        "*.not a host",
      ])
    ).toEqual([])
  })
})

describe("normalizeSelectionActionLayout", () => {
  it("deduplicates ids and retains disabled-plugin layout entries", () => {
    expect(
      normalizeSelectionActionLayout({
        ordered: ["copy", "plugin:a", "copy"],
        hidden: ["plugin:b", "plugin:b"],
        pinned: ["plugin:a", "plugin:a"],
      })
    ).toEqual({
      ordered: ["copy", "plugin:a"],
      hidden: ["plugin:b"],
      pinned: ["plugin:a"],
    })
  })

  it("fails closed for malformed persisted layout values", () => {
    expect(normalizeSelectionActionLayout(null)).toEqual({
      ordered: [],
      hidden: [],
      pinned: [],
    })
    expect(normalizeSelectionActionLayout({ ordered: ["copy", "", 42], hidden: "copy" })).toEqual({
      ordered: ["copy"],
      hidden: [],
      pinned: [],
    })
  })
})
