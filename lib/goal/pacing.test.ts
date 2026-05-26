import type { Goal, GoalConfig } from "@/types/goal"
import { gateContinuation } from "./pacing"

const BASE_CONFIG: GoalConfig = {
  maxTurns: 20,
  maxTokens: 200_000,
  maxJudgeFailures: 3,
  timeoutMs: 30 * 60_000,
}

function buildGoal(config: Partial<GoalConfig> = {}): Goal {
  const now = Date.now()
  return {
    id: "g1",
    sessionId: "s1",
    rawObjective: "obj",
    safeObjective: "obj",
    redactionMapEnc: "",
    status: "active",
    turnsUsed: 1,
    tokensUsed: 0,
    judgeFailureCount: 0,
    config: { ...BASE_CONFIG, ...config },
    generationId: "gen-1",
    createdAt: now,
    updatedAt: now,
  }
}

const NOW = Date.UTC(2026, 4, 26, 12, 0, 0) // midday UTC — outside the night windows below

describe("gateContinuation", () => {
  it("sends immediately with no pacing config", () => {
    expect(gateContinuation(buildGoal(), NOW, undefined)).toEqual({ kind: "send" })
  })

  it("holds when manualContinue is on (highest priority)", () => {
    const goal = buildGoal({
      manualContinue: true,
      // even with an interval that would otherwise send, manual wins
      continuationIntervalMs: 1000,
    })
    expect(gateContinuation(goal, NOW, NOW - 5000)).toEqual({ kind: "hold", reason: "manual" })
  })

  it("defers during a quiet-hours window", () => {
    // 00:00–23:59 UTC window contains midday → always quiet.
    const goal = buildGoal({ quietHours: { from: "00:00", to: "23:59", tz: "UTC" } })
    const gate = gateContinuation(goal, NOW, undefined)
    expect(gate.kind).toBe("defer")
    if (gate.kind !== "defer") return
    expect(gate.reason).toBe("quiet_hours")
    expect(gate.untilMs).toBeGreaterThan(NOW)
  })

  it("sends when outside the quiet-hours window", () => {
    // 22:00–07:00 night window does NOT contain midday.
    const goal = buildGoal({ quietHours: { from: "22:00", to: "07:00", tz: "UTC" } })
    expect(gateContinuation(goal, NOW, undefined)).toEqual({ kind: "send" })
  })

  it("defers until the interval gap elapses", () => {
    const goal = buildGoal({ continuationIntervalMs: 10_000 })
    const gate = gateContinuation(goal, NOW, NOW - 3_000) // only 3s since last
    expect(gate).toEqual({ kind: "defer", untilMs: NOW - 3_000 + 10_000, reason: "interval" })
  })

  it("sends once the interval gap has elapsed", () => {
    const goal = buildGoal({ continuationIntervalMs: 10_000 })
    expect(gateContinuation(goal, NOW, NOW - 20_000)).toEqual({ kind: "send" })
  })

  it("skips interval gating on the first continuation (no baseline)", () => {
    const goal = buildGoal({ continuationIntervalMs: 10_000 })
    expect(gateContinuation(goal, NOW, undefined)).toEqual({ kind: "send" })
  })

  it("ignores a quiet-hours object with empty fields", () => {
    const goal = buildGoal({ quietHours: { from: "", to: "", tz: "" } })
    expect(gateContinuation(goal, NOW, undefined)).toEqual({ kind: "send" })
  })
})
