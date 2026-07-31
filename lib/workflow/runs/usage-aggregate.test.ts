import { aggregateRunUsage, formatCostUsd, formatTokens } from "./usage-aggregate"
import type { WorkflowRunEventRow } from "@/types/workflow/visual"

function usageEvent(stepId: string, ts: number, payload: unknown): WorkflowRunEventRow {
  return { id: `e_${stepId}_${ts}`, runId: "r1", ts, type: "step_usage", stepId, payload }
}

describe("aggregateRunUsage", () => {
  it("returns an empty summary for no usage events", () => {
    const s = aggregateRunUsage([
      { id: "e1", runId: "r1", ts: 1, type: "step_started", stepId: "n1" },
    ])
    expect(s.perStep).toEqual({})
    expect(s.totalTokens).toBe(0)
    expect(s.totalCostUsd).toBeUndefined()
    expect(s.hasUnknownCost).toBe(false)
  })

  it("aggregates tokens and cost across steps", () => {
    const s = aggregateRunUsage([
      usageEvent("n1", 1, { inputTokens: 100, outputTokens: 50, totalTokens: 150, costUsd: 0.01 }),
      usageEvent("n2", 2, { inputTokens: 10, outputTokens: 5, totalTokens: 15, costUsd: 0.002 }),
    ])
    expect(s.totalInputTokens).toBe(110)
    expect(s.totalOutputTokens).toBe(55)
    expect(s.totalTokens).toBe(165)
    expect(s.totalCostUsd).toBeCloseTo(0.012)
    expect(s.hasUnknownCost).toBe(false)
  })

  it("keeps only the latest usage per step (retries overwrite)", () => {
    const s = aggregateRunUsage([
      usageEvent("n1", 1, { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.5 }),
      usageEvent("n1", 2, { inputTokens: 10, outputTokens: 10, totalTokens: 20, costUsd: 0.1 }),
    ])
    expect(s.perStep.n1.totalTokens).toBe(20)
    expect(s.totalCostUsd).toBeCloseTo(0.1)
  })

  it("flags unknown cost when a step reports usage without pricing", () => {
    const s = aggregateRunUsage([
      usageEvent("n1", 1, { inputTokens: 5, outputTokens: 5, totalTokens: 10 }),
      usageEvent("n2", 2, { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0.01 }),
    ])
    expect(s.hasUnknownCost).toBe(true)
    expect(s.totalCostUsd).toBeCloseTo(0.01)
  })

  it("back-fills cost from the model's pricing when the node reported none", () => {
    // gpt-4o is priced; the step carries a modelId but no costUsd (ai-sdk path).
    const s = aggregateRunUsage([
      usageEvent("n1", 1, {
        inputTokens: 10_000,
        outputTokens: 5_000,
        totalTokens: 15_000,
        modelId: "gpt-4o",
      }),
    ])
    expect(s.totalCostUsd).toBeGreaterThan(0)
    expect(s.hasUnknownCost).toBe(false)
  })

  it("still flags unknown cost for an unpriced model with no reported cost", () => {
    const s = aggregateRunUsage([
      usageEvent("n1", 1, {
        inputTokens: 5,
        outputTokens: 5,
        totalTokens: 10,
        modelId: "mystery-model-xyz",
      }),
    ])
    expect(s.hasUnknownCost).toBe(true)
    expect(s.totalCostUsd).toBeUndefined()
  })

  it("parses cache tokens and folds them into the back-filled cost", () => {
    // Same model/tokens, with vs without a cache-read tranche. Cache reads are
    // billed at 0.1× input, so the cached run must cost strictly less.
    const base = {
      inputTokens: 20_000,
      outputTokens: 2_000,
      totalTokens: 22_000,
      modelId: "gpt-4o",
    }
    const noCache = aggregateRunUsage([usageEvent("n1", 1, base)])
    const withCache = aggregateRunUsage([
      usageEvent("n1", 1, { ...base, inputTokens: 5_000, cacheReadTokens: 15_000 }),
    ])
    expect(withCache.perStep.n1.cacheReadTokens).toBe(15_000)
    expect(withCache.totalCostUsd).toBeGreaterThan(0)
    expect(withCache.totalCostUsd!).toBeLessThan(noCache.totalCostUsd!)
  })

  it("derives totalTokens when the payload omits it and survives junk payloads", () => {
    const s = aggregateRunUsage([
      usageEvent("n1", 1, { inputTokens: 3, outputTokens: 4 }),
      usageEvent("n2", 2, "garbage"),
      usageEvent("n3", 3, null),
    ])
    expect(s.perStep.n1.totalTokens).toBe(7)
    expect(Object.keys(s.perStep)).toEqual(["n1"])
  })
})

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [950, "950"],
    [1500, "1.5k"],
    [12_340, "12k"],
    [4_200_000, "4.2M"],
    [-1, "—"],
  ])("formats %d as %s", (input, expected) => {
    expect(formatTokens(input)).toBe(expected)
  })
})

describe("formatCostUsd", () => {
  it.each([
    [undefined, "—"],
    [0, "$0"],
    [0.0042, "$0.0042"],
    [0.123, "$0.123"],
    [2.5, "$2.50"],
    [-1, "—"],
  ] as Array<[number | undefined, string]>)("formats %p as %s", (input, expected) => {
    expect(formatCostUsd(input)).toBe(expected)
  })
})
