import type { SessionUsageRow } from "@/lib/db/session-usage"

import { EMPTY_ESTIMATE, type RunEstimate } from "./estimate"
import { compareRunProgress, spendFromUsageRows } from "./progress"

const estimate: RunEstimate = {
  confidence: "based",
  sampleCount: 22,
  tokens: { p10: 100, p50: 1000, p90: 5000 },
  costUsd: { p10: 0.5, p50: 2, p90: 6 },
  durationMs: null,
  stoppedShare: null,
}

function row(over: Partial<SessionUsageRow>): SessionUsageRow {
  return {
    messageId: `m-${Math.random()}`,
    sessionId: "goal:g",
    at: 1,
    inputTokens: 100,
    outputTokens: 10,
    cacheCreationTokens: 5,
    cacheReadTokens: 20,
    costUsd: 0.25,
    costSource: "priced",
    costKnown: true,
    durationMs: 0,
    ...over,
  }
}

describe("spendFromUsageRows", () => {
  it("sums frozen cost and every token class", () => {
    expect(spendFromUsageRows([row({}), row({ costUsd: 0.5 })])).toEqual({
      costUsd: 0.75,
      tokens: 270,
    })
  })

  it("drops cost when any turn is unpriced, keeping tokens", () => {
    expect(
      spendFromUsageRows([row({}), row({ costUsd: 0, costSource: "unknown", costKnown: false })])
    ).toEqual({ costUsd: null, tokens: 270 })
  })

  it("is empty with no rows", () => {
    expect(spendFromUsageRows([])).toEqual({ costUsd: null, tokens: null })
  })
})

describe("compareRunProgress", () => {
  it("compares cost against the typical total", () => {
    expect(compareRunProgress({ costUsd: 1.2, tokens: 400 }, estimate)).toEqual({
      metric: "cost",
      spent: 1.2,
      typical: 2,
      high: 6,
      overRange: false,
      confidence: "based",
      sampleCount: 22,
    })
  })

  it("flags spend above the P90 as outside the usual range", () => {
    expect(compareRunProgress({ costUsd: 6.01, tokens: null }, estimate)?.overRange).toBe(true)
    expect(compareRunProgress({ costUsd: 6, tokens: null }, estimate)?.overRange).toBe(false)
  })

  it("falls back to tokens when either side has no cost", () => {
    expect(compareRunProgress({ costUsd: null, tokens: 6000 }, estimate)).toMatchObject({
      metric: "tokens",
      spent: 6000,
      overRange: true,
    })
    expect(
      compareRunProgress({ costUsd: 1, tokens: 300 }, { ...estimate, costUsd: null })
    ).toMatchObject({ metric: "tokens", spent: 300 })
  })

  it("is null without an estimate or a shared measure", () => {
    expect(compareRunProgress({ costUsd: 1, tokens: 1 }, null)).toBeNull()
    expect(compareRunProgress({ costUsd: 1, tokens: 1 }, EMPTY_ESTIMATE)).toBeNull()
    expect(compareRunProgress({ costUsd: null, tokens: null }, estimate)).toBeNull()
    expect(
      compareRunProgress({ costUsd: 1, tokens: null }, { ...estimate, costUsd: null })
    ).toBeNull()
  })
})
