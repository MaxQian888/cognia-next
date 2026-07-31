/** @jest-environment jsdom */
// Coverage for the models.dev catalog cache CRUD (Dexie v60). Uses
// fake-indexeddb to exercise the real Dexie query path in-memory.

import "fake-indexeddb/auto"
import {
  getModelsDevCatalog,
  saveModelsDevCatalog,
  isModelsDevCatalogStale,
  MODELS_DEV_STALE_MS,
} from "./models-dev-catalog"
import type { NormalizedModelsDevCatalog } from "@cognia/provider-core/providers/models-dev"
import { getDb, whenSeeded, __resetDbForTesting } from "./schema"

const sampleProviders: NormalizedModelsDevCatalog = {
  anthropic: {
    modelsDevId: "anthropic",
    name: "Anthropic",
    npm: "@ai-sdk/anthropic",
    models: [
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        contextLength: 200000,
        adapter: "anthropic",
      },
    ],
  },
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

describe("models-dev-catalog cache", () => {
  it("returns undefined when nothing is cached", async () => {
    expect(await getModelsDevCatalog()).toBeUndefined()
  })

  it("saves and reads back the singleton row", async () => {
    const saved = await saveModelsDevCatalog({
      providers: sampleProviders,
      fetchedAt: 1000,
      source: "remote",
    })
    expect(saved.id).toBe("singleton")
    const row = await getModelsDevCatalog()
    expect(row?.fetchedAt).toBe(1000)
    expect(row?.source).toBe("remote")
    expect(row?.providers.anthropic.models[0].id).toBe("claude-sonnet-4-5")
  })

  it("overwrites the singleton on re-save (no duplicates)", async () => {
    await saveModelsDevCatalog({ providers: sampleProviders, fetchedAt: 1000, source: "bundled" })
    await saveModelsDevCatalog({ providers: sampleProviders, fetchedAt: 2000, source: "remote" })
    const count = await getDb().modelsDevCatalog.count()
    expect(count).toBe(1)
    expect((await getModelsDevCatalog())?.fetchedAt).toBe(2000)
  })

  describe("isModelsDevCatalogStale", () => {
    it("is stale when nothing is cached", async () => {
      expect(await isModelsDevCatalogStale()).toBe(true)
    })

    it("is fresh within the threshold and stale beyond it", async () => {
      await saveModelsDevCatalog({
        providers: sampleProviders,
        fetchedAt: 10_000,
        source: "remote",
      })
      expect(await isModelsDevCatalogStale(MODELS_DEV_STALE_MS, 10_000 + 1000)).toBe(false)
      expect(
        await isModelsDevCatalogStale(MODELS_DEV_STALE_MS, 10_000 + MODELS_DEV_STALE_MS + 1)
      ).toBe(true)
    })
  })
})
