// Coverage for the OpenRouter catalog cache CRUD (Dexie v93). Uses fake-indexeddb
// to exercise the real Dexie query path in-memory.

import "fake-indexeddb/auto"
import {
  getOpenRouterCatalog,
  saveOpenRouterCatalog,
  isOpenRouterCatalogStale,
  OPENROUTER_CATALOG_STALE_MS,
} from "./openrouter-catalog"
import type { ProviderModelDiscoveryEntry } from "@cognia/provider-types/provider"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

const sampleModels: ProviderModelDiscoveryEntry[] = [
  {
    id: "anthropic/claude-sonnet-4.5",
    name: "Anthropic: Claude Sonnet 4.5",
    provider: "anthropic",
    contextLength: 200000,
    supportsVision: true,
    pricing: { promptPer1M: 3, completionPer1M: 15 },
  },
]

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("openrouter-catalog cache", () => {
  it("returns undefined when nothing is cached", async () => {
    expect(await getOpenRouterCatalog()).toBeUndefined()
  })

  it("saves and reads back the singleton row", async () => {
    const saved = await saveOpenRouterCatalog({ models: sampleModels, fetchedAt: 1000 })
    expect(saved.id).toBe("singleton")
    expect(saved.source).toBe("remote")
    const row = await getOpenRouterCatalog()
    expect(row?.fetchedAt).toBe(1000)
    expect(row?.models[0].id).toBe("anthropic/claude-sonnet-4.5")
  })

  it("overwrites the singleton on re-save (no duplicates)", async () => {
    await saveOpenRouterCatalog({ models: sampleModels, fetchedAt: 1000 })
    await saveOpenRouterCatalog({ models: sampleModels, fetchedAt: 2000 })
    expect(await getDb().openrouterCatalog.count()).toBe(1)
    expect((await getOpenRouterCatalog())?.fetchedAt).toBe(2000)
  })

  describe("isOpenRouterCatalogStale", () => {
    it("is stale when nothing is cached", async () => {
      expect(await isOpenRouterCatalogStale()).toBe(true)
    })

    it("is fresh within the threshold and stale beyond it", async () => {
      await saveOpenRouterCatalog({ models: sampleModels, fetchedAt: 10_000 })
      expect(await isOpenRouterCatalogStale(OPENROUTER_CATALOG_STALE_MS, 10_000 + 1000)).toBe(false)
      expect(
        await isOpenRouterCatalogStale(
          OPENROUTER_CATALOG_STALE_MS,
          10_000 + OPENROUTER_CATALOG_STALE_MS + 1
        )
      ).toBe(true)
    })
  })
})
