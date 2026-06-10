/**
 * @jest-environment node
 */
import {
  contextPercent,
  contextTokens,
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
      "Context",
      "Cost",
      "Duration",
    ])
    expect(rows.find((r) => r.label === "Duration")?.value).toBe("1.5s")
  })

  it("shows an em dash for missing duration and tolerates absent usage", () => {
    const rows = usagePanelRows(undefined, undefined)
    expect(rows.find((r) => r.label === "Duration")?.value).toBe("—")
  })
})
