import * as search from "./index"
import * as providers from "./providers"

describe("search barrel", () => {
  it("re-exports symbols from search-service / cache / etc.", () => {
    // Pulling a few representative names from each child module ensures the
    // barrel chain is working end-to-end.
    expect(search.testProviderConnectionClient).toBeDefined()
    expect(typeof search.testProviderConnectionClient).toBe("function")
    expect(search.searchWithTavily).toBeDefined()
    expect(search.extractContentWithTavily).toBeDefined()
    expect(search.getAnswerFromTavily).toBeDefined()
  })

  it("includes provider exports via the providers barrel", () => {
    for (const k of Object.keys(providers)) {
      if (k === "default") continue
      expect(search).toHaveProperty(k)
    }
  })
})
