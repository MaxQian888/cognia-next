import {
  normalizeCustomSearchSource,
  normalizeSearchDomain,
  SEARCH_SOURCES,
} from "./search-constants"

describe("SEARCH_SOURCES", () => {
  it("contains the configured provider and domain sources without DuckDuckGo", () => {
    expect(SEARCH_SOURCES).toHaveLength(7)
    expect(SEARCH_SOURCES.map((source) => source.id)).not.toContain("duckduckgo")
  })

  it("each source has id, name and icon strings", () => {
    for (const source of SEARCH_SOURCES) {
      expect(typeof source.id).toBe("string")
      expect(source.id.length).toBeGreaterThan(0)
      expect(typeof source.name).toBe("string")
      expect(typeof source.icon).toBe("string")
      expect(["provider", "domain"]).toContain(source.kind)
    }
  })

  it("distinguishes provider preferences from hard domain constraints", () => {
    expect(SEARCH_SOURCES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "google", kind: "provider", provider: "google" }),
        expect.objectContaining({ id: "brave", kind: "provider", provider: "brave" }),
        expect.objectContaining({ id: "bing", kind: "provider", provider: "bing" }),
        expect.objectContaining({
          id: "wikipedia",
          kind: "domain",
          domain: "wikipedia.org",
        }),
        expect.objectContaining({ id: "arxiv", kind: "domain", domain: "arxiv.org" }),
        expect.objectContaining({ id: "github", kind: "domain", domain: "github.com" }),
        expect.objectContaining({
          id: "stackoverflow",
          kind: "domain",
          domain: "stackoverflow.com",
        }),
      ])
    )
  })
})

describe("normalizeCustomSearchSource", () => {
  it("normalizes a new custom source domain", () => {
    expect(
      normalizeCustomSearchSource({
        id: "docs",
        name: "Docs",
        domain: "HTTPS://Docs.Example.com/a",
      })
    ).toEqual({ id: "docs", name: "Docs", domain: "docs.example.com" })
  })

  it("upgrades a legacy source when its name is a domain", () => {
    expect(
      normalizeCustomSearchSource({ id: "legacy", name: "docs.example.com", icon: "📘" })
    ).toEqual({ id: "legacy", name: "docs.example.com", icon: "📘", domain: "docs.example.com" })
  })

  it("returns null for a legacy label that cannot be interpreted as a domain", () => {
    expect(normalizeCustomSearchSource({ id: "legacy", name: "My private docs" })).toBeNull()
  })
})

describe("normalizeSearchDomain", () => {
  it("normalizes URLs and rejects unsafe or invalid source values", () => {
    expect(normalizeSearchDomain("https://www.Docs.Example.com/path")).toBe("docs.example.com")
    expect(normalizeSearchDomain("https://alice:secret@example.com")).toBeNull()
    expect(normalizeSearchDomain("javascript:alert(1)")).toBeNull()
    expect(normalizeSearchDomain("internal handbook")).toBeNull()
  })
})
