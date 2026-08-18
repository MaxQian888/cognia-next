import {
  DEFAULT_CACHE_READ_MULT,
  DEFAULT_CACHE_WRITE_MULT,
  DEFAULT_CACHE_WRITE_5M_MULT,
  DEFAULT_CACHE_WRITE_1H_MULT,
  costFromTokensUsd,
  mergePricingLayers,
  priceTokensForModel,
  resolveModelPricingUsd,
  type CatalogPricingLookup,
  type PricingSettings,
} from "./pricing"
import {
  getModelPricingUSD,
  CURRENCIES,
  MODEL_PRICING,
  MODEL_PRICING_CNY,
} from "@/types/system/usage"
import bundledCatalog from "./model-price-catalog.generated.json"
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

  describe("cache-write TTL split", () => {
    it("prices a 1-hour cache write at 2x base input, not 1.25x", () => {
      // Anthropic bills 5m writes at 1.25x and 1h writes at 2x. Collapsing them
      // under-billed every 1h-cache turn by 37.5% of the correct figure.
      expect(costFromTokensUsd({ cacheCreation1hInputTokens: 1_000_000 }, pricing)).toBeCloseTo(
        3 * DEFAULT_CACHE_WRITE_1H_MULT,
        6
      )
      expect(costFromTokensUsd({ cacheCreation5mInputTokens: 1_000_000 }, pricing)).toBeCloseTo(
        3 * DEFAULT_CACHE_WRITE_5M_MULT,
        6
      )
    })

    it("prices an un-split cache-creation count at the 5-minute rate", () => {
      // 5 minutes is Anthropic's default TTL, so an untagged count bills there.
      expect(costFromTokensUsd({ cacheCreationInputTokens: 1_000_000 }, pricing)).toBeCloseTo(
        costFromTokensUsd({ cacheCreation5mInputTokens: 1_000_000 }, pricing),
        6
      )
    })

    it("sums the split and un-split buckets together", () => {
      const cost = costFromTokensUsd(
        {
          cacheCreationInputTokens: 1_000_000,
          cacheCreation5mInputTokens: 1_000_000,
          cacheCreation1hInputTokens: 1_000_000,
        },
        pricing
      )
      expect(cost).toBeCloseTo(
        3 * DEFAULT_CACHE_WRITE_5M_MULT * 2 + 3 * DEFAULT_CACHE_WRITE_1H_MULT,
        6
      )
    })

    it("derives the 1-hour rate from an explicit cache rate when no base input rate exists", () => {
      const cacheOnly = { cacheCreationPer1M: 5, completionPer1M: 10, currency: "USD" as const }
      expect(costFromTokensUsd({ cacheCreation1hInputTokens: 1_000_000 }, cacheOnly)).toBeCloseTo(
        5 * (DEFAULT_CACHE_WRITE_1H_MULT / DEFAULT_CACHE_WRITE_5M_MULT),
        6
      )
    })

    it("keeps the legacy alias pointing at the 5-minute multiplier", () => {
      expect(DEFAULT_CACHE_WRITE_MULT).toBe(DEFAULT_CACHE_WRITE_5M_MULT)
    })
  })

  describe("prices catalog-fallback models through the unified path", () => {
    // Replaces the coverage that lived on the removed `calculateCost` /
    // `calculateCostFromTokens` helpers. These models exist only in the
    // built-in provider catalog, not the global static tables, so they are the
    // case that proves the bottom pricing layer is still reachable.
    it("prices an OpenCode Go model from the built-in catalog", () => {
      const { cost, known } = priceTokensForModel(
        "opencode-go",
        "kimi-k2.6",
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        { catalog: () => undefined }
      )
      expect(known).toBe(true)
      expect(cost).toBeCloseTo(0.95 + 4, 6)
    })

    it("prices a second catalog-only model", () => {
      const { cost, known } = priceTokensForModel(
        "opencode-go",
        "glm-5.1",
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        { catalog: () => undefined }
      )
      expect(known).toBe(true)
      expect(cost).toBeCloseTo(1.4 + 4.4, 6)
    })

    it("reports an unknown model as unpriced rather than free", () => {
      const { cost, known } = priceTokensForModel(
        "opencode-go",
        "totally-unknown-model",
        { inputTokens: 1_000_000 },
        { catalog: () => undefined }
      )
      expect(known).toBe(false)
      expect(cost).toBe(0)
    })
  })
})

describe("non-token billing units", () => {
  const withUnits: ModelPricing = {
    promptPer1M: 3,
    completionPer1M: 15,
    currency: "USD",
    perRequestUsd: { web_search: 0.01 },
    perPageUsd: 0.002,
    perCharUsd: 0.000_016,
    perContainerHourUsd: 0.05,
    freeContainerHoursPerMonth: 1550,
  }

  it("bills server-tool invocations on top of tokens", () => {
    // Anthropic: web search is $10 per 1,000 searches.
    expect(costFromTokensUsd({ requests: { web_search: 3 } }, withUnits)).toBeCloseTo(0.03, 9)
  })

  it("sums token and unit charges in one call", () => {
    const cost = costFromTokensUsd(
      { inputTokens: 1_000_000, requests: { web_search: 2 } },
      withUnits
    )
    expect(cost).toBeCloseTo(3 + 0.02, 9)
  })

  it("contributes 0 for a server tool with no known rate rather than guessing", () => {
    expect(costFromTokensUsd({ requests: { some_new_tool: 5 } }, withUnits)).toBe(0)
  })

  it("bills pages and characters", () => {
    expect(costFromTokensUsd({ pages: 10 }, withUnits)).toBeCloseTo(0.02, 9)
    expect(costFromTokensUsd({ characters: 100_000 }, withUnits)).toBeCloseTo(1.6, 9)
  })

  it("charges container-hours only beyond the monthly allowance", () => {
    // Fully inside the included allowance.
    expect(costFromTokensUsd({ containerHours: 10 }, withUnits)).toBe(0)
    // Allowance exhausted — every hour is billable.
    expect(
      costFromTokensUsd({ containerHours: 10 }, withUnits, { freeContainerHoursRemaining: 0 })
    ).toBeCloseTo(0.5, 9)
    // Partially consumed allowance bills only the overflow.
    expect(
      costFromTokensUsd({ containerHours: 10 }, withUnits, { freeContainerHoursRemaining: 4 })
    ).toBeCloseTo(0.3, 9)
  })

  it("still bills units when every token rate is zero", () => {
    // A $0-token model that charges per search is real; returning 0 here would
    // hide that spend entirely.
    const freeTokens: ModelPricing = {
      promptPer1M: 0,
      completionPer1M: 0,
      currency: "USD",
      perRequestUsd: { web_search: 0.01 },
    }
    expect(costFromTokensUsd({ requests: { web_search: 4 } }, freeTokens)).toBeCloseTo(0.04, 9)
  })

  it("ignores non-positive and non-finite quantities", () => {
    expect(
      costFromTokensUsd({ requests: { web_search: 0, code_execution: Number.NaN } }, withUnits)
    ).toBe(0)
  })

  it("merges per-tool rates key-by-key across layers", () => {
    const merged = mergePricingLayers([
      { promptPer1M: 3, perRequestUsd: { web_search: 0.02 } },
      { completionPer1M: 15, perRequestUsd: { web_search: 0.01, code_execution: 0.05 } },
    ])
    // A custom override of one tool inherits the other tool's catalog rate.
    expect(merged?.perRequestUsd).toEqual({ web_search: 0.02, code_execution: 0.05 })
  })

  it("converts CNY unit rates but never the free-hour allowance count", () => {
    const rate = CURRENCIES.CNY.rateFromUSD
    const merged = mergePricingLayers([
      {
        currency: "CNY",
        promptPer1M: 7.25,
        perPageUsd: 7.25,
        freeContainerHoursPerMonth: 100,
      },
    ])
    expect(merged?.perPageUsd).toBeCloseTo(7.25 / rate, 9)
    // An allowance is a COUNT — converting it would shrink the included quota.
    expect(merged?.freeContainerHoursPerMonth).toBe(100)
  })
})

describe("bundled LiteLLM-derived floor layer", () => {
  // Derived from the artifact rather than hardcoded: the catalog is
  // regenerated by `pnpm pricing:sync`, so naming a specific model would make
  // these tests churn every refresh. This picks a model the floor knows and the
  // hand-maintained tables do not — precisely the case the floor exists for.
  const floorOnly = (() => {
    for (const [providerId, models] of Object.entries(bundledCatalog.providers)) {
      for (const modelId of Object.keys(models)) {
        if (MODEL_PRICING[modelId] || MODEL_PRICING_CNY[modelId]) continue
        if (getModelPricingUSD(modelId, providerId)) continue
        return { providerId, modelId }
      }
    }
    return null
  })()

  it("has at least one model that only the bundled floor knows", () => {
    // If this ever fails the floor is redundant and the layer should be
    // reconsidered — not silently kept.
    expect(floorOnly).not.toBeNull()
  })

  it("prices a model that only the bundled catalog knows", () => {
    // Without the floor, a model absent from the hand-maintained tables and
    // from an unsynced models.dev catalog prices as "unknown", so a fresh
    // offline install reports real spend as unpriced.
    const { cost, known } = priceTokensForModel(
      floorOnly!.providerId,
      floorOnly!.modelId,
      { inputTokens: 1_000_000 },
      { catalog: emptyCatalog }
    )
    expect(known).toBe(true)
    expect(cost).toBeGreaterThan(0)
  })

  it("resolves a bundled model without a providerId in scope", () => {
    // The chat context popover has only a model id.
    const pricing = resolveModelPricingUsd(undefined, floorOnly!.modelId, {
      catalog: emptyCatalog,
    })
    expect(pricing?.promptPer1M ?? pricing?.completionPer1M).toBeGreaterThan(0)
  })

  it("stays below every higher-authority layer", () => {
    const pricing = resolveModelPricingUsd(floorOnly!.providerId, floorOnly!.modelId, {
      catalog: emptyCatalog,
      settings: {
        customProviders: [
          {
            id: floorOnly!.providerId,
            customModelMetadata: {
              [floorOnly!.modelId]: { pricing: { promptPer1M: 999 } },
            },
          },
        ],
      },
    })
    expect(pricing?.promptPer1M).toBe(999)
  })

  it("still reports a genuinely unknown model as unpriced", () => {
    expect(
      resolveModelPricingUsd("anthropic", "no-such-model-anywhere", { catalog: emptyCatalog })
    ).toBeNull()
  })
})
