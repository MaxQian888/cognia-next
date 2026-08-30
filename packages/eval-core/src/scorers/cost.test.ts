import type { EvalCase, EvalSample } from "../domain/eval"
import { costScorer, makeCostScorer } from "./cost"

function sample(overrides: Partial<EvalSample> = {}): EvalSample {
  return {
    output: "",
    toolCalls: [],
    retrievedChunks: [],
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
    costUsd: 0.05,
    latencyMs: 1200,
    stepCount: 3,
    degraded: false,
    ...overrides,
  }
}

const CASE: EvalCase = {
  id: "c1",
  datasetId: "d1",
  input: "x",
  capability: "chat.cost",
  source: "handwritten",
  createdAt: 0,
  updatedAt: 0,
}

describe("costScorer (measurement-only default)", () => {
  it("reports measurement — never a passing verdict — when no budget is set", async () => {
    const score = await costScorer.score(sample(), CASE)
    // Regression guard: this used to return `passed: true`, which handed every
    // run a free pass and made toolless question/answer datasets report 100%.
    expect(score.status).toBe("measurement")
    expect(score.passed).toBe(false)
    expect(score.value).toBe(1)
    expect(score.metadata).toMatchObject({ costUsd: 0.05, latencyMs: 1200, stepCount: 3 })
  })

  it("is not gating without a budget, and gating with one", () => {
    expect(costScorer.gating).toBe(false)
    expect(makeCostScorer({ maxCostUsd: 1 }).gating).toBe(true)
    expect(makeCostScorer({ maxLatencyMs: 1 }).gating).toBe(true)
    expect(makeCostScorer({ maxSteps: 1 }).gating).toBe(true)
  })
})

describe("makeCostScorer (budgeted)", () => {
  it("passes when all measurements are within budget", async () => {
    const scorer = makeCostScorer({ maxCostUsd: 0.1, maxLatencyMs: 2000, maxSteps: 5 })
    const score = await scorer.score(sample(), CASE)
    expect(score.status).toBe("scored")
    expect(score.passed).toBe(true)
    expect(score.value).toBe(1)
  })

  it("fails and drops below 1 when cost exceeds the budget", async () => {
    const scorer = makeCostScorer({ maxCostUsd: 0.01 })
    const score = await scorer.score(sample({ costUsd: 0.05 }), CASE)
    expect(score.passed).toBe(false)
    expect(score.value).toBeLessThan(1)
  })

  it("fails when step count exceeds the budget", async () => {
    const scorer = makeCostScorer({ maxSteps: 2 })
    const score = await scorer.score(sample({ stepCount: 10 }), CASE)
    expect(score.passed).toBe(false)
  })
})
