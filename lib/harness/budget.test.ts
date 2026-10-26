import {
  DEFAULT_HARNESS_BUDGET,
  addSpend,
  canAfford,
  checkBudget,
  effectiveK,
  emptyLedger,
  estimateRun,
  normalizeBudget,
  scheduledWork,
} from "./budget"

describe("normalizeBudget", () => {
  it("fills defaults and clamps into range", () => {
    expect(normalizeBudget(undefined)).toEqual(DEFAULT_HARNESS_BUDGET)
    const b = normalizeBudget({
      maxIterations: 99,
      maxCostUsd: -5,
      maxTokens: Number.NaN,
      maxParallelRuns: 2.6,
    })
    expect(b.maxIterations).toBe(4)
    expect(b.maxCostUsd).toBe(0.05)
    expect(b.maxTokens).toBe(DEFAULT_HARNESS_BUDGET.maxTokens)
    expect(b.maxParallelRuns).toBe(3)
  })
})

describe("effectiveK", () => {
  it("is bounded by maxIterations and by half the candidate budget", () => {
    const budget = normalizeBudget({ maxIterations: 4, maxCandidates: 4 })
    expect(effectiveK(3, budget)).toBe(2)
    expect(effectiveK(0, budget)).toBe(1)
    expect(effectiveK(Number.NaN, budget)).toBe(1)
    expect(effectiveK(4, normalizeBudget({ maxIterations: 4, maxCandidates: 8 }))).toBe(4)
  })
})

describe("scheduledWork", () => {
  it.each([1, 2, 4])("schedules R = 4k rollouts and P = 3k editor sessions for k=%i", (k) => {
    for (const mode of ["parallel", "sequential"] as const) {
      expect(scheduledWork(mode, k)).toEqual({
        rollouts: 4 * k,
        editorSessions: 3 * k,
        judgeCalls: 2,
        candidates: 2 * k,
      })
    }
  })
})

describe("estimateRun", () => {
  it("prices a run from unit costs and flags the dimensions it exceeds", () => {
    const budget = normalizeBudget({ maxCostUsd: 1, maxParallelRuns: 2 })
    const estimate = estimateRun("parallel", 2, budget, {
      rolloutUsd: 0.1,
      sessionUsd: 0.05,
      rolloutTokens: 1_000,
      sessionTokens: 500,
      rolloutMs: 60_000,
    })
    expect(estimate.costUsd).toBeCloseTo(8 * 0.1 + 8 * 0.05)
    expect(estimate.tokens).toBe(8 * 1_000 + 8 * 500)
    expect(estimate.modelCalls).toBe(8)
    expect(estimate.wallTimeMs).toBe((1 + 2 + 1) * 60_000)
    expect(estimate.exceeds).toEqual(["maxCostUsd"])
  })

  it("checks only call counts without unit figures", () => {
    const estimate = estimateRun("sequential", 4, normalizeBudget({ maxModelCalls: 4 }), {})
    expect(estimate).not.toHaveProperty("costUsd")
    expect(estimate.exceeds).toEqual(["maxModelCalls"])
  })

  it("runs sequential rounds one after another", () => {
    const estimate = estimateRun("sequential", 2, normalizeBudget({ maxParallelRuns: 4 }), {
      rolloutMs: 1,
    })
    expect(estimate.wallTimeMs).toBe(1 + 6)
  })
})

describe("ledger", () => {
  it("accumulates spend and tracks the worst cost per step kind", () => {
    let ledger = emptyLedger(0)
    ledger = addSpend(ledger, "rollout", {
      costUsd: 0.2,
      inputTokens: 10,
      outputTokens: 5,
      modelCalls: 7,
    })
    ledger = addSpend(ledger, "rollout", {
      costUsd: 0.1,
      inputTokens: 10,
      outputTokens: 5,
      modelCalls: 7,
    })
    ledger = addSpend(ledger, "propose", {
      costUsd: 0.05,
      inputTokens: 1,
      outputTokens: 1,
      modelCalls: 1,
    })
    expect(ledger).toMatchObject({
      rollouts: 2,
      sessions: 1,
      modelCalls: 1,
      inputTokens: 21,
      outputTokens: 11,
      costUnknown: false,
      maxObservedCostUsd: { rollout: 0.2, propose: 0.05 },
    })
    expect(ledger.costUsd).toBeCloseTo(0.35)
    const unpriced = addSpend(ledger, "compose", { inputTokens: 1, outputTokens: 1, modelCalls: 1 })
    expect(unpriced.costUnknown).toBe(true)
    expect(unpriced.costUsd).toBeCloseTo(0.35)
  })

  it("reports the first ceiling crossed", () => {
    const budget = normalizeBudget({
      maxCostUsd: 1,
      maxTokens: 50_000,
      maxModelCalls: 4,
      maxWallTimeMs: 60_000,
    })
    expect(checkBudget(emptyLedger(0), budget, 10)).toEqual({ ok: true })
    expect(checkBudget({ ...emptyLedger(0), costUsd: 2 }, budget, 10)).toMatchObject({
      dimension: "maxCostUsd",
    })
    expect(checkBudget({ ...emptyLedger(0), inputTokens: 60_000 }, budget, 10)).toMatchObject({
      dimension: "maxTokens",
    })
    expect(checkBudget({ ...emptyLedger(0), modelCalls: 5 }, budget, 10)).toMatchObject({
      dimension: "maxModelCalls",
    })
    expect(checkBudget(emptyLedger(0), budget, 70_000)).toMatchObject({
      dimension: "maxWallTimeMs",
    })
  })

  it("reserves the worst observed cost before the next step", () => {
    const budget = normalizeBudget({ maxCostUsd: 1, maxModelCalls: 4 })
    const ledger = { ...emptyLedger(0), costUsd: 0.7, maxObservedCostUsd: { rollout: 0.4 } }
    expect(canAfford(ledger, budget, "rollout", 1, { modelCalls: 0 })).toMatchObject({
      ok: false,
      dimension: "maxCostUsd",
    })
    expect(canAfford(ledger, budget, "propose", 1, { costUsd: 0.2, modelCalls: 1 })).toEqual({
      ok: true,
    })
    expect(
      canAfford({ ...ledger, modelCalls: 4 }, budget, "propose", 1, { modelCalls: 1 })
    ).toMatchObject({
      dimension: "maxModelCalls",
    })
    expect(
      canAfford(ledger, normalizeBudget({ maxTokens: 50_000 }), "propose", 1, {
        modelCalls: 1,
        tokens: 60_000,
      })
    ).toMatchObject({ dimension: "maxTokens" })
  })
})
