/**
 * @jest-environment node
 */
import { buildLimitsReport } from "./limits"
import type { SessionAnalysis } from "./usage-analysis"
import type { UsageSnapshot } from "@/types/subscription"

const NOW = 1_000_000_000_000

const emptyAnalysis: SessionAnalysis = {
  turns: 0,
  highContextTurns: 0,
  highContextPct: 0,
  highContextThreshold: 150_000,
  dispatchCalls: 0,
  totalToolCalls: 0,
  topTools: [],
}

function snapshot(over: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    fetchedAt: NOW,
    source: "probe",
    status: "allowed",
    representativeClaim: "five_hour",
    fiveHour: { utilization: 0.02, resetAt: NOW + 2 * 60 * 60 * 1000, status: "allowed" },
    sevenDay: { utilization: 0.04, resetAt: NOW + 3 * 24 * 60 * 60 * 1000, status: "allowed" },
    fallbackPercentage: null,
    overageDisabledReason: null,
    rawHeaders: {},
    ...over,
  }
}

describe("buildLimitsReport", () => {
  it("renders both subscription windows with % used and reset countdowns", () => {
    const report = buildLimitsReport(snapshot(), emptyAnalysis, NOW)
    expect(report).toContain("## Subscription limits")
    expect(report).toContain("Current session (5h)")
    expect(report).toContain("Current week (all models)")
    // utilization 0.02 → 2% used.
    expect(report).toMatch(/2%\s+used/)
    expect(report).toMatch(/4%\s+used/)
    expect(report).toContain("Resets in 2h 0m")
  })

  it("explains the absence when there is no snapshot", () => {
    const report = buildLimitsReport(null, emptyAnalysis, NOW)
    expect(report).toContain("No subscription limit data")
    expect(report).toContain("This session")
  })

  it("surfaces the local session analysis", () => {
    const analysis: SessionAnalysis = {
      turns: 10,
      highContextTurns: 8,
      highContextPct: 80,
      highContextThreshold: 150_000,
      dispatchCalls: 3,
      totalToolCalls: 12,
      topTools: [
        { name: "bash", calls: 6, pct: 50 },
        { name: "dispatch_agent", calls: 3, pct: 25 },
      ],
    }
    const report = buildLimitsReport(null, analysis, NOW)
    expect(report).toContain("Turns this session: 10")
    expect(report).toContain("80% of turns ran at >150k context")
    expect(report).toContain("/compact")
    expect(report).toContain("3 subagent dispatches")
    expect(report).toContain("bash — 6 calls (50%)")
  })

  it("renders a minutes-only reset when under an hour", () => {
    const snap = snapshot({
      fiveHour: { utilization: 0.5, resetAt: NOW + 12 * 60 * 1000, status: "allowed" },
      sevenDay: null,
    })
    const report = buildLimitsReport(snap, emptyAnalysis, NOW)
    expect(report).toContain("Resets in 12m")
  })

  it("notes when there's no activity yet", () => {
    const report = buildLimitsReport(null, emptyAnalysis, NOW)
    expect(report).toContain("No activity recorded yet.")
  })

  it("surfaces a fallback-in-use percentage when present", () => {
    const report = buildLimitsReport(snapshot({ fallbackPercentage: 30 }), emptyAnalysis, NOW)
    expect(report).toContain("Fallback in use: 30%")
  })

  it("renders 'Resets shortly' once a window has expired", () => {
    const snap = snapshot({
      fiveHour: { utilization: 0.9, resetAt: NOW - 1000, status: "rate_limited" },
      sevenDay: null,
    })
    expect(buildLimitsReport(snap, emptyAnalysis, NOW)).toContain("Resets shortly")
  })
})
