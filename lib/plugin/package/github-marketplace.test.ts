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
    expect(catalog.id).toBe("acme/store")
    expect(catalog.owner).toBe("Acme")
    expect(catalog.catalogPath).toBe("marketplace.json")
    expect(catalog.repoUrl).toBe("https://github.com/acme/store")

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

  it("falls back to .cognia/marketplace.json and reports where it found it", async () => {
    fetchGithubFileMock.mockImplementation(async (_ref: unknown, path: string) =>
      path === ".cognia/marketplace.json" ? CATALOG : null
    )
    const catalog = await fetchMarketplaceCatalog("acme/store")
    expect(catalog.entries).toHaveLength(2)
    expect(catalog.catalogPath).toBe(".cognia/marketplace.json")
  })

  it("carries a pinned ref into the id and the repo URL", async () => {
    fetchGithubFileMock.mockImplementation(async (_ref: unknown, path: string) =>
      path === "marketplace.json" ? CATALOG : null
    )
    const catalog = await fetchMarketplaceCatalog("acme/store@next")
    expect(catalog.id).toBe("acme/store@next")
    expect(catalog.repoUrl).toBe("https://github.com/acme/store/tree/next")
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

  it("falls back to owner/repo when the catalog names nobody", async () => {
    fetchGithubFileMock.mockResolvedValue(
      JSON.stringify({ name: "   ", owner: {}, plugins: [{ name: "Alpha", source: "./" }] })
    )
    const catalog = await fetchMarketplaceCatalog("acme/store")
    expect(catalog.name).toBe("acme/store")
    expect(catalog.owner).toBeUndefined()
    // A plugin at the repo root has no subdir to point the installer at.
    expect(catalog.entries[0].github.subdir).toBeUndefined()
    expect(catalog.entries[0].author).toBeUndefined()
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

  it("attributes every outcome to its source, successes included", async () => {
    fetchGithubFileMock.mockImplementation(async (ref: { repo: string }, path: string) => {
      if (ref.repo === "good" && path === "marketplace.json") return CATALOG
      return null
    })
    const { results } = await fetchAllSourceEntries(["acme/good", "acme/bad"])
    // Attribution is what lets a caller clear a source's stale error once it
    // starts succeeding again — `errors` alone can only ever say what failed.
    expect(results).toHaveLength(2)
    const good = results.find((r) => r.repoRef === "acme/good")
    expect(good?.ok).toBe(true)
    expect(good?.ok === true && good.catalog.entries).toHaveLength(2)
    expect(results.find((r) => r.repoRef === "acme/bad")?.ok).toBe(false)
  })

  it("stringifies a non-Error rejection rather than reporting undefined", async () => {
    fetchGithubFileMock.mockRejectedValue("network down")
    const { errors } = await fetchAllSourceEntries(["acme/x"])
    expect(errors).toEqual([{ repoRef: "acme/x", message: "network down" }])
  })
})
