import { buildKeyPool, pickStartIndex, recordKeyAttempt, resetRotationState } from "./key-rotation"
import type { SearchProviderSettings } from "./types"

function settings(overrides: Partial<SearchProviderSettings> = {}): SearchProviderSettings {
  return { providerId: "tavily", apiKey: "primary", enabled: true, priority: 1, ...overrides }
}

beforeEach(() => resetRotationState())

describe("buildKeyPool", () => {
  it("returns the single primary key", () => {
    expect(buildKeyPool(settings())).toEqual(["primary"])
  })

  it("combines primary + extra keys, primary first", () => {
    expect(buildKeyPool(settings({ apiKeys: ["b", "c"] }))).toEqual(["primary", "b", "c"])
  })

  it("trims, drops blanks, and dedupes", () => {
    expect(
      buildKeyPool(settings({ apiKey: " primary ", apiKeys: ["primary", "  ", "b", "b"] }))
    ).toEqual(["primary", "b"])
  })

  it("is empty when no usable key", () => {
    expect(buildKeyPool(settings({ apiKey: "", apiKeys: ["  "] }))).toEqual([])
  })
})

describe("pickStartIndex", () => {
  it("returns 0 for empty or single-key pools", () => {
    expect(pickStartIndex("tavily", [], settings({ apiKeyRotationEnabled: true }))).toBe(0)
    expect(pickStartIndex("tavily", ["a"], settings({ apiKeyRotationEnabled: true }))).toBe(0)
  })

  it("returns 0 (primary) when rotation is disabled", () => {
    const pool = ["a", "b", "c"]
    expect(pickStartIndex("tavily", pool, settings({ apiKeyRotationEnabled: false }))).toBe(0)
    // even after attempts, disabled rotation always starts at the primary key
    recordKeyAttempt("tavily", "a", 0)
    expect(pickStartIndex("tavily", pool, settings({ apiKeyRotationEnabled: false }))).toBe(0)
  })

  it("round-robins across calls using the recorded cursor", () => {
    const pool = ["a", "b", "c"]
    const s = settings({ apiKeyRotationEnabled: true, apiKeyRotationStrategy: "round-robin" })
    expect(pickStartIndex("tavily", pool, s)).toBe(0)
    recordKeyAttempt("tavily", "a", 0)
    expect(pickStartIndex("tavily", pool, s)).toBe(1)
    recordKeyAttempt("tavily", "b", 1)
    expect(pickStartIndex("tavily", pool, s)).toBe(2)
    recordKeyAttempt("tavily", "c", 2)
    expect(pickStartIndex("tavily", pool, s)).toBe(0) // wraps
  })

  it("keeps per-provider cursors independent", () => {
    const pool = ["a", "b"]
    const s = settings({ apiKeyRotationEnabled: true })
    recordKeyAttempt("tavily", "a", 0)
    expect(pickStartIndex("tavily", pool, s)).toBe(1)
    // brave has its own untouched cursor
    expect(pickStartIndex("brave", pool, { ...s, providerId: "brave" })).toBe(0)
  })

  it("random strategy uses the injected rng and clamps", () => {
    const pool = ["a", "b", "c"]
    const s = settings({ apiKeyRotationEnabled: true, apiKeyRotationStrategy: "random" })
    expect(pickStartIndex("tavily", pool, s, { random: () => 0 })).toBe(0)
    expect(pickStartIndex("tavily", pool, s, { random: () => 0.5 })).toBe(1)
    expect(pickStartIndex("tavily", pool, s, { random: () => 0.999 })).toBe(2)
  })

  it("least-used strategy prefers the key with the fewest attempts", () => {
    const pool = ["a", "b", "c"]
    const s = settings({ apiKeyRotationEnabled: true, apiKeyRotationStrategy: "least-used" })
    recordKeyAttempt("tavily", "a", 0)
    recordKeyAttempt("tavily", "a", 0)
    recordKeyAttempt("tavily", "b", 1)
    // c has 0 attempts → chosen
    expect(pickStartIndex("tavily", pool, s)).toBe(2)
  })
})
