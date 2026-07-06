// The persistence seam's "not wired" guard. Loaded in isolation so `_db` is
// null (the host shim hasn't run) and every accessor surfaces the boot error.

describe("OpenRouterCatalogDb seam (unwired)", () => {
  it("each accessor throws a helpful error until setOpenRouterCatalogDb runs", () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./openrouter-catalog-db") as typeof import("./openrouter-catalog-db")
      expect(() => mod.getOpenRouterCatalog()).toThrow(/not wired/)
      expect(() => mod.saveOpenRouterCatalog({ models: [], fetchedAt: 0 })).toThrow(/not wired/)
      expect(() => mod.isOpenRouterCatalogStale()).toThrow(/not wired/)
    })
  })

  it("accessors delegate to the wired db once set", async () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./openrouter-catalog-db") as typeof import("./openrouter-catalog-db")
      const row = { id: "singleton" as const, fetchedAt: 1, source: "remote" as const, models: [] }
      mod.setOpenRouterCatalogDb({
        getOpenRouterCatalog: async () => row,
        saveOpenRouterCatalog: async () => row,
        isOpenRouterCatalogStale: async () => false,
      })
      return Promise.all([
        expect(mod.getOpenRouterCatalog()).resolves.toBe(row),
        expect(mod.saveOpenRouterCatalog({ models: [], fetchedAt: 1 })).resolves.toBe(row),
        expect(mod.isOpenRouterCatalogStale()).resolves.toBe(false),
      ])
    })
  })
})
