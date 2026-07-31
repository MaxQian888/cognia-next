import { createPluginBudget, PluginBudgetExceededError } from "./budget"

describe("createPluginBudget", () => {
  it("never exhausts with no caps", () => {
    const b = createPluginBudget()
    b.record({ totalTokens: 1_000_000 })
    expect(b.exhausted()).toBe(false)
    expect(() => b.assertWithin()).not.toThrow()
  })

  it("exhausts once the token cap is reached", () => {
    const b = createPluginBudget({ maxTokens: 100 })
    b.record({ totalTokens: 60 })
    expect(b.exhausted()).toBe(false)
    b.record({ totalTokens: 50 })
    expect(b.exhausted()).toBe(true)
    expect(() => b.assertWithin()).toThrow(PluginBudgetExceededError)
  })

  it("exhausts on the USD cap when a cost is recorded", () => {
    const b = createPluginBudget({ maxBudgetUsd: 1 })
    b.record({ costUsd: 0.5 })
    expect(b.exhausted()).toBe(false)
    b.record({ costUsd: 0.6 })
    expect(b.exhausted()).toBe(true)
  })

  it("reports status with used + caps", () => {
    const b = createPluginBudget({ maxTokens: 100 })
    b.record({ totalTokens: 30 })
    expect(b.status()).toMatchObject({ usedTokens: 30, maxTokens: 100, exhausted: false })
  })

  it("ignores non-positive / missing usage", () => {
    const b = createPluginBudget({ maxTokens: 100 })
    b.record({})
    b.record({ totalTokens: 0 })
    expect(b.status().usedTokens).toBe(0)
  })

  it("the thrown error carries the status", () => {
    const b = createPluginBudget({ maxTokens: 10 })
    b.record({ totalTokens: 20 })
    try {
      b.assertWithin()
      throw new Error("should have thrown")
    } catch (err) {
      expect(err).toBeInstanceOf(PluginBudgetExceededError)
      expect((err as PluginBudgetExceededError).status.usedTokens).toBe(20)
    }
  })
})
