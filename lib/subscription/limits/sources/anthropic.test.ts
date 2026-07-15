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

/** The endpoint answered cleanly but reported no windows. */
const emptyUsage = async () => ({ ok: true as const, meters: [] })

/** An expired bearer, as `fetchOAuthUsage` reports it. */
const authFailure = () => ({
  ok: false as const,
  kind: "auth" as const,
  status: 401,
  message: "401 Unauthorized: {}",
})

/** A throttled endpoint, as `fetchOAuthUsage` reports it. */
const rateLimitFailure = () => ({
  ok: false as const,
  kind: "rate_limited" as const,
  status: 429,
  message: "429 Too Many Requests: slow down",
})

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
      fetchUsage: emptyUsage,
      probe: async () => okOutcome(),
    })
    expect(await s.fetch(ctx({ token: null }))).toBeNull()
  })
})

describe("anthropicLimitsSource — reactive refresh", () => {
  it("refreshes the token and retries the endpoint once on a 401", async () => {
    const fetchUsage = jest.fn(async (token: string) =>
      token === "fresh"
        ? {
            ok: true as const,
            meters: [
              { id: "session", kind: "window" as const, usedPct: 33, status: "ok" as const },
            ],
          }
        : authFailure()
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

  // A throttle is not an expired bearer. Refreshing on a 429 rotates the token
  // pair for nothing and still can't read the quota.
  it("does not refresh on a 429, and surfaces the throttle", async () => {
    const fetchUsage = jest.fn(async () => rateLimitFailure())
    const refreshToken = jest.fn(async () => "fresh")
    const s = createAnthropicLimitsSource({ fetchUsage, probe: null })
    const snap = await s.fetch(ctx({ token: "stale", refreshToken }))
    expect(refreshToken).not.toHaveBeenCalled()
    expect(fetchUsage).toHaveBeenCalledTimes(1)
    expect(snap?.error).toContain("429")
  })

  it("surfaces the auth error when the refresh yields no new token", async () => {
    const fetchUsage = jest.fn(async () => authFailure())
    const s = createAnthropicLimitsSource({ fetchUsage, probe: null })
    const snap = await s.fetch(ctx({ token: "stale", refreshToken: async () => null }))
    expect(fetchUsage).toHaveBeenCalledTimes(1)
    expect(snap?.error).toContain("401")
    expect(snap?.meters).toEqual([])
  })

  it("does not retry when refresh returns the same token", async () => {
    const fetchUsage = jest.fn(async () => authFailure())
    const s = createAnthropicLimitsSource({ fetchUsage, probe: null })
    const snap = await s.fetch(ctx({ token: "same", refreshToken: async () => "same" }))
    expect(fetchUsage).toHaveBeenCalledTimes(1)
    expect(snap?.error).toContain("401")
  })
})

describe("anthropicLimitsSource — failures surface instead of vanishing", () => {
  // The regression this guards: every failure used to collapse into `null`, so
  // the panel rendered blank next to a stale number with nothing in the log.
  it.each([
    ["rate_limited", rateLimitFailure(), "429"],
    [
      "http",
      { ok: false as const, kind: "http" as const, status: 500, message: "500: boom" },
      "500",
    ],
    [
      "network",
      { ok: false as const, kind: "network" as const, message: "request failed: dns" },
      "dns",
    ],
    [
      "parse",
      {
        ok: false as const,
        kind: "parse" as const,
        message: "unrecognized usage response: <html>",
      },
      "unrecognized",
    ],
  ])("reports a %s failure as an error snapshot", async (_kind, failure, needle) => {
    const s = createAnthropicLimitsSource({ fetchUsage: async () => failure, probe: null })
    const snap = await s.fetch(ctx())
    expect(snap).toMatchObject({ provider: "anthropic", accountId: "acc-1", meters: [] })
    expect(snap?.error).toContain(needle)
  })

  // The probe shares the bearer and host, so it would fail the same way — and
  // each attempt costs ~10 tokens.
  it("does not spend the paid probe on a throttled endpoint", async () => {
    let probed = false
    const s = createAnthropicLimitsSource({
      fetchUsage: async () => rateLimitFailure(),
      probe: async () => {
        probed = true
        return okOutcome()
      },
    })
    const snap = await s.fetch(ctx())
    expect(probed).toBe(false)
    expect(snap?.error).toContain("429")
  })

  it("normalizes a fetchUsage that throws instead of reporting", async () => {
    const s = createAnthropicLimitsSource({
      fetchUsage: async () => {
        throw new Error("429 Too Many Requests: bucket")
      },
      probe: null,
    })
    expect((await s.fetch(ctx()))?.error).toContain("429")
  })
})

describe("anthropicLimitsSource — probe fallback", () => {
  it("falls back to the probe (5h → session, 7d → weekly) when the endpoint reports no windows", async () => {
    const s = createAnthropicLimitsSource({
      fetchUsage: emptyUsage,
      probe: async () => okOutcome(),
    })
    const snap = await s.fetch(ctx())
    expect(snap?.meters.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(snap?.meters[0]).toMatchObject({ usedPct: 21, status: "ok" })
    expect(snap?.meters[1].usedPct).toBe(5)
  })

  it("returns null when the probe fails or throws", async () => {
    const failed = createAnthropicLimitsSource({
      fetchUsage: emptyUsage,
      probe: async () => ({ ok: false, reason: "auth", status: 401 }),
    })
    expect(await failed.fetch(ctx())).toBeNull()
    const threw = createAnthropicLimitsSource({
      fetchUsage: emptyUsage,
      probe: async () => {
        throw new Error("net")
      },
    })
    expect(await threw.fetch(ctx())).toBeNull()
  })

  it("returns null when both windows are absent", async () => {
    const s = createAnthropicLimitsSource({
      fetchUsage: emptyUsage,
      probe: async () => okOutcome({ fiveHour: null, sevenDay: null }),
    })
    expect(await s.fetch(ctx())).toBeNull()
  })

  it("returns null when the endpoint reports no windows and the probe is disabled", async () => {
    const s = createAnthropicLimitsSource({ fetchUsage: emptyUsage, probe: null })
    expect(await s.fetch(ctx())).toBeNull()
  })
})
