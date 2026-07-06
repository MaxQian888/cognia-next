/**
 * @jest-environment node
 */
const ensureCliDbMock = jest.fn().mockResolvedValue({})
jest.mock("../../db/bootstrap", () => ({
  ensureCliDb: (...a: unknown[]) => ensureCliDbMock(...a),
}))
const refreshDefaultMock = jest.fn().mockResolvedValue(null)
jest.mock("@/lib/ai/providers/openrouter-catalog-sync", () => ({
  refreshOpenRouterCatalogIfStale: (...a: unknown[]) => refreshDefaultMock(...a),
}))

import { initOpenRouterCatalog } from "./openrouter-catalog-controller"

beforeEach(() => {
  ensureCliDbMock.mockClear().mockResolvedValue({})
  refreshDefaultMock.mockClear().mockResolvedValue(null)
})

describe("initOpenRouterCatalog", () => {
  it("opens the db then refreshes the catalog, forwarding the api key", async () => {
    const ensureDb = jest.fn().mockResolvedValue(undefined)
    const refresh = jest.fn().mockResolvedValue(null)
    await initOpenRouterCatalog({ apiKey: "sk-or-test", ensureDb, refresh })
    expect(ensureDb).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith(undefined, undefined, "sk-or-test")
    // db must open before the refresh runs
    expect(ensureDb.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0])
  })

  it("swallows a db-open failure without refreshing", async () => {
    const ensureDb = jest.fn().mockRejectedValue(new Error("locked"))
    const refresh = jest.fn().mockResolvedValue(null)
    await expect(initOpenRouterCatalog({ ensureDb, refresh })).resolves.toBeUndefined()
    expect(refresh).not.toHaveBeenCalled()
  })

  it("swallows a refresh failure", async () => {
    const ensureDb = jest.fn().mockResolvedValue(undefined)
    const refresh = jest.fn().mockRejectedValue(new Error("offline"))
    await expect(initOpenRouterCatalog({ ensureDb, refresh })).resolves.toBeUndefined()
    expect(ensureDb).toHaveBeenCalledTimes(1)
  })

  it("falls back to the real refresh default when only ensureDb is injected", async () => {
    // ensureDb rejects, so the (defaulted) real refresh is never invoked — this
    // still exercises the `?? refreshOpenRouterCatalogIfStale` default arm.
    const ensureDb = jest.fn().mockRejectedValue(new Error("no db"))
    await expect(initOpenRouterCatalog({ ensureDb })).resolves.toBeUndefined()
    expect(ensureDb).toHaveBeenCalledTimes(1)
  })

  it("uses the real ensureCliDb + refresh defaults when nothing is injected", async () => {
    await expect(initOpenRouterCatalog()).resolves.toBeUndefined()
    expect(ensureCliDbMock).toHaveBeenCalledTimes(1)
    expect(refreshDefaultMock).toHaveBeenCalledWith(undefined, undefined, undefined)
  })
})
