import {
  DEFAULT_MODEL_MAPPING_REGISTRY,
  DEFAULT_ROUTING_CONFIG,
  type AliasResolutionResult,
  type ModelMapping,
} from "./model-mapping"

describe("DEFAULT_MODEL_MAPPING_REGISTRY", () => {
  it("starts enabled with no mappings", () => {
    expect(DEFAULT_MODEL_MAPPING_REGISTRY).toEqual({ mappings: [], enabled: true })
  })
})

describe("DEFAULT_ROUTING_CONFIG", () => {
  it("keeps balanced strategy and bounded fallback attempts", () => {
    expect(DEFAULT_ROUTING_CONFIG).toEqual({
      strategy: "balanced",
      allowPerRequestOverride: true,
      providerConstraints: [],
      requestTimeoutMs: 30000,
      maxFallbackAttempts: 3,
    })
  })
})

describe("model mapping contracts", () => {
  it("supports retry policies and special fallback chains", () => {
    const mapping: ModelMapping = {
      id: "m1",
      alias: "coding",
      providers: [{ providerId: "openai", modelId: "gpt-4o" }],
      distribution: "priority",
      enabled: true,
      createdAt: 1,
      updatedAt: 2,
      specialFallbacks: {
        contextWindowExceeded: [{ providerId: "google", modelId: "gemini-2.5-pro" }],
      },
      retryPolicy: { "rate-limit": { maxRetries: 2 } },
    }
    const result: AliasResolutionResult = { found: true, entries: mapping.providers, mapping }

    expect(result.mapping?.specialFallbacks?.contextWindowExceeded?.[0].providerId).toBe("google")
    expect(result.mapping?.retryPolicy?.["rate-limit"]?.maxRetries).toBe(2)
  })
})
