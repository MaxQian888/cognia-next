import "fake-indexeddb/auto"
import { renderHook, act, waitFor } from "@testing-library/react"

const syncMock = jest.fn()
const primeMock = jest.fn()
jest.mock("@/lib/ai/providers/openrouter-catalog-sync", () => ({
  syncOpenRouterCatalog: (...a: unknown[]) => syncMock(...a),
  primeOpenRouterCatalogCache: (...a: unknown[]) => primeMock(...a),
}))

import { useOpenRouterCatalog } from "./use-openrouter-catalog"
import { saveOpenRouterCatalog } from "@/lib/db/openrouter-catalog"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import type { ProviderModelDiscoveryEntry } from "@cognia/provider-types/provider"

const models: ProviderModelDiscoveryEntry[] = [
  { id: "anthropic/claude", name: "Claude" },
  { id: "openai/gpt-5", name: "GPT-5" },
]

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  syncMock.mockReset()
  primeMock.mockReset()
  getDb()
  await whenSeeded()
})

describe("useOpenRouterCatalog", () => {
  it("reactively reads the cached row and derives the model count", async () => {
    await saveOpenRouterCatalog({ models, fetchedAt: 1000 })
    const { result } = renderHook(() => useOpenRouterCatalog())
    await waitFor(() => expect(result.current.row).toBeDefined())
    expect(result.current.modelCount).toBe(2)
  })

  it("primes the in-memory cache when the row changes", async () => {
    await saveOpenRouterCatalog({ models, fetchedAt: 1000 })
    renderHook(() => useOpenRouterCatalog())
    await waitFor(() => expect(primeMock).toHaveBeenCalled())
  })

  it("sync() delegates to syncOpenRouterCatalog with the api key", async () => {
    syncMock.mockResolvedValue({})
    const { result } = renderHook(() => useOpenRouterCatalog())
    await act(async () => {
      await result.current.sync("sk-or-test")
    })
    expect(syncMock).toHaveBeenCalledTimes(1)
    expect(syncMock).toHaveBeenCalledWith(expect.any(Number), "sk-or-test")
    expect(result.current.error).toBeNull()
  })

  it("captures sync errors into state", async () => {
    syncMock.mockRejectedValue(new Error("network down"))
    const { result } = renderHook(() => useOpenRouterCatalog())
    await act(async () => {
      await result.current.sync()
    })
    expect(result.current.error).toBe("network down")
  })

  it("stringifies a non-Error rejection", async () => {
    syncMock.mockRejectedValue("boom")
    const { result } = renderHook(() => useOpenRouterCatalog())
    await act(async () => {
      await result.current.sync()
    })
    expect(result.current.error).toBe("boom")
  })

  it("reports a zero model count when nothing is cached", async () => {
    const { result } = renderHook(() => useOpenRouterCatalog())
    await waitFor(() => expect(result.current.row).toBeUndefined())
    expect(result.current.modelCount).toBe(0)
  })
})
