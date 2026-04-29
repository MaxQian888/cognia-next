import type { MarketplaceItem, MarketplaceSourceId, FetchSkillContent } from "./marketplace-types"

// Type-only file — verify the shapes resolve cleanly so future renames break
// tests instead of silently shipping. Jest still needs an at-least-one-it
// block to count this as a test suite.

describe("marketplace-types", () => {
  it("accepts a minimal MarketplaceItem with both source ids", () => {
    const sources: MarketplaceSourceId[] = ["registry", "skillsmp"]
    for (const source of sources) {
      const item: MarketplaceItem = {
        id: `${source}:1`,
        source,
        sourceId: "1",
        name: "Hello",
      }
      expect(item.source).toBe(source)
    }
  })

  it("FetchSkillContent only requires `content`", () => {
    const out: FetchSkillContent = { content: "## body" }
    expect(out.content).toBe("## body")
  })
})
