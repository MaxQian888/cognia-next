import * as providers from "./index"

describe("search providers barrel", () => {
  it("re-exports each provider's public symbols", () => {
    // Names sampled from across the providers — each must show up so the
    // barrel chain is reachable.
    for (const expected of [
      "searchWithTavily",
      "searchWithPerplexity",
      "searchWithExa",
      "searchWithSearchAPI",
      "searchWithSerpAPI",
      "searchWithSerper",
      "searchWithBing",
      "searchWithGoogle",
      "searchWithGoogleAI",
      "searchWithBrave",
    ]) {
      expect(providers).toHaveProperty(expected)
    }
  })

  it("does not re-export playwright-scraper (intentionally omitted)", () => {
    expect(Object.keys(providers)).not.toContain("searchWithPlaywrightScraper")
  })
})
