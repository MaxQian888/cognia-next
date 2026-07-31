import { SEARCH_SOURCES } from "./search-constants"

describe("SEARCH_SOURCES", () => {
  it("contains 8 default sources", () => {
    expect(SEARCH_SOURCES).toHaveLength(8)
  })

  it("each source has id, name and icon strings", () => {
    for (const source of SEARCH_SOURCES) {
      expect(typeof source.id).toBe("string")
      expect(source.id.length).toBeGreaterThan(0)
      expect(typeof source.name).toBe("string")
      expect(typeof source.icon).toBe("string")
    }
  })

  it("includes the well-known core search engines", () => {
    const ids = SEARCH_SOURCES.map((s) => s.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        "google",
        "brave",
        "bing",
        "duckduckgo",
        "wikipedia",
        "arxiv",
        "github",
        "stackoverflow",
      ])
    )
  })
})
