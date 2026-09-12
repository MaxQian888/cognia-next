import { DEFAULT_CONFIG } from "./types"

describe("DEFAULT_CONFIG", () => {
  it("ships positive budgets for every tunable", () => {
    // These mirror the manifest's `defaultConfig`; a zero or NaN here would
    // silently freeze or corrupt every run, so pin the shape.
    expect(DEFAULT_CONFIG.tokenBudget).toBe(120_000)
    expect(DEFAULT_CONFIG.maxSteps).toBe(24)
    expect(DEFAULT_CONFIG.maxBadAttempts).toBe(2)
    expect(DEFAULT_CONFIG.readTopK).toBe(3)
    expect(DEFAULT_CONFIG.searchResultsPerQuery).toBe(6)
    expect(DEFAULT_CONFIG.locale).toBeUndefined()
  })
})
