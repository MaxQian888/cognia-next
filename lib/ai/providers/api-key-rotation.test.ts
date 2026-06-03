import { selectApiKey, recordKeyUse, type RotationSettings } from "./api-key-rotation"

describe("selectApiKey", () => {
  it("returns the single apiKey when rotation is disabled", () => {
    const s: RotationSettings = {
      apiKey: "solo",
      apiKeys: ["a", "b"],
      apiKeyRotationEnabled: false,
    }
    expect(selectApiKey(s)).toMatchObject({ apiKey: "solo", index: undefined, strategy: "single" })
  })

  it("returns the single apiKey when the pool is empty even if rotation is on", () => {
    const s: RotationSettings = { apiKey: "solo", apiKeys: [], apiKeyRotationEnabled: true }
    expect(selectApiKey(s).apiKey).toBe("solo")
    expect(selectApiKey(s).index).toBeUndefined()
  })

  it("round-robin advances from currentKeyIndex and wraps", () => {
    const base: RotationSettings = {
      apiKeys: ["k0", "k1", "k2"],
      apiKeyRotationEnabled: true,
      apiKeyRotationStrategy: "round-robin",
    }
    expect(selectApiKey({ ...base, currentKeyIndex: -1 })).toMatchObject({ apiKey: "k0", index: 0 })
    expect(selectApiKey({ ...base, currentKeyIndex: 0 })).toMatchObject({ apiKey: "k1", index: 1 })
    expect(selectApiKey({ ...base, currentKeyIndex: 2 })).toMatchObject({ apiKey: "k0", index: 0 })
    // No currentKeyIndex → starts at 0.
    expect(selectApiKey(base)).toMatchObject({ apiKey: "k0", index: 0 })
  })

  it("random uses the injected rng", () => {
    const s: RotationSettings = {
      apiKeys: ["k0", "k1", "k2", "k3"],
      apiKeyRotationEnabled: true,
      apiKeyRotationStrategy: "random",
    }
    expect(selectApiKey(s, { random: () => 0.5 })).toMatchObject({ apiKey: "k2", index: 2 })
    expect(selectApiKey(s, { random: () => 0 })).toMatchObject({ index: 0 })
    // r→1 clamps to the last index, never out of range.
    expect(selectApiKey(s, { random: () => 0.999999 })).toMatchObject({ index: 3 })
  })

  it("least-used picks the key with the lowest usage count", () => {
    const s: RotationSettings = {
      apiKeys: ["k0", "k1", "k2"],
      apiKeyRotationEnabled: true,
      apiKeyRotationStrategy: "least-used",
      apiKeyUsageStats: {
        k0: { usageCount: 5, lastUsed: 1, errorCount: 0 },
        k1: { usageCount: 2, lastUsed: 1, errorCount: 0 },
        // k2 has no stats → counts as 0 → least used.
      },
    }
    expect(selectApiKey(s)).toMatchObject({ apiKey: "k2", index: 2 })
  })

  it("trims whitespace and ignores blank keys in the pool", () => {
    const s: RotationSettings = {
      apiKeys: ["  ", "real ", ""],
      apiKeyRotationEnabled: true,
      apiKeyRotationStrategy: "round-robin",
      currentKeyIndex: -1,
    }
    expect(selectApiKey(s)).toMatchObject({ apiKey: "real", index: 0, poolSize: 1 })
  })
})

describe("recordKeyUse", () => {
  const sel = { apiKey: "k1", index: 1, strategy: "round-robin" as const, poolSize: 3 }

  it("returns null when no pooled key was selected", () => {
    expect(
      recordKeyUse({}, { apiKey: "x", index: undefined, strategy: "single", poolSize: 0 })
    ).toBeNull()
  })

  it("advances currentKeyIndex and bumps usage count + lastUsed", () => {
    const update = recordKeyUse(
      { apiKeyUsageStats: { k1: { usageCount: 4, lastUsed: 1, errorCount: 0 } } },
      sel,
      { now: 12345 }
    )
    expect(update).not.toBeNull()
    expect(update!.currentKeyIndex).toBe(1)
    expect(update!.apiKeyUsageStats.k1).toEqual({ usageCount: 5, lastUsed: 12345, errorCount: 0 })
  })

  it("records an error and increments errorCount", () => {
    const update = recordKeyUse(undefined, sel, { now: 9, error: "429 rate limited" })
    expect(update!.apiKeyUsageStats.k1).toMatchObject({
      usageCount: 1,
      errorCount: 1,
      lastError: "429 rate limited",
    })
  })
})
