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

/** A free-endpoint usage body carrying all four windows. */
function usageBody(): string {
  return JSON.stringify({
    five_hour: { utilization: 33, resets_at: "2026-01-01T05:00:00.000Z" },
    seven_day: { utilization: 12, resets_at: "2026-01-08T00:00:00.000Z" },
    seven_day_opus: { utilization: 60, resets_at: "2026-01-08T00:00:00.000Z" },
    seven_day_sonnet: { utilization: 4, resets_at: "2026-01-08T00:00:00.000Z" },
  })
}

describe("anthropicLimitsSource — free endpoint primary", () => {
  it("matches only the anthropic provider", () => {
    const s = createAnthropicLimitsSource()
    expect(s.matches({ provider: "anthropic" })).toBe(true)
    expect(s.matches({ provider: "codex" })).toBe(false)
  })

  it("maps all four windows from the free endpoint and never probes", async () => {
    let probed = false
    const s = createAnthropicLimitsSource({
      probe: async () => {
        probed = true
        return okOutcome()
      },
    })
    const snap = await s.fetch(ctx({ authedGet: async () => usageBody() }))
    expect(snap?.meters.map((m) => m.id)).toEqual([
      "session",
      "weekly",
      "weekly_opus",
      "weekly_sonnet",
    ])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 33, kind: "window" })
    expect(snap?.meters[2].usedPct).toBe(60)
    expect(probed).toBe(false)
  })

  it("returns null when there is no token", async () => {
    const s = createAnthropicLimitsSource({
      fetchUsage: async () => [],
      probe: async () => okOutcome(),
    })
    expect(await s.fetch(ctx({ token: null }))).toBeNull()
  })
})

describe("anthropicLimitsSource — reactive refresh", () => {
  it("refreshes the token and retries the endpoint once when the first read is empty", async () => {
    const fetchUsage = jest.fn(async (token: string) =>
      token === "fresh"
        ? [{ id: "session", kind: "window" as const, usedPct: 33, status: "ok" as const }]
        : []
    )
    let probed = false
    const s = createAnthropicLimitsSource({
      fetchUsage,
      probe: async () => {
        probed = true
        return okOutcome()
      },
    })
    const snap = await s.fetch(ctx({ token: "stale", refreshToken: async () => "fresh" }))
    expect(fetchUsage).toHaveBeenCalledTimes(2)
    expect(snap?.meters[0]).toMatchObject({ usedPct: 33 })
    expect(probed).toBe(false)
  })

  it("does not retry when refresh yields no new token, and falls to the probe", async () => {
    const fetchUsage = jest.fn(async () => [])
    const s = createAnthropicLimitsSource({
      fetchUsage,
      probe: async () => okOutcome(),
    })
    const snap = await s.fetch(ctx({ token: "stale", refreshToken: async () => null }))
    // One free read, no retry; the probe fallback then supplies the windows.
    expect(fetchUsage).toHaveBeenCalledTimes(1)
    expect(snap?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
  })

  it("does not retry when refresh returns the same token", async () => {
    const fetchUsage = jest.fn(async () => [])
    const s = createAnthropicLimitsSource({ fetchUsage, probe: null })
    const snap = await s.fetch(ctx({ token: "same", refreshToken: async () => "same" }))
    expect(fetchUsage).toHaveBeenCalledTimes(1)
    expect(snap).toBeNull()
  })
})

describe("anthropicLimitsSource — probe fallback", () => {
  // Force the free endpoint to yield nothing so the probe path is exercised.
  const noFreeUsage = async () => []

  it("falls back to the probe (5h → session, 7d → weekly) when the endpoint is empty", async () => {
    const s = createAnthropicLimitsSource({
      fetchUsage: noFreeUsage,
      probe: async () => okOutcome(),
    })
    const snap = await s.fetch(ctx())
    expect(snap?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 21, status: "ok" })
    expect(snap?.meters[1].usedPct).toBe(5)
  })

  it("returns null when the probe fails or throws", async () => {
    const failed = createAnthropicLimitsSource({
      fetchUsage: noFreeUsage,
      probe: async () => ({ ok: false, reason: "auth", status: 401 }),
    })
    expect(await failed.fetch(ctx())).toBeNull()
    const threw = createAnthropicLimitsSource({
      fetchUsage: noFreeUsage,
      probe: async () => {
        throw new Error("net")
      },
    })
    expect(await threw.fetch(ctx())).toBeNull()
  })

  it("returns null when both windows are absent", async () => {
    const s = createAnthropicLimitsSource({
      fetchUsage: noFreeUsage,
      probe: async () => okOutcome({ fiveHour: null, sevenDay: null }),
    })
    expect(await s.fetch(ctx())).toBeNull()
  })

  it("returns null when the free endpoint throws and the probe is disabled", async () => {
    const s = createAnthropicLimitsSource({
      fetchUsage: async () => {
        throw new Error("net")
      },
      probe: null,
    })
    expect(await s.fetch(ctx())).toBeNull()
  })
})
