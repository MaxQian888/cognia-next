import { estimateCallCostUsd, resolveModelPriceUsdPer1M } from "./model-pricing"

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

describe("estimateCallCostUsd", () => {
  const settings = {
    customProviders: [
      {
        id: "acme",
        customModelMetadata: { m1: { pricing: { promptPer1M: 2, completionPer1M: 6 } } },
      },
    ],
  }

  it("prices the actual token mix with split rates", () => {
    const cost = estimateCallCostUsd({
      providerId: "acme",
      modelId: "m1",
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      settings,
    })
    // 1M * $2/1M + 0.5M * $6/1M = 2 + 3
    expect(cost).toBe(5)
  })

  it("returns undefined for an unknown model", () => {
    expect(
      estimateCallCostUsd({
        providerId: "nope",
        modelId: "ghost",
        inputTokens: 100,
        outputTokens: 100,
      })
    ).toBeUndefined()
  })

  it("uses catalog pricing when no overrides are provided", () => {
    // gemini-2.5-flash ships in the built-in catalog with split pricing.
    const cost = estimateCallCostUsd({
      providerId: "google",
      modelId: "gemini-2.5-flash",
      inputTokens: 1_000_000,
      outputTokens: 0,
    })
    expect(typeof cost).toBe("number")
    expect(cost).toBeGreaterThan(0)
  })

  it("treats a missing side as zero (lower-bound estimate)", () => {
    const cost = estimateCallCostUsd({
      providerId: "acme",
      modelId: "m1",
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      settings: {
        customProviders: [
          { id: "acme", customModelMetadata: { m1: { pricing: { promptPer1M: 2 } } } },
        ],
      },
    })
    expect(cost).toBe(2)
  })

  it("clamps negative token counts to zero", () => {
    const cost = estimateCallCostUsd({
      providerId: "acme",
      modelId: "m1",
      inputTokens: -5,
      outputTokens: -5,
      settings,
    })
    expect(cost).toBe(0)
  })

  it("returns undefined when pricing exists but has no numeric rates", () => {
    const cost = estimateCallCostUsd({
      providerId: "acme",
      modelId: "m1",
      inputTokens: 10,
      outputTokens: 10,
      settings: {
        customProviders: [{ id: "acme", customModelMetadata: { m1: { pricing: {} } } }],
      },
    })
    expect(cost).toBeUndefined()
  })
})
