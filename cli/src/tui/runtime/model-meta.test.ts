import { resolveModelMeta } from "./model-meta"
import type { ModelsDevCatalogRow } from "@/lib/db/models-dev-catalog"

function catalog(providers: ModelsDevCatalogRow["providers"]): () => Promise<ModelsDevCatalogRow> {
  return () => Promise.resolve({ id: "singleton", fetchedAt: 0, source: "bundled", providers })
}

describe("resolveModelMeta", () => {
  it("returns the pattern-table window when no model id is given", async () => {
    const meta = await resolveModelMeta("anthropic", undefined, catalog({}))
    expect(meta.contextWindow).toBe(200_000)
    expect(meta.pricing).toBeUndefined()
  })

  it("uses the catalog contextLength + pricing for the active provider's model", async () => {
    const meta = await resolveModelMeta(
      "deepseek",
      "deepseek-chat",
      catalog({
        deepseek: {
          modelsDevId: "deepseek",
          name: "DeepSeek",
          models: [
            {
              id: "deepseek-chat",
              name: "DeepSeek Chat",
              contextLength: 64_000,
              pricing: { promptPer1M: 0.27, completionPer1M: 1.1 },
            },
          ],
        },
      })
    )
    expect(meta.contextWindow).toBe(64_000)
    expect(meta.pricing).toEqual({ promptPer1M: 0.27, completionPer1M: 1.1 })
  })

  it("falls back to any provider that lists the model id", async () => {
    const meta = await resolveModelMeta(
      "custom-proxy",
      "gpt-4.1",
      catalog({
        openai: {
          modelsDevId: "openai",
          name: "OpenAI",
          models: [{ id: "gpt-4.1", name: "GPT-4.1", contextLength: 1_000_000 }],
        },
      })
    )
    expect(meta.contextWindow).toBe(1_000_000)
  })

  it("falls back to the pattern table when the model is absent from the catalog", async () => {
    const meta = await resolveModelMeta(
      "anthropic",
      "claude-opus-4-8",
      catalog({ anthropic: { modelsDevId: "anthropic", name: "Anthropic", models: [] } })
    )
    // Pattern table: claude-opus-4-(6|7|8) → 1M.
    expect(meta.contextWindow).toBe(1_000_000)
  })

  it("ignores a non-positive catalog contextLength and uses the fallback", async () => {
    const meta = await resolveModelMeta(
      "openai",
      "gpt-4o",
      catalog({
        openai: {
          modelsDevId: "openai",
          name: "OpenAI",
          models: [{ id: "gpt-4o", name: "GPT-4o", contextLength: 0 }],
        },
      })
    )
    // contextLength 0 is unusable → pattern table gpt-4o → 128k.
    expect(meta.contextWindow).toBe(128_000)
  })

  it("degrades to the fallback when the catalog read throws", async () => {
    const meta = await resolveModelMeta("anthropic", "claude-sonnet-4-5", () =>
      Promise.reject(new Error("db unavailable"))
    )
    expect(meta.contextWindow).toBe(200_000)
    expect(meta.pricing).toBeUndefined()
  })

  it("returns the fallback when the catalog row is missing", async () => {
    const meta = await resolveModelMeta("anthropic", "claude-sonnet-4-5", () =>
      Promise.resolve(undefined)
    )
    expect(meta.contextWindow).toBe(200_000)
  })

  it("reads the real Dexie catalog by default without throwing", async () => {
    // No catalog seeded in the test db → graceful fallback, no throw.
    const meta = await resolveModelMeta("anthropic", "claude-sonnet-4-5")
    expect(meta.contextWindow).toBe(200_000)
  })
})
