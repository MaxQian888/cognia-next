import {
  MODELS_DEV_STALE_MS,
  getModelsDevCatalog,
  isModelsDevCatalogStale,
  saveModelsDevCatalog,
  setModelsDevCatalogDb,
  type ModelsDevCatalogDb,
} from "./models-dev-catalog-db"

function makeFakeDb(): jest.Mocked<ModelsDevCatalogDb> {
  return {
    getModelsDevCatalog: jest.fn().mockResolvedValue(undefined),
    saveModelsDevCatalog: jest.fn().mockResolvedValue({
      id: "singleton",
      fetchedAt: 0,
      source: "remote",
      providers: {},
    } as never),
    isModelsDevCatalogStale: jest.fn().mockResolvedValue(true),
  }
}

describe("models-dev-catalog-db seam", () => {
  it("exposes the 7-day stale window constant", () => {
    expect(MODELS_DEV_STALE_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it("throws a helpful error when the db is not wired", async () => {
    // Fresh module instance has a null db; the guard throws synchronously
    // (before returning a promise), so assert on the thrown call, not a rejection.
    jest.resetModules()
    const fresh = await import("./models-dev-catalog-db")
    expect(() => fresh.getModelsDevCatalog()).toThrow(/not wired/)
  })

  it("delegates every method to the wired db", async () => {
    const db = makeFakeDb()
    setModelsDevCatalogDb(db)

    await getModelsDevCatalog()
    expect(db.getModelsDevCatalog).toHaveBeenCalledTimes(1)

    const input = { providers: {}, fetchedAt: 123, source: "bundled" as const }
    await saveModelsDevCatalog(input)
    expect(db.saveModelsDevCatalog).toHaveBeenCalledWith(input)

    await isModelsDevCatalogStale(999, 1000)
    expect(db.isModelsDevCatalogStale).toHaveBeenCalledWith(999, 1000)
  })
})
