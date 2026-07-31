import {
  getOrCreateDispatchBudget,
  getDispatchBudget,
  releaseDispatchBudget,
  isDispatchBudgetExhausted,
  isDispatchBudgetFinite,
  __clearAllDispatchBudgetsForTesting,
} from "./dispatch-budget"

const usage = (total: number) => ({ promptTokens: total, completionTokens: 0, totalTokens: total })

describe("dispatch-budget", () => {
  beforeEach(() => {
    __clearAllDispatchBudgetsForTesting()
  })

  it("creates one shared guard per root and reuses it", () => {
    const a = getOrCreateDispatchBudget("root", 1000)
    const b = getOrCreateDispatchBudget("root", 9999)
    expect(a).toBe(b)
    expect(getDispatchBudget("root")).toBe(a)
  })

  it("accumulates usage across calls on the shared guard", () => {
    const g = getOrCreateDispatchBudget("root", 1000)
    g.add(usage(300))
    g.add(usage(200))
    expect(g.status().used).toBe(500)
  })

  it("reports exhaustion only once the critical threshold (95%) is crossed", () => {
    getOrCreateDispatchBudget("root", 100)
    expect(isDispatchBudgetExhausted("root")).toBe(false)
    getDispatchBudget("root")!.add(usage(96))
    expect(isDispatchBudgetExhausted("root")).toBe(true)
  })

  it("never trips for an unlimited (0) budget", () => {
    getOrCreateDispatchBudget("root", 0)
    getDispatchBudget("root")!.add(usage(1_000_000))
    expect(isDispatchBudgetExhausted("root")).toBe(false)
  })

  it("treats missing root/guard as not exhausted", () => {
    expect(isDispatchBudgetExhausted(undefined)).toBe(false)
    expect(isDispatchBudgetExhausted("never-created")).toBe(false)
  })

  it("releases a guard so a new root starts fresh", () => {
    const g = getOrCreateDispatchBudget("root", 100)
    g.add(usage(50))
    releaseDispatchBudget("root")
    expect(getDispatchBudget("root")).toBeUndefined()
    const g2 = getOrCreateDispatchBudget("root", 100)
    expect(g2.status().used).toBe(0)
  })

  describe("isDispatchBudgetFinite", () => {
    it("is true for a positive limit", () => {
      getOrCreateDispatchBudget("root", 1000)
      expect(isDispatchBudgetFinite("root")).toBe(true)
    })

    it("is false for an unlimited (0) budget", () => {
      getOrCreateDispatchBudget("root", 0)
      expect(isDispatchBudgetFinite("root")).toBe(false)
    })

    it("is false for a negative limit (clamped to unlimited)", () => {
      getOrCreateDispatchBudget("root", -5)
      expect(isDispatchBudgetFinite("root")).toBe(false)
    })

    it("is false for a missing root/guard", () => {
      expect(isDispatchBudgetFinite(undefined)).toBe(false)
      expect(isDispatchBudgetFinite("never-created")).toBe(false)
    })
  })
})
