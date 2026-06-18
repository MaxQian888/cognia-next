// Coverage for the models.dev sync orchestration. Mocks the network layer
// (proxyFetch) + the bundled snapshot import; uses fake-indexeddb for the cache.

import "fake-indexeddb/auto"

const proxyFetchMock = jest.fn()
jest.mock("@/lib/network/proxy-fetch", () => ({
  proxyFetch: (...args: unknown[]) => proxyFetchMock(...args),
}))

// Small bundled snapshot so ensure()/refresh() don't normalize the real ~MB file.
jest.mock("@/lib/ai/providers/models-dev-snapshot.json", () => ({
  anthropic: {
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    models: { "claude-x": { id: "claude-x", tool_call: true, limit: { context: 100 } } },
  },
}))

import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"
import {
  getModelsDevCatalog,
  saveModelsDevCatalog,
  isModelsDevCatalogStale,
} from "@/lib/db/models-dev-catalog"
import { setModelsDevCatalogDb } from "./models-dev-catalog-db"
import {
  syncModelsDevCatalog,
  ensureModelsDevCatalog,
  refreshModelsDevCatalogIfStale,
  getCatalogModelsForProvider,
  getCatalogModelMetadata,
  resolveProviderAdapter,
  primeModelsDevCatalogCache,
  __resetModelsDevCatalogCacheForTesting,
} from "./models-dev-sync"

// The package reads/writes the catalog through an injected seam; wire it to the
// real Dexie-backed store (mirrors the lib/ai/providers/models-dev-sync shim) so
// these tests exercise the same path the app does.
setModelsDevCatalogDb({ getModelsDevCatalog, saveModelsDevCatalog, isModelsDevCatalogStale })
import type { ModelsDevApi } from "./models-dev"

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

function mockOk(payload: unknown) {
  proxyFetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => payload,
  })
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetModelsDevCatalogCacheForTesting()
  proxyFetchMock.mockReset()
  getDb()
  await whenSeeded()
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
    expect((await getModelsDevCatalog())?.source).toBe("remote")
    // primed
    expect(getCatalogModelsForProvider("anthropic")).toHaveLength(1)
  })

  it("coalesces concurrent syncs into one network call", async () => {
    mockOk(liveApi)
    await Promise.all([syncModelsDevCatalog(1), syncModelsDevCatalog(1)])
    expect(proxyFetchMock).toHaveBeenCalledTimes(1)
  })

  it("throws on a non-ok response", async () => {
    proxyFetchMock.mockResolvedValue({ ok: false, status: 503, statusText: "Unavailable" })
    await expect(syncModelsDevCatalog()).rejects.toThrow(/503/)
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
    const row = await getModelsDevCatalog()
    expect(row?.source).toBe("remote")
    expect(proxyFetchMock).toHaveBeenCalledTimes(1)
  })

  it("does not refresh when fresh", async () => {
    await refreshModelsDevCatalogIfStale(1_000_000, 1000)
    expect(proxyFetchMock).not.toHaveBeenCalled()
    expect((await getModelsDevCatalog())?.source).toBe("bundled")
  })

  it("swallows network errors during background refresh", async () => {
    proxyFetchMock.mockRejectedValue(new Error("offline"))
    await expect(refreshModelsDevCatalogIfStale(1, 10_000)).resolves.toBeUndefined()
    // bundled seed survives the failed refresh
    expect((await getModelsDevCatalog())?.source).toBe("bundled")
  })
})

describe("synchronous reads", () => {
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
