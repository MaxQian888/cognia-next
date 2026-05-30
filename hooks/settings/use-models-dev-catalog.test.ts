import "fake-indexeddb/auto"
import { renderHook, act, waitFor } from "@testing-library/react"

const syncMock = jest.fn()
const primeMock = jest.fn()
jest.mock("@/lib/ai/providers/models-dev-sync", () => ({
  syncModelsDevCatalog: (...a: unknown[]) => syncMock(...a),
  primeModelsDevCatalogCache: (...a: unknown[]) => primeMock(...a),
}))

import { useModelsDevCatalog } from "./use-models-dev-catalog"
import { saveModelsDevCatalog } from "@/lib/db/models-dev-catalog"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import type { NormalizedModelsDevCatalog } from "@/lib/ai/providers/models-dev"

const providers: NormalizedModelsDevCatalog = {
  anthropic: {
    modelsDevId: "anthropic",
    name: "Anthropic",
    models: [
      { id: "m1", name: "M1" },
      { id: "m2", name: "M2" },
    ],
  },
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  syncMock.mockReset()
  primeMock.mockReset()
  getDb()
  await whenSeeded()
})

describe("useModelsDevCatalog", () => {
  it("reactively reads the cached row and derives counts", async () => {
    await saveModelsDevCatalog({ providers, fetchedAt: 1000, source: "remote" })
    const { result } = renderHook(() => useModelsDevCatalog())
    await waitFor(() => expect(result.current.row).toBeDefined())
    expect(result.current.providerCount).toBe(1)
    expect(result.current.modelCount).toBe(2)
  })

  it("primes the in-memory cache when the row changes", async () => {
    await saveModelsDevCatalog({ providers, fetchedAt: 1000, source: "remote" })
    renderHook(() => useModelsDevCatalog())
    await waitFor(() => expect(primeMock).toHaveBeenCalled())
  })

  it("sync() delegates to syncModelsDevCatalog", async () => {
    syncMock.mockResolvedValue({})
    const { result } = renderHook(() => useModelsDevCatalog())
    await act(async () => {
      await result.current.sync()
    })
    expect(syncMock).toHaveBeenCalledTimes(1)
    expect(result.current.error).toBeNull()
  })

  it("captures sync errors into state", async () => {
    syncMock.mockRejectedValue(new Error("network down"))
    const { result } = renderHook(() => useModelsDevCatalog())
    await act(async () => {
      await result.current.sync()
    })
    expect(result.current.error).toBe("network down")
  })
})
