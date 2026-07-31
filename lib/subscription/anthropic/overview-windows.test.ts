// Tests for the two-source quota fusion: newest snapshot wins, header
// metadata only surfaces when the header sample is the winner, warn
// threshold re-derivation, and staleness.

import {
  resolveUsageWindows,
  usageStatusFor,
  usageWindowsStale,
  USAGE_WINDOWS_STALE_MS,
} from "./overview-windows"

import type { ProviderLimitsRow, SubscriptionUsageRow } from "@/types/subscription"

const NOW = 1_700_000_000_000

function limitsRow(overrides: Partial<ProviderLimitsRow> = {}): ProviderLimitsRow {
  return {
    provider: "anthropic",
    accountId: "acc-1",
    fetchedAt: NOW,
    meters: [
      {
        id: "session",
        labelKey: "subscription.limits.meter.session",
        kind: "window",
        usedPct: 42,
        resetAt: NOW + 3_600_000,
        status: "ok",
      },
      {
        id: "weekly",
        labelKey: "subscription.limits.meter.weekly",
        kind: "window",
        usedPct: 91,
        resetAt: NOW + 86_400_000,
        status: "warn",
      },
      {
        id: "weekly_opus",
        labelKey: "subscription.limits.meter.weekly_opus",
        kind: "window",
        usedPct: 12,
        resetAt: NOW + 86_400_000,
        status: "ok",
      },
      {
        id: "overage",
        labelKey: "subscription.limits.meter.overage",
        kind: "balance",
        usedPct: 10,
        resetAt: null,
        status: "ok",
        remaining: 45,
        currency: "USD",
      },
    ],
    ...overrides,
  }
}

function headerRow(overrides: Partial<SubscriptionUsageRow> = {}): SubscriptionUsageRow {
  return {
    localId: 1,
    fetchedAt: NOW - 60_000,
    source: "passive",
    status: "allowed_warning",
    representativeClaim: "seven_day",
    fiveHour: { utilization: 0.3, resetAt: NOW + 3_600_000, status: "allowed" },
    sevenDay: { utilization: 0.95, resetAt: NOW + 86_400_000, status: "allowed_warning" },
    fallbackPercentage: 50,
    overageDisabledReason: "out_of_credits",
    rawHeaders: {},
    ...overrides,
  }
}

describe("resolveUsageWindows", () => {
  it("returns the empty shape when both sources are absent", () => {
    const got = resolveUsageWindows(null, null)
    expect(got.source).toBeNull()
    expect(got.windows).toHaveLength(0)
    expect(got.severity).toBe("unknown")
  })

  it("endpoint snapshot wins when newer: windows split from extras", () => {
    const got = resolveUsageWindows(limitsRow(), headerRow())
    expect(got.source).toBe("endpoint")
    expect(got.fetchedAt).toBe(NOW)
    expect(got.windows.map((m) => m.id)).toEqual(["session", "weekly", "weekly_opus"])
    expect(got.extras.map((m) => m.id)).toEqual(["overage"])
    expect(got.severity).toBe("warn")
    // Header metadata suppressed — the claim belongs to the older sample.
    expect(got.headerStatus).toBeNull()
    expect(got.representativeClaim).toBeNull()
    expect(got.overageDisabledReason).toBeNull()
  })

  it("header sample wins when newer: 0-1 utilization converts to percents", () => {
    const headers = headerRow({ fetchedAt: NOW + 1000 })
    const got = resolveUsageWindows(limitsRow(), headers)
    expect(got.source).toBe("headers")
    expect(got.windows.map((m) => m.id)).toEqual(["session", "weekly"])
    expect(got.windows[0].usedPct).toBe(30)
    expect(got.windows[1].usedPct).toBe(95)
    expect(got.headerStatus).toBe("allowed_warning")
    expect(got.representativeClaim).toBe("seven_day")
    expect(got.overageDisabledReason).toBe("out_of_credits")
    expect(got.fallbackPercentage).toBe(50)
  })

  it("headers with a missing window emit only the present one", () => {
    const got = resolveUsageWindows(null, headerRow({ sevenDay: null }))
    expect(got.windows.map((m) => m.id)).toEqual(["session"])
  })

  it("re-derives window status from the configured warn threshold", () => {
    // 42% session: warn at threshold 40, ok at default 90.
    const got = resolveUsageWindows(limitsRow(), null, { warnThresholdPct: 40 })
    expect(got.windows.find((m) => m.id === "session")?.status).toBe("warn")
    const header = resolveUsageWindows(
      null,
      headerRow({ fiveHour: { utilization: 0.42, resetAt: NOW, status: "" }, sevenDay: null }),
      {
        warnThresholdPct: 40,
      }
    )
    expect(header.windows[0].status).toBe("warn")
  })

  it("an errored or empty endpoint snapshot yields to the header sample", () => {
    const errored = limitsRow({ error: "boom", fetchedAt: NOW + 5000 })
    expect(resolveUsageWindows(errored, headerRow()).source).toBe("headers")
    const empty = limitsRow({ meters: [], fetchedAt: NOW + 5000 })
    expect(resolveUsageWindows(empty, headerRow()).source).toBe("headers")
    expect(resolveUsageWindows(errored, null).source).toBeNull()
  })

  it("severity picks the worst window and ignores extras", () => {
    const exceeded = limitsRow({
      meters: [
        { id: "session", kind: "window", usedPct: 101, resetAt: null, status: "exceeded" },
        { id: "overage", kind: "balance", usedPct: 100, resetAt: null, status: "crit" },
      ],
    })
    expect(resolveUsageWindows(exceeded, null).severity).toBe("exceeded")
  })
})

describe("usageStatusFor", () => {
  it("prefers the header unified status when present", () => {
    const got = resolveUsageWindows(null, headerRow({ status: "rate_limited" }))
    expect(usageStatusFor(got)).toBe("rate_limited")
  })

  it.each([
    ["ok", "allowed"],
    ["warn", "allowed_warning"],
    ["crit", "rate_limited"],
    ["exceeded", "rate_limited"],
    ["unknown", "unknown"],
  ] as const)("maps endpoint severity %s → %s", (severity, expected) => {
    expect(
      usageStatusFor({
        source: "endpoint",
        fetchedAt: NOW,
        windows: [],
        extras: [],
        severity,
        headerStatus: null,
        representativeClaim: null,
        overageDisabledReason: null,
        fallbackPercentage: null,
      })
    ).toBe(expected)
  })
})

describe("usageWindowsStale", () => {
  it("missing data is stale", () => {
    expect(usageWindowsStale({ fetchedAt: null }, NOW)).toBe(true)
  })

  it("fresh data within the budget is not stale", () => {
    expect(usageWindowsStale({ fetchedAt: NOW - USAGE_WINDOWS_STALE_MS + 1000 }, NOW)).toBe(false)
  })

  it("data older than the budget is stale", () => {
    expect(usageWindowsStale({ fetchedAt: NOW - USAGE_WINDOWS_STALE_MS - 1000 }, NOW)).toBe(true)
  })
})
