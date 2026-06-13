import { createAnthropicLimitsSource } from "./anthropic"

import type { LimitsSourceContext, UsageSnapshot } from "@/types/subscription"
import type { ProbeOutcome } from "@/lib/subscription/anthropic/usage-probe"

function ctx(over: Partial<LimitsSourceContext> = {}): LimitsSourceContext {
  return {
    provider: "anthropic",
    accountId: "acc-1",
    accountLabel: "Max",
    token: "sk-ant",
    authedGet: async () => "",
    now: 1_000_000,
    ...over,
  }
}

function okOutcome(over: Partial<UsageSnapshot> = {}): ProbeOutcome {
  return {
    ok: true,
    snapshot: {
      fetchedAt: 1_000_000,
      source: "probe",
      status: "allowed",
      representativeClaim: "five_hour",
      fiveHour: { utilization: 0.21, resetAt: 1_000_000 + 3_600_000, status: "allowed" },
      sevenDay: { utilization: 0.05, resetAt: 1_000_000 + 86_400_000, status: "allowed" },
      fallbackPercentage: null,
      overageDisabledReason: null,
      rawHeaders: {},
      ...over,
    },
  }
}

describe("anthropicLimitsSource", () => {
  it("matches only the anthropic provider", () => {
    const s = createAnthropicLimitsSource()
    expect(s.matches({ provider: "anthropic" })).toBe(true)
    expect(s.matches({ provider: "codex" })).toBe(false)
  })

  it("maps 5h → session and 7d → weekly meters", async () => {
    const s = createAnthropicLimitsSource(async () => okOutcome())
    const snap = await s.fetch(ctx())
    expect(snap?.provider).toBe("anthropic")
    expect(snap?.accountLabel).toBe("Max")
    expect(snap?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 21, kind: "window", status: "ok" })
    expect(snap?.meters[1].usedPct).toBe(5)
  })

  it("returns null when there is no token", async () => {
    const s = createAnthropicLimitsSource(async () => okOutcome())
    expect(await s.fetch(ctx({ token: null }))).toBeNull()
  })

  it("returns null when the probe fails", async () => {
    const s = createAnthropicLimitsSource(async () => ({ ok: false, reason: "auth", status: 401 }))
    expect(await s.fetch(ctx())).toBeNull()
  })

  it("returns null when the probe throws", async () => {
    const s = createAnthropicLimitsSource(async () => {
      throw new Error("net")
    })
    expect(await s.fetch(ctx())).toBeNull()
  })

  it("returns null when both windows are absent", async () => {
    const s = createAnthropicLimitsSource(async () => okOutcome({ fiveHour: null, sevenDay: null }))
    expect(await s.fetch(ctx())).toBeNull()
  })
})
