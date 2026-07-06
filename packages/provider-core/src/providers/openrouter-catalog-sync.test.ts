// Coverage for the OpenRouter live-catalog sync orchestration. Network + cache
// dependencies are injected through seams (the runtime proxyFetch adapter + the
// catalog DB), so the package stays independent from the host's Dexie + bundler.

const proxyFetchMock = jest.fn()
import {
  OPENROUTER_CATALOG_STALE_MS,
  setOpenRouterCatalogDb,
  type OpenRouterCatalogDb,
  type OpenRouterCatalogRow,
} from "./openrouter-catalog-db"
import {
  syncOpenRouterCatalog,
  refreshOpenRouterCatalogIfStale,
  getCachedOpenRouterCatalog,
  getCachedOpenRouterCatalogModels,
  primeOpenRouterCatalogCache,
  __resetOpenRouterCatalogCacheForTesting,
} from "./openrouter-catalog-sync"
import type { OpenRouterModelsResponse } from "@cognia/provider-types/openrouter"
import {
  resetProviderCoreRuntimeAdaptersForTesting,
  setProviderCoreRuntimeAdapters,
} from "./runtime-adapters"

jest.setTimeout(30_000)

const liveModels: OpenRouterModelsResponse = {
  data: [
    {
      id: "anthropic/claude-sonnet-4.5",
      name: "Anthropic: Claude Sonnet 4.5",
      context_length: 200000,
      pricing: { prompt: "0.000003", completion: "0.000015" },
      top_provider: { max_completion_tokens: 64000 },
      architecture: { modality: "text+image", tokenizer: "Claude" },
    },
    {
      id: "openai/gpt-5",
      name: "OpenAI: GPT-5",
      context_length: 400000,
      pricing: { prompt: "0.000002", completion: "0.00001" },
      architecture: { modality: "text", tokenizer: "GPT" },
    },
  ],
}

let storedRow: OpenRouterCatalogRow | undefined

const fakeDb: jest.Mocked<OpenRouterCatalogDb> = {
  getOpenRouterCatalog: jest.fn(async () => storedRow),
  saveOpenRouterCatalog: jest.fn(async (input) => {
    storedRow = {
      id: "singleton",
      fetchedAt: input.fetchedAt,
      source: "remote",
      models: input.models,
    }
    return storedRow
  }),
  isOpenRouterCatalogStale: jest.fn(
    async (maxAgeMs = OPENROUTER_CATALOG_STALE_MS, now = Date.now()) => {
      if (!storedRow) return true
      return now - storedRow.fetchedAt > maxAgeMs
    }
  ),
}

function mockOk(payload: unknown) {
  proxyFetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  })
}

beforeEach(() => {
  storedRow = undefined
  __resetOpenRouterCatalogCacheForTesting()
  proxyFetchMock.mockReset()
  fakeDb.getOpenRouterCatalog.mockClear()
  fakeDb.saveOpenRouterCatalog.mockClear()
  fakeDb.isOpenRouterCatalogStale.mockClear()
  setOpenRouterCatalogDb(fakeDb)
  setProviderCoreRuntimeAdapters({ proxyFetch: proxyFetchMock })
})

afterEach(() => {
  resetProviderCoreRuntimeAdaptersForTesting()
})

describe("syncOpenRouterCatalog", () => {
  it("fetches, normalizes, persists, and primes the cache", async () => {
    mockOk(liveModels)
    const row = await syncOpenRouterCatalog(5000)
    expect(row.source).toBe("remote")
    expect(row.fetchedAt).toBe(5000)
    expect(row.models).toHaveLength(2)
    const claude = row.models.find((m) => m.id === "anthropic/claude-sonnet-4.5")
    expect(claude?.provider).toBe("anthropic")
    expect(claude?.contextLength).toBe(200000)
    expect(claude?.supportsVision).toBe(true)
    expect(claude?.pricing?.promptPer1M).toBeCloseTo(3)
    // persisted + primed
    expect(storedRow?.models).toHaveLength(2)
    expect(getCachedOpenRouterCatalogModels()).toHaveLength(2)
    expect(getCachedOpenRouterCatalog()?.fetchedAt).toBe(5000)
  })

  it("coalesces concurrent syncs into one network call", async () => {
    mockOk(liveModels)
    await Promise.all([syncOpenRouterCatalog(1), syncOpenRouterCatalog(1)])
    expect(proxyFetchMock).toHaveBeenCalledTimes(1)
  })

  it("throws on a non-ok response", async () => {
    proxyFetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Unavailable",
      json: async () => ({}),
    })
    await expect(syncOpenRouterCatalog()).rejects.toThrow()
  })
})

describe("refreshOpenRouterCatalogIfStale", () => {
  it("syncs on first run (no cached row)", async () => {
    mockOk(liveModels)
    const row = await refreshOpenRouterCatalogIfStale(OPENROUTER_CATALOG_STALE_MS, 10_000)
    expect(row?.source).toBe("remote")
    expect(proxyFetchMock).toHaveBeenCalledTimes(1)
    expect(storedRow?.models).toHaveLength(2)
  })

  it("refreshes when the cached catalog is stale", async () => {
    mockOk(liveModels)
    await syncOpenRouterCatalog(0)
    proxyFetchMock.mockClear()
    mockOk(liveModels)
    await refreshOpenRouterCatalogIfStale(1000, 10_000)
    expect(proxyFetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not refresh when fresh, but primes the cache", async () => {
    mockOk(liveModels)
    await syncOpenRouterCatalog(1000)
    __resetOpenRouterCatalogCacheForTesting()
    proxyFetchMock.mockClear()
    await refreshOpenRouterCatalogIfStale(1_000_000, 1500)
    expect(proxyFetchMock).not.toHaveBeenCalled()
    // primed from the persisted row
    expect(getCachedOpenRouterCatalogModels()).toHaveLength(2)
  })

  it("swallows network errors during background refresh", async () => {
    proxyFetchMock.mockRejectedValue(new Error("offline"))
    await expect(refreshOpenRouterCatalogIfStale(1, 10_000)).resolves.not.toThrow()
    expect(storedRow).toBeUndefined()
  })

  it("returns the cached row when the DB read fails", async () => {
    fakeDb.getOpenRouterCatalog.mockRejectedValueOnce(new Error("locked"))
    primeOpenRouterCatalogCache({ id: "singleton", fetchedAt: 1, source: "remote", models: [] })
    const row = await refreshOpenRouterCatalogIfStale(1000, 2000)
    expect(row?.fetchedAt).toBe(1)
    expect(proxyFetchMock).not.toHaveBeenCalled()
  })
})

describe("getCachedOpenRouterCatalogModels", () => {
  it("returns empty for an unprimed cache", () => {
    primeOpenRouterCatalogCache(null)
    expect(getCachedOpenRouterCatalogModels()).toEqual([])
  })
})
