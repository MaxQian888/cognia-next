/**
 * @jest-environment node
 */
import {
  accumulateUsage,
  cacheHitRatio,
  contextComposition,
  contextPercent,
  contextTokens,
  costFromUsage,
  emptySessionTotals,
  formatCost,
  formatFooter,
  formatTokens,
  shortenCwd,
  usagePanelRows,
} from "./usage"
import type { UsageInfo } from "../state/types"

describe("contextTokens", () => {
  it("sums prompt-side tokens including cache", () => {
    expect(
      contextTokens({ inputTokens: 100, cacheReadInputTokens: 50, cacheCreationInputTokens: 10 })
    ).toBe(160)
  })
  it("is 0 for undefined usage", () => {
    expect(contextTokens(undefined)).toBe(0)
  })
})

describe("contextPercent", () => {
  it("computes occupancy against the model context window", () => {
    // Default window is 200k → 20000 tokens = 10%.
    const pct = contextPercent({ inputTokens: 20_000 }, "claude-unknown")
    expect(pct).toBe(10)
  })
  it("clamps to 0..100", () => {
    expect(contextPercent({ inputTokens: 10_000_000 }, undefined)).toBe(100)
    expect(contextPercent(undefined, undefined)).toBe(0)
  })
  it("uses the per-model window override when positive", () => {
    // 100k tokens against a 1M override = 10% (not 50% of the 200k fallback).
    expect(contextPercent({ inputTokens: 100_000 }, "claude-unknown", 1_000_000)).toBe(10)
  })
  it("ignores a non-positive override and falls back to the pattern table", () => {
    expect(contextPercent({ inputTokens: 20_000 }, "claude-unknown", 0)).toBe(10)
  })
})

describe("costFromUsage", () => {
  it("returns 0 without pricing", () => {
    expect(costFromUsage({ inputTokens: 1000 })).toBe(0)
  })
  it("returns 0 when neither prompt nor completion rate is known", () => {
    expect(costFromUsage({ inputTokens: 1000 }, { cachedInputPer1M: 1 })).toBe(0)
  })
  it("prices input + output at the per-1M rates", () => {
    // 1M input @ $3 + 1M output @ $15 = $18.
    expect(
      costFromUsage(
        { inputTokens: 1_000_000, outputTokens: 1_000_000 },
        { promptPer1M: 3, completionPer1M: 15 }
      )
    ).toBeCloseTo(18, 6)
  })
  it("prices cache reads/writes, defaulting to the Anthropic multipliers when unset", () => {
    // No explicit cache-read rate → 0.1× prompt = $0.30 (not the full $3, which
    // used to over-charge cached reads ~10×); cacheCreation 1M @ explicit $3.75.
    expect(
      costFromUsage(
        { cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000 },
        { promptPer1M: 3, completionPer1M: 15, cacheCreationPer1M: 3.75 }
      )
    ).toBeCloseTo(0.3 + 3.75, 6)
    // Dedicated cache-read rate is honored.
    expect(
      costFromUsage(
        { cacheReadInputTokens: 1_000_000 },
        { promptPer1M: 3, completionPer1M: 15, cachedInputPer1M: 0.3 }
      )
    ).toBeCloseTo(0.3, 6)
  })
})

describe("formatTokens", () => {
  it("humanizes magnitudes", () => {
    expect(formatTokens(0)).toBe("0")
    expect(formatTokens(undefined)).toBe("0")
    expect(formatTokens(950)).toBe("950")
    expect(formatTokens(1500)).toBe("1.5k")
    expect(formatTokens(23000)).toBe("23k")
    expect(formatTokens(1_500_000)).toBe("1.5M")
  })
})

describe("formatCost", () => {
  it("formats cost across magnitudes", () => {
    expect(formatCost(0)).toBe("$0.00")
    expect(formatCost(undefined)).toBe("$0.00")
    expect(formatCost(0.0001)).toBe("$0.0001")
    expect(formatCost(0.5)).toBe("$0.500")
    expect(formatCost(2.345)).toBe("$2.35")
  })
})

describe("shortenCwd", () => {
  it("keeps short paths as-is", () => {
    expect(shortenCwd("/a/b")).toBe("/a/b")
  })
  it("keeps the last two segments for long paths", () => {
    expect(shortenCwd("/very/long/nested/path/here/project", 20)).toBe("…/here/project")
  })
  it("ellipsizes a long two-segment path", () => {
    const out = shortenCwd("/" + "a".repeat(50), 20)
    expect(out.startsWith("…")).toBe(true)
  })
})

describe("formatFooter", () => {
  it("assembles the footer view-model", () => {
    const usage: UsageInfo = { inputTokens: 1000, outputTokens: 500, totalCostUsd: 0.02 }
    const footer = formatFooter({
      model: "claude-x",
      provider: "anthropic",
      mode: "default",
      cwd: "/work",
      usage,
    })
    expect(footer).toMatchObject({
      model: "claude-x",
      provider: "anthropic",
      mode: "default",
      tokens: "1.5k",
      cost: "$0.020",
      cwd: "/work",
    })
  })

  it("falls back to 'default' model label when unset", () => {
    expect(formatFooter({ provider: "anthropic", mode: "plan", cwd: "/work" }).model).toBe(
      "default"
    )
  })

  it("sizes the context % against the per-model window override", () => {
    const f = formatFooter({
      model: "claude-unknown",
      provider: "anthropic",
      mode: "default",
      cwd: "/w",
      usage: { inputTokens: 100_000 },
      contextWindow: 1_000_000,
    })
    expect(f.contextPct).toBe(10)
  })
})

describe("usagePanelRows", () => {
  it("produces a labelled row per metric", () => {
    const rows = usagePanelRows(
      {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 2,
        durationMs: 1500,
        totalCostUsd: 0.01,
      },
      undefined
    )
    const labels = rows.map((r) => r.label)
    expect(labels).toEqual([
      "Input",
      "Output",
      "Cache read",
      "Cache write",
      "Cache hit",
      "Context",
      "Cost",
      "Duration",
    ])
    expect(rows.find((r) => r.label === "Duration")?.value).toBe("1.5s")
    // 2 cache-read of (10 input + 2 cache-read) prompt tokens ≈ 17%.
    expect(rows.find((r) => r.label === "Cache hit")?.value).toBe("17%")
  })

  it("shows an em dash for missing duration and tolerates absent usage", () => {
    const rows = usagePanelRows(undefined, undefined)
    expect(rows.find((r) => r.label === "Duration")?.value).toBe("—")
  })

  it("reports context against the per-model window override", () => {
    const rows = usagePanelRows({ inputTokens: 100_000 }, "claude-unknown", undefined, 1_000_000)
    expect(rows.find((r) => r.label === "Context")?.value).toBe("10% of 1.0M")
  })

  it("shows '—' for a zero cost when pricing is unknown, '$0.00' when known-free", () => {
    // No pricing passed → unknown → em dash (not mistaken for free).
    const unknown = usagePanelRows({ inputTokens: 10, totalCostUsd: 0 }, "mystery")
    expect(unknown.find((r) => r.label === "Cost")?.value).toBe("—")
    // Known pricing (even a free $0 model) → an explicit "$0.00".
    const free = usagePanelRows({ inputTokens: 10, totalCostUsd: 0 }, "free-model", undefined, 0, {
      promptPer1M: 0,
      completionPer1M: 0,
    })
    expect(free.find((r) => r.label === "Cost")?.value).toBe("$0.00")
  })

  it("shows cumulative session rows when totals are supplied", () => {
    const totals = {
      costUsd: 0.25,
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 3000,
    }
    const rows = usagePanelRows({ inputTokens: 10 }, "claude-x", totals)
    const labels = rows.map((r) => r.label)
    expect(labels).toContain("Session tokens")
    expect(labels).toContain("Session cost")
    expect(rows.find((r) => r.label === "Session tokens")?.value).toBe("1.5k")
    expect(rows.find((r) => r.label === "Session cost")?.value).toBe("$0.250")
    expect(rows.find((r) => r.label === "Duration")?.value).toBe("3.0s")
  })
})

describe("cacheHitRatio", () => {
  it("is the reused share of the prompt", () => {
    expect(
      cacheHitRatio({ inputTokens: 100, cacheReadInputTokens: 300, cacheCreationInputTokens: 100 })
    ).toBeCloseTo(0.6, 6)
  })
  it("is 0 for an empty prompt or undefined usage", () => {
    expect(cacheHitRatio(undefined)).toBe(0)
    expect(cacheHitRatio({ outputTokens: 10 })).toBe(0)
  })
})

describe("contextComposition", () => {
  it("decomposes a turn into reused / new / fresh / output", () => {
    expect(
      contextComposition({
        inputTokens: 40,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 20,
        outputTokens: 10,
      })
    ).toEqual({ cacheRead: 30, cacheCreation: 20, fresh: 40, output: 10 })
  })
  it("zeroes every field for undefined usage", () => {
    expect(contextComposition(undefined)).toEqual({
      cacheRead: 0,
      cacheCreation: 0,
      fresh: 0,
      output: 0,
    })
  })
})

describe("session totals", () => {
  it("starts at zero", () => {
    expect(emptySessionTotals()).toEqual({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 0,
    })
  })

  it("folds a turn's usage into the running totals", () => {
    let totals = emptySessionTotals()
    totals = accumulateUsage(totals, {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 10,
      cacheCreationInputTokens: 5,
      totalCostUsd: 0.1,
      durationMs: 1000,
    })
    totals = accumulateUsage(totals, { outputTokens: 25, totalCostUsd: 0.2 })
    expect(totals).toEqual({
      costUsd: expect.closeTo(0.3, 5),
      inputTokens: 100,
      outputTokens: 75,
      cacheReadTokens: 10,
      cacheCreationTokens: 5,
      durationMs: 1000,
    })
  })

  it("estimates cost from pricing when the SDK reports none", () => {
    // No totalCostUsd (the ai-sdk path emits 0) → price from the catalog rates.
    const totals = accumulateUsage(
      emptySessionTotals(),
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      { promptPer1M: 3, completionPer1M: 15 }
    )
    expect(totals.costUsd).toBeCloseTo(18, 6)
  })

  it("prefers a positive SDK cost over the pricing estimate", () => {
    const totals = accumulateUsage(
      emptySessionTotals(),
      { inputTokens: 1_000_000, totalCostUsd: 0.5 },
      { promptPer1M: 3, completionPer1M: 15 }
    )
    expect(totals.costUsd).toBeCloseTo(0.5, 6)
  })
})

describe("formatFooter with totals", () => {
  it("uses cumulative totals for tokens + cost and latest usage for context", () => {
    const f = formatFooter({
      model: "claude-x",
      provider: "anthropic",
      mode: "default",
      cwd: "/w",
      usage: { inputTokens: 2000 },
      totals: {
        costUsd: 1.5,
        inputTokens: 4000,
        outputTokens: 1000,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        durationMs: 0,
      },
    })
    expect(f.tokens).toBe("5.0k")
    expect(f.cost).toBe("$1.50")
  })
})
