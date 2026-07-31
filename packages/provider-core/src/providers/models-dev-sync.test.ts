// Coverage for the models.dev sync orchestration. The package reads network,
// cache, and bundled snapshot dependencies through injected seams so it stays
// independent from the host app's Dexie and bundler graph.

const proxyFetchMock = jest.fn()
import {
  MODELS_DEV_STALE_MS,
  setModelsDevCatalogDb,
  setModelsDevSnapshotLoader,
  type ModelsDevCatalogDb,
  type ModelsDevCatalogRow,
} from "./models-dev-catalog-db"
import {
  syncModelsDevCatalog,
  ensureModelsDevCatalog,
  refreshModelsDevCatalogIfStale,
  getCatalogModelsForProvider,
  getCatalogModelMetadata,
  resolveProviderAdapter,
  setProviderCatalogRepository,
  primeModelsDevCatalogCache,
  __resetModelsDevCatalogCacheForTesting,
} from "./models-dev-sync"
import { InMemoryCatalogRepository } from "./catalog-repository"
import type { ModelsDevApi } from "./models-dev"
import {
  resetProviderCoreRuntimeAdaptersForTesting,
  setProviderCoreRuntimeAdapters,
} from "./runtime-adapters"

jest.setTimeout(30_000)

const liveApi: ModelsDevApi = {
  anthropic: {
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    models: {
      "claude-sonnet-4-5": {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        reasoning: true,
        tool_call: true,
        modalities: { input: ["text", "image"], output: ["text"] },
        limit: { context: 200000, output: 64000 },
        cost: { input: 3, output: 15 },
      },
    },
  },
  "fireworks-ai": {
    name: "Fireworks",
    npm: "@ai-sdk/openai-compatible",
    models: { "fw-1": { id: "fw-1", limit: { context: 1000 } } },
  },
}

const bundledSnapshot: ModelsDevApi = {
  anthropic: {
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    models: { "claude-x": { id: "claude-x", tool_call: true, limit: { context: 100 } } },
  },
}

let storedRow: ModelsDevCatalogRow | undefined

const fakeDb: jest.Mocked<ModelsDevCatalogDb> = {
  getModelsDevCatalog: jest.fn(async () => storedRow),
  saveModelsDevCatalog: jest.fn(async (input) => {
    storedRow = {
      id: "singleton",
      fetchedAt: input.fetchedAt,
      source: input.source,
      providers: input.providers,
    }
    return storedRow
  }),
  isModelsDevCatalogStale: jest.fn(async (maxAgeMs = MODELS_DEV_STALE_MS, now = Date.now()) => {
    if (!storedRow) return true
    return now - storedRow.fetchedAt > maxAgeMs
  }),
}

function mockOk(payload: unknown) {
  proxyFetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  })
}

beforeEach(async () => {
  storedRow = undefined
  __resetModelsDevCatalogCacheForTesting()
  proxyFetchMock.mockReset()
  fakeDb.getModelsDevCatalog.mockClear()
  fakeDb.saveModelsDevCatalog.mockClear()
  fakeDb.isModelsDevCatalogStale.mockClear()
  setModelsDevCatalogDb(fakeDb)
  setProviderCatalogRepository(null)
  setModelsDevSnapshotLoader(async () => bundledSnapshot)
  setProviderCoreRuntimeAdapters({ proxyFetch: proxyFetchMock })
})

afterEach(() => {
  setProviderCatalogRepository(null)
  resetProviderCoreRuntimeAdaptersForTesting()
})

describe("syncModelsDevCatalog", () => {
  it("fetches, normalizes, persists, and primes the cache", async () => {
    mockOk(liveApi)
    const row = await syncModelsDevCatalog(5000)
    expect(row.source).toBe("remote")
    expect(row.fetchedAt).toBe(5000)
    expect(row.providers.anthropic.models[0].id).toBe("claude-sonnet-4-5")
    expect(row.providers.fireworks.modelsDevId).toBe("fireworks-ai")
    // persisted
    expect(storedRow?.source).toBe("remote")
    // primed
    expect(getCatalogModelsForProvider("anthropic")).toHaveLength(1)
  })

  it("coalesces concurrent syncs into one network call", async () => {
    mockOk(liveApi)
    await Promise.all([syncModelsDevCatalog(1), syncModelsDevCatalog(1)])
    expect(proxyFetchMock).toHaveBeenCalledTimes(1)
  })

  it("publishes the validated revision through the shared catalog repository", async () => {
    const repository = new InMemoryCatalogRepository()
    setProviderCatalogRepository(repository)
    mockOk(liveApi)

    await syncModelsDevCatalog(1_775_000_000_000)

    expect(repository.listProviders()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "anthropic", tier: "certified" }),
        expect.objectContaining({ id: "fireworks", tier: "verified" }),
      ])
    )
    expect(repository.resolveOffering("anthropic", "claude-sonnet-4-5")).toBeDefined()
  })

  it("throws on a non-ok response", async () => {
    proxyFetchMock.mockResolvedValue({ ok: false, status: 503, statusText: "Unavailable" })
    await expect(syncModelsDevCatalog()).rejects.toThrow(/503/)
  })

  it("keeps last-known-good when an upstream refresh is empty", async () => {
    mockOk(liveApi)
    const previous = await syncModelsDevCatalog(1000)
    mockOk({})

    await expect(syncModelsDevCatalog(2000)).rejects.toThrow(/empty/)
    expect(storedRow).toEqual(previous)
  })

  it("keeps last-known-good when an upstream refresh shrinks abnormally", async () => {
    mockOk(liveApi)
    const previous = await syncModelsDevCatalog(1000)
    mockOk({ anthropic: liveApi.anthropic })

    await expect(syncModelsDevCatalog(2000)).rejects.toThrow(/shrank/)
    expect(storedRow).toEqual(previous)
  })
})

describe("ensureModelsDevCatalog", () => {
  it("seeds the bundled snapshot on first run", async () => {
    const row = await ensureModelsDevCatalog(1000)
    expect(row.source).toBe("bundled")
    expect(row.providers.anthropic.models[0].id).toBe("claude-x")
    expect(proxyFetchMock).not.toHaveBeenCalled()
  })

  it("returns the existing cached row without reseeding", async () => {
    mockOk(liveApi)
    await syncModelsDevCatalog(2000)
    const row = await ensureModelsDevCatalog(9999)
    expect(row.source).toBe("remote")
    expect(row.fetchedAt).toBe(2000)
  })
})

describe("refreshModelsDevCatalogIfStale", () => {
  it("refreshes when the cached catalog is stale", async () => {
    mockOk(liveApi)
    // Seed a bundled snapshot at t=0, then refresh much later → stale → network.
    await ensureModelsDevCatalog(0)
    await refreshModelsDevCatalogIfStale(1000, 10_000)
    expect(storedRow?.source).toBe("remote")
    expect(proxyFetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not refresh when fresh", async () => {
    await refreshModelsDevCatalogIfStale(1_000_000, 1000)
    expect(proxyFetchMock).not.toHaveBeenCalled()
    expect(storedRow?.source).toBe("bundled")
  })

  it("swallows network errors during background refresh", async () => {
    proxyFetchMock.mockRejectedValue(new Error("offline"))
    await expect(refreshModelsDevCatalogIfStale(1, 10_000)).resolves.toBeUndefined()
    // bundled seed survives the failed refresh
    expect(storedRow?.source).toBe("bundled")
  })
})

describe("synchronous reads", () => {
  it("projects runtime metadata from the shared CatalogRepository first", async () => {
    const repository = new InMemoryCatalogRepository()
    setProviderCatalogRepository(repository)
    mockOk(liveApi)
    await syncModelsDevCatalog(1_775_000_000_000)

    const metadata = getCatalogModelMetadata("anthropic", "claude-sonnet-4-5")
    expect(metadata).toMatchObject({
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      contextLength: 200000,
      maxOutputTokens: 64000,
      supportsTools: true,
      supportsVision: true,
      supportsReasoning: true,
      pricing: {
        promptPer1M: 3,
        completionPer1M: 15,
        currency: "USD",
      },
    })
  })

  it("getCatalogModelMetadata finds a single model", async () => {
    mockOk(liveApi)
    await syncModelsDevCatalog(1)
    expect(getCatalogModelMetadata("anthropic", "claude-sonnet-4-5")?.supportsReasoning).toBe(true)
    expect(getCatalogModelMetadata("anthropic", "missing")).toBeUndefined()
  })

  it("returns empty for an unprimed cache", () => {
    primeModelsDevCatalogCache(null)
    expect(getCatalogModelsForProvider("anthropic")).toEqual([])
  })
})

describe("resolveProviderAdapter", () => {
  it("prefers the static catalog adapter", () => {
    // anthropic has a static adapter in the built-in catalog
    expect(resolveProviderAdapter("anthropic")).toBe("anthropic")
  })

  it("falls back to openai-compatible for unknown providers", () => {
    expect(resolveProviderAdapter("totally-unknown")).toBe("openai-compatible")
  })
})
