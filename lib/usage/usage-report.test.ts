import {
  buildUsageScope,
  buildUsageScopes,
  shareOfCost,
  shareOfTokens,
  summarizeSpend,
  USAGE_SCOPE_KEYS,
} from "./usage-report"
import type { SessionUsageRow } from "@/lib/db/session-usage"

const DAY = 86_400_000
const NOW = new Date("2026-08-29T12:00:00Z").getTime()

function row(overrides: Partial<SessionUsageRow> = {}): SessionUsageRow {
  return {
    messageId: `m${Math.random()}`,
    sessionId: "s1",
    at: NOW,
    model: "claude-opus-5",
    providerId: "anthropic",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    costUsd: 0.5,
    durationMs: 1000,
    costSource: "sdk",
    costKnown: true,
    ...overrides,
  }
}

describe("summarizeSpend", () => {
  it("returns an all-zero shape with a null cache rate for no rows", () => {
    const totals = summarizeSpend([])
    expect(totals.turns).toBe(0)
    expect(totals.costUsd).toBe(0)
    // null, not 0 — "no prompt tokens" is not "a cold cache".
    expect(totals.cacheHitRate).toBeNull()
    expect(totals.sessions).toBe(0)
  })

  it("sums tokens, cost, duration and distinct sessions", () => {
    const totals = summarizeSpend([
      row({ sessionId: "a", inputTokens: 100, outputTokens: 10, costUsd: 1, durationMs: 500 }),
      row({ sessionId: "b", inputTokens: 300, outputTokens: 20, costUsd: 2, durationMs: 1500 }),
    ])
    expect(totals.turns).toBe(2)
    expect(totals.inputTokens).toBe(400)
    expect(totals.outputTokens).toBe(30)
    expect(totals.costUsd).toBe(3)
    expect(totals.durationMs).toBe(2000)
    expect(totals.sessions).toBe(2)
  })

  it("computes the cache hit rate over every prompt token class", () => {
    const totals = summarizeSpend([
      row({ inputTokens: 100, cacheReadTokens: 300, cacheCreationTokens: 100 }),
    ])
    // 300 read / (100 fresh + 300 read + 100 written) = 0.6
    expect(totals.cacheHitRate).toBeCloseTo(0.6)
  })

  it("counts turns no pricing layer knew so the total reads as a lower bound", () => {
    const totals = summarizeSpend([
      row({ costUsd: 2, costSource: "sdk", costKnown: true }),
      row({ costUsd: 0, costSource: "unknown", costKnown: false }),
    ])
    expect(totals.costUsd).toBe(2)
    expect(totals.unpricedTurns).toBe(1)
  })

  it("sums reasoning tokens only from turns that reported them", () => {
    const totals = summarizeSpend([row({ reasoningTokens: 40 }), row({})])
    expect(totals.reasoningTokens).toBe(40)
  })
})

describe("buildUsageScope", () => {
  it("carries totals, both attribution axes and the contributor list", () => {
    const scope = buildUsageScope("today", [
      row({ surface: "chat", model: "claude-opus-5", costUsd: 3 }),
      row({ surface: "workflow", model: "claude-sonnet-5", costUsd: 1 }),
    ])
    expect(scope.key).toBe("today")
    expect(scope.totals.turns).toBe(2)
    expect(scope.surfaces.map((s) => s.surface)).toEqual(["chat", "workflow"])
    expect(scope.models.map((m) => m.model)).toEqual(["claude-opus-5", "claude-sonnet-5"])
    // 1 of 4 USD came from a non-chat surface → the automated-surface insight.
    expect(scope.contributors.map((c) => c.id)).toContain("automated-surface")
  })

  it("treats a row with no surface as chat", () => {
    const scope = buildUsageScope("today", [row({ surface: undefined })])
    expect(scope.surfaces).toHaveLength(1)
    expect(scope.surfaces[0].surface).toBe("chat")
  })
})

describe("buildUsageScopes", () => {
  const rows = [
    row({ sessionId: "active", at: NOW }),
    row({ sessionId: "other", at: NOW }),
    row({ sessionId: "other", at: NOW - 3 * DAY }),
  ]

  it("returns every scope in order, narrowest first", () => {
    const scopes = buildUsageScopes({ rows, sessionId: "active", now: NOW })
    expect(scopes.map((s) => s.key)).toEqual([...USAGE_SCOPE_KEYS])
  })

  it("scopes the session window to the active session only", () => {
    const [session] = buildUsageScopes({ rows, sessionId: "active", now: NOW })
    expect(session.totals.turns).toBe(1)
    expect(session.totals.sessions).toBe(1)
  })

  it("leaves the session scope empty rather than absent when nothing is active", () => {
    const [session] = buildUsageScopes({ rows, sessionId: null, now: NOW })
    expect(session.key).toBe("session")
    expect(session.totals.turns).toBe(0)
  })

  it("widens today → week", () => {
    const [, today, week] = buildUsageScopes({ rows, sessionId: "active", now: NOW })
    expect(today.totals.turns).toBe(2)
    expect(week.totals.turns).toBe(3)
  })
})

describe("share helpers", () => {
  const totals = summarizeSpend([
    row({ inputTokens: 100, outputTokens: 0, costUsd: 4 }),
    row({ inputTokens: 300, outputTokens: 0, costUsd: 0 }),
  ])

  it("divides tokens by the scope total", () => {
    expect(
      shareOfTokens(
        { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        totals
      )
    ).toBeCloseTo(100 / 400)
  })

  it("returns null for a token share of an empty scope", () => {
    expect(
      shareOfTokens(
        { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
        summarizeSpend([])
      )
    ).toBeNull()
  })

  it("divides cost by the scope total, and returns null when nothing cost anything", () => {
    expect(shareOfCost({ costUsd: 1 }, totals)).toBeCloseTo(0.25)
    expect(
      shareOfCost(
        { costUsd: 0 },
        summarizeSpend([row({ costUsd: 0, costKnown: false, costSource: "unknown" })])
      )
    ).toBeNull()
  })
})
