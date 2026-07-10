import type { UIMessage } from "ai"

import {
  DEFAULT_RUN_STATUS_BAR,
  aggregateRunBarUsage,
  needsLiveUsage,
  resolveRunStatusBarSettings,
} from "./run-bar-metrics"

function assistant(usage?: Record<string, number>): UIMessage {
  return {
    id: `a-${Math.random().toString(36).slice(2)}`,
    role: "assistant",
    parts: [],
    ...(usage ? { metadata: { usage } } : {}),
  } as unknown as UIMessage
}

function user(): UIMessage {
  return { id: "u", role: "user", parts: [] } as unknown as UIMessage
}

describe("resolveRunStatusBarSettings", () => {
  it("fills every field from defaults when nothing is stored", () => {
    expect(resolveRunStatusBarSettings(undefined)).toEqual(DEFAULT_RUN_STATUS_BAR)
    expect(resolveRunStatusBarSettings(null)).toEqual(DEFAULT_RUN_STATUS_BAR)
  })

  it("honours an explicit false without letting it fall back to a default", () => {
    const r = resolveRunStatusBarSettings({ showSpeed: false, showCost: true })
    expect(r.showSpeed).toBe(false) // default is true — explicit false must win
    expect(r.showCost).toBe(true)
    expect(r.showElapsed).toBe(true) // untouched → default
  })
})

describe("needsLiveUsage", () => {
  it("is true when any usage-derived chip is on", () => {
    expect(needsLiveUsage(resolveRunStatusBarSettings({ showSpeed: true }))).toBe(true)
    expect(
      needsLiveUsage(
        resolveRunStatusBarSettings({
          showElapsed: true,
          showTools: true,
          showOutputTokens: false,
          showSpeed: false,
          showCost: false,
          showContextPct: false,
        })
      )
    ).toBe(false)
  })
})

describe("aggregateRunBarUsage", () => {
  it("sums output, cost and duration over assistant turns and ignores user turns", () => {
    const totals = aggregateRunBarUsage([
      user(),
      assistant({ outputTokens: 200, totalCostUsd: 0.01, durationMs: 4000 }),
      assistant({ outputTokens: 300, totalCostUsd: 0.02, durationMs: 6000 }),
      assistant(), // no usage metadata → not counted
    ])
    expect(totals.turns).toBe(2)
    expect(totals.outputTokens).toBe(500)
    expect(totals.costUsd).toBeCloseTo(0.03)
    expect(totals.durationMs).toBe(10_000)
  })

  it("derives context fill from the latest turn against the default window", () => {
    // DEFAULT_CONTEXT_WINDOW = 128_000; 64_000 in the window → 0.5.
    const totals = aggregateRunBarUsage([
      assistant({ inputTokens: 1000, outputTokens: 0 }),
      assistant({ inputTokens: 64_000, outputTokens: 0 }),
    ])
    expect(totals.contextFraction).toBeCloseTo(0.5, 3)
  })

  it("returns zeros for a session with no usage", () => {
    const totals = aggregateRunBarUsage([user(), assistant()])
    expect(totals).toEqual({
      turns: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      contextFraction: 0,
    })
  })
})
