import {
  AGENT_TRACE_WINDOWS,
  agentTraceWindowSince,
  agentTraceWindowSinceOrZero,
  resolveAgentTraceWindow,
} from "./trace-window"

// 2026-08-19T14:30:00 local time.
const NOW = new Date(2026, 7, 19, 14, 30, 0, 0).getTime()

describe("agentTraceWindowSince", () => {
  it("aligns today to local midnight rather than 24h ago", () => {
    const since = agentTraceWindowSince("today", NOW)
    const midnight = new Date(2026, 7, 19, 0, 0, 0, 0).getTime()
    expect(since).toBe(midnight)
    expect(since).not.toBe(NOW - 24 * 60 * 60 * 1000)
  })

  it("slides week and month relative to now", () => {
    expect(agentTraceWindowSince("week", NOW)).toBe(NOW - 7 * 24 * 60 * 60 * 1000)
    expect(agentTraceWindowSince("month", NOW)).toBe(NOW - 30 * 24 * 60 * 60 * 1000)
  })

  it("returns undefined for all so the Dexie helpers drop the lower bound", () => {
    expect(agentTraceWindowSince("all", NOW)).toBeUndefined()
  })
})

describe("agentTraceWindowSinceOrZero", () => {
  it("floors the unbounded window to 0", () => {
    expect(agentTraceWindowSinceOrZero("all", NOW)).toBe(0)
  })

  it("passes bounded windows through unchanged", () => {
    expect(agentTraceWindowSinceOrZero("week", NOW)).toBe(agentTraceWindowSince("week", NOW))
  })
})

describe("resolveAgentTraceWindow", () => {
  it("accepts every rendered preset", () => {
    for (const w of AGENT_TRACE_WINDOWS) expect(resolveAgentTraceWindow(w)).toBe(w)
  })

  it("falls back for unknown, null, and undefined values", () => {
    expect(resolveAgentTraceWindow("yesterday")).toBe("today")
    expect(resolveAgentTraceWindow(null)).toBe("today")
    expect(resolveAgentTraceWindow(undefined)).toBe("today")
    expect(resolveAgentTraceWindow("nope", "month")).toBe("month")
  })
})
