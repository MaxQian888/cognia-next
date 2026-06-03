import { resolveModelPriceUsdPer1M } from "./model-pricing"

describe("resolveModelPriceUsdPer1M", () => {
  it("returns undefined for an unknown provider:model with no overrides", () => {
    expect(resolveModelPriceUsdPer1M("nope", "ghost-model")).toBeUndefined()
  })

  it("blends input + output rates from custom model metadata", () => {
    const price = resolveModelPriceUsdPer1M("acme", "m1", {
      customProviders: [
        {
          id: "acme",
          customModelMetadata: { m1: { pricing: { promptPer1M: 2, completionPer1M: 6 } } },
        },
      ],
    })
    expect(price).toBe(4)
  })

  it("prefers custom metadata over discovered pricing", () => {
    const price = resolveModelPriceUsdPer1M("acme", "m1", {
      providerSettings: {
        acme: {
          discoveredModels: [{ id: "m1", pricing: { promptPer1M: 10, completionPer1M: 10 } }],
        },
      },
      customProviders: [
        {
          id: "acme",
          customModelMetadata: { m1: { pricing: { promptPer1M: 1, completionPer1M: 1 } } },
        },
      ],
    })
    expect(price).toBe(1)
  })

  it("falls back to discovered pricing when no custom override", () => {
    const price = resolveModelPriceUsdPer1M("acme", "m1", {
      providerSettings: {
        acme: { discoveredModels: [{ id: "m1", pricing: { promptPer1M: 3, completionPer1M: 3 } }] },
      },
    })
    expect(price).toBe(3)
  })

  it("handles input-only pricing by reusing it for both sides", () => {
    const price = resolveModelPriceUsdPer1M("acme", "m1", {
      customProviders: [
        { id: "acme", customModelMetadata: { m1: { pricing: { promptPer1M: 5 } } } },
      ],
    })
    expect(price).toBe(5)
  })
})
