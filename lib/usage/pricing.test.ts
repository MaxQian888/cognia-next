import {
  DEFAULT_CACHE_READ_MULT,
  DEFAULT_CACHE_WRITE_MULT,
  costFromTokensUsd,
  mergePricingLayers,
  priceTokensForModel,
  resolveModelPricingUsd,
  type CatalogPricingLookup,
  type PricingSettings,
} from "./pricing"
import { getModelPricingUSD } from "@/types/system/usage"
import type { ModelPricing } from "@cognia/provider-types/provider"

// A catalog stub so tests never depend on the synced in-memory catalog.
const emptyCatalog: CatalogPricingLookup = () => undefined

describe("mergePricingLayers", () => {
  it("takes each field from the highest-priority layer that defines it", () => {
    const merged = mergePricingLayers([
      { promptPer1M: 1 }, // custom: only input rate
      { completionPer1M: 9 }, // discovered: only output rate
      { promptPer1M: 99, completionPer1M: 99, cachedInputPer1M: 0.5, cacheCreationPer1M: 2 }, // catalog
    ])
    expect(merged).toMatchObject({
      promptPer1M: 1, // from custom (wins)
      completionPer1M: 9, // from discovered (wins over catalog)
      cachedInputPer1M: 0.5, // only catalog has it
      cacheCreationPer1M: 2,
      currency: "USD",
    })
  })

  it("normalizes a CNY layer to USD before merging", () => {
    const merged = mergePricingLayers([
      { promptPer1M: 7.25, completionPer1M: 14.5, currency: "CNY" },
    ])
    // 7.25 CNY / 7.25 rate = 1 USD; 14.5 / 7.25 = 2 USD
    expect(merged?.promptPer1M).toBeCloseTo(1, 6)
    expect(merged?.completionPer1M).toBeCloseTo(2, 6)
    expect(merged?.currency).toBe("USD")
  })

  it("returns null when no layer carries a base rate", () => {
    expect(mergePricingLayers([undefined, {}, { cachedInputPer1M: 1 }])).toBeNull()
  })

  it("treats a cache-only layer as not providing a base rate", () => {
    // cache-only is still null because there is no prompt/completion anchor
    expect(mergePricingLayers([{ cachedInputPer1M: 0.3 }])).toBeNull()
  })
})

describe("resolveModelPricingUsd", () => {
  it("returns null without a modelId", () => {
    expect(resolveModelPricingUsd("anthropic", undefined, { catalog: emptyCatalog })).toBeNull()
  })

  it("custom metadata pricing wins over discovered and catalog", () => {
    const settings: PricingSettings = {
      customProviders: [
        {
          id: "p",
          customModelMetadata: { m: { pricing: { promptPer1M: 1, completionPer1M: 2 } } },
        },
      ],
      providerSettings: {
        p: { discoveredModels: [{ id: "m", pricing: { promptPer1M: 10, completionPer1M: 20 } }] },
      },
    }
    const catalog: CatalogPricingLookup = () => ({ promptPer1M: 100, completionPer1M: 200 })
    const r = resolveModelPricingUsd("p", "m", { settings, catalog })
    expect(r).toMatchObject({ promptPer1M: 1, completionPer1M: 2 })
  })

  it("inherits catalog cache rates under a custom base-rate override (field merge)", () => {
    const settings: PricingSettings = {
      customProviders: [
        {
          id: "p",
          customModelMetadata: { m: { pricing: { promptPer1M: 1, completionPer1M: 2 } } },
        },
      ],
    }
    const catalog: CatalogPricingLookup = () => ({
      promptPer1M: 100,
      completionPer1M: 200,
      cachedInputPer1M: 0.1,
      cacheCreationPer1M: 1.25,
    })
    const r = resolveModelPricingUsd("p", "m", { settings, catalog })
    expect(r).toMatchObject({
      promptPer1M: 1,
      completionPer1M: 2,
      cachedInputPer1M: 0.1,
      cacheCreationPer1M: 1.25,
    })
  })

  it("discovered pricing wins over catalog", () => {
    const settings: PricingSettings = {
      providerSettings: {
        p: { discoveredModels: [{ id: "m", pricing: { promptPer1M: 5, completionPer1M: 6 } }] },
      },
    }
    const catalog: CatalogPricingLookup = () => ({ promptPer1M: 100, completionPer1M: 200 })
    expect(resolveModelPricingUsd("p", "m", { settings, catalog })).toMatchObject({
      promptPer1M: 5,
      completionPer1M: 6,
    })
  })

  it("falls back to the static MODEL_PRICING table by model id (no provider sources)", () => {
    const base = getModelPricingUSD("claude-sonnet-4-6", "anthropic")
    expect(base).not.toBeNull()
    const r = resolveModelPricingUsd("anthropic", "claude-sonnet-4-6", { catalog: emptyCatalog })
    expect(r?.promptPer1M).toBe(base!.input)
    expect(r?.completionPer1M).toBe(base!.output)
  })

  it("resolves static pricing even without a providerId", () => {
    const base = getModelPricingUSD("claude-sonnet-4-6")
    const r = resolveModelPricingUsd(undefined, "claude-sonnet-4-6", { catalog: emptyCatalog })
    expect(r?.promptPer1M).toBe(base!.input)
  })

  it("returns null for a wholly unknown model", () => {
    expect(
      resolveModelPricingUsd("p", "totally-unknown-model-xyz", { catalog: emptyCatalog })
    ).toBeNull()
  })

  it("converts a CNY-only static-table model to USD", () => {
    // glm-4.7 lives only in MODEL_PRICING_CNY ({ input: 4, output: 16 } CNY).
    const r = resolveModelPricingUsd(undefined, "glm-4.7", { catalog: emptyCatalog })
    expect(r?.promptPer1M).toBeCloseTo(4 / 7.25, 4)
    expect(r?.completionPer1M).toBeCloseTo(16 / 7.25, 4)
  })
})

describe("priceTokensForModel", () => {
  it("reports known:false + cost 0 for an unpriced model", () => {
    const { cost, known } = priceTokensForModel(
      "p",
      "totally-unknown-model-xyz",
      { inputTokens: 1000 },
      { catalog: emptyCatalog }
    )
    expect(cost).toBe(0)
    expect(known).toBe(false)
  })

  it("reports known:true + a positive cost for a priced model", () => {
    const { cost, known } = priceTokensForModel(
      "anthropic",
      "claude-sonnet-4-6",
      { inputTokens: 1_000_000 },
      { catalog: emptyCatalog }
    )
    expect(known).toBe(true)
    expect(cost).toBeGreaterThan(0)
  })
})

describe("costFromTokensUsd", () => {
  const pricing: ModelPricing = { promptPer1M: 3, completionPer1M: 15, currency: "USD" }

  it("returns 0 for null pricing", () => {
    expect(costFromTokensUsd({ inputTokens: 1000 }, null)).toBe(0)
  })

  it("prices base input + output", () => {
    expect(
      costFromTokensUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, pricing)
    ).toBeCloseTo(3 + 15, 6)
  })

  it("uses explicit cache rates when present", () => {
    const withCache: ModelPricing = { ...pricing, cachedInputPer1M: 0.75, cacheCreationPer1M: 6 }
    expect(
      costFromTokensUsd(
        { cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 },
        withCache
      )
    ).toBeCloseTo(0.75 + 6, 6)
  })

  it("falls back to input-rate multipliers when cache rates are absent", () => {
    // read = 3 * 0.1 = 0.3 ; write = 3 * 1.25 = 3.75 (per 1M)
    expect(
      costFromTokensUsd(
        { cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 },
        pricing
      )
    ).toBeCloseTo(3 * DEFAULT_CACHE_READ_MULT + 3 * DEFAULT_CACHE_WRITE_MULT, 6)
  })

  it("returns 0 when all rates are zero", () => {
    expect(
      costFromTokensUsd(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        { promptPer1M: 0, completionPer1M: 0, currency: "USD" }
      )
    ).toBe(0)
  })
})
