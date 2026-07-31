import {
  filterCatalogSearchDocuments,
  type CatalogSearchDocument,
} from "./model-catalog-search.worker"

const documents: CatalogSearchDocument[] = [
  {
    id: "openai:gpt-test",
    searchText: "gpt test openai gpt-test legacy:gpt-preview",
  },
  {
    id: "anthropic:claude-test",
    searchText: "claude test anthropic claude-test",
  },
]

describe("model catalog worker search", () => {
  it("matches canonical, upstream, provider, and alias text case-insensitively", () => {
    expect(filterCatalogSearchDocuments(documents, "GPT-PREVIEW")).toEqual(["openai:gpt-test"])
    expect(filterCatalogSearchDocuments(documents, "anthropic")).toEqual(["anthropic:claude-test"])
  })

  it("returns every id for a blank query", () => {
    expect(filterCatalogSearchDocuments(documents, "  ")).toEqual([
      "openai:gpt-test",
      "anthropic:claude-test",
    ])
  })

  it("keeps 10,000-document search within the local p95 budget", () => {
    const largeCatalog = Array.from({ length: 10_000 }, (_, index) => ({
      id: `model:${index}`,
      searchText: `model ${index} provider-${index % 80} language tools`,
    }))
    const durations: number[] = []

    for (let run = 0; run < 12; run += 1) {
      const startedAt = performance.now()
      filterCatalogSearchDocuments(largeCatalog, "provider-42 tools")
      durations.push(performance.now() - startedAt)
    }

    durations.sort((left, right) => left - right)
    expect(durations[Math.floor(durations.length * 0.95)]).toBeLessThan(50)
  })
})
