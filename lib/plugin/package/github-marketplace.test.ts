import { fetchMarketplaceCatalog, fetchAllSourceEntries } from "./github-marketplace"

const fetchGithubFileMock = jest.fn()
jest.mock("./github-source", () => ({
  ...jest.requireActual("./github-source"),
  fetchGithubFile: (...a: unknown[]) => fetchGithubFileMock(...a),
}))

const CATALOG = JSON.stringify({
  name: "Acme Plugins",
  owner: { name: "Acme" },
  plugins: [
    { name: "Alpha", source: "./packages/alpha", description: "First", version: "1.0.0" },
    { name: "Beta", source: "packages/beta", id: "acme.beta" },
  ],
})

describe("fetchMarketplaceCatalog", () => {
  beforeEach(() => fetchGithubFileMock.mockReset())

  it("parses the catalog into entries carrying their github origin", async () => {
    fetchGithubFileMock.mockImplementation(async (_ref: unknown, path: string) =>
      path === "marketplace.json" ? CATALOG : null
    )
    const catalog = await fetchMarketplaceCatalog("acme/store")
    expect(catalog.name).toBe("Acme Plugins")
    expect(catalog.entries).toHaveLength(2)

    const alpha = catalog.entries[0]
    expect(alpha.id).toBe("acme/store:Alpha") // no explicit id → synthetic key
    expect(alpha.author).toBe("Acme")
    expect(alpha.github).toEqual({
      owner: "acme",
      repo: "store",
      ref: undefined,
      subdir: "packages/alpha", // leading ./ stripped
    })

    const beta = catalog.entries[1]
    expect(beta.id).toBe("acme.beta") // explicit id honoured
    expect(beta.github.subdir).toBe("packages/beta")
  })

  it("falls back to .cognia/marketplace.json", async () => {
    fetchGithubFileMock.mockImplementation(async (_ref: unknown, path: string) =>
      path === ".cognia/marketplace.json" ? CATALOG : null
    )
    const catalog = await fetchMarketplaceCatalog("acme/store")
    expect(catalog.entries).toHaveLength(2)
  })

  it("throws when no catalog exists", async () => {
    fetchGithubFileMock.mockResolvedValue(null)
    await expect(fetchMarketplaceCatalog("acme/empty")).rejects.toThrow(/no marketplace.json/i)
  })

  it("throws on invalid JSON", async () => {
    fetchGithubFileMock.mockResolvedValue("{not json")
    await expect(fetchMarketplaceCatalog("acme/bad")).rejects.toThrow(/valid JSON/i)
  })

  it("throws when plugins is missing", async () => {
    fetchGithubFileMock.mockResolvedValue(JSON.stringify({ name: "x" }))
    await expect(fetchMarketplaceCatalog("acme/x")).rejects.toThrow(/plugins/i)
  })
})

describe("fetchAllSourceEntries", () => {
  beforeEach(() => fetchGithubFileMock.mockReset())

  it("merges entries and isolates per-source failures", async () => {
    fetchGithubFileMock.mockImplementation(async (ref: { repo: string }, path: string) => {
      if (ref.repo === "good" && path === "marketplace.json") return CATALOG
      return null // "bad" repo → no catalog → error
    })
    const { entries, errors } = await fetchAllSourceEntries(["acme/good", "acme/bad"])
    expect(entries).toHaveLength(2)
    expect(errors).toHaveLength(1)
    expect(errors[0].repoRef).toBe("acme/bad")
  })
})
