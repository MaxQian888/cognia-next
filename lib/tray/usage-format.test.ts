import {
  formatAccountLine,
  formatMeterShort,
  formatResetDelta,
  selectDisplayAccount,
  summarizeLimits,
  trayUsageAccountKey,
  usageShortText,
  usageTooltipFragment,
  worstMeterOf,
} from "./usage-format"

import type { ProviderLimits } from "@/types/subscription"
import type { TrayUsageAccount, TrayUsageMeterSummary } from "./types"

function windowMeter(over: Partial<TrayUsageMeterSummary> = {}): TrayUsageMeterSummary {
  return { id: "session", kind: "window", usedPct: 42, status: "ok", resetAt: null, ...over }
}

function account(over: Partial<TrayUsageAccount> = {}): TrayUsageAccount {
  return {
    key: "anthropic:a1",
    provider: "anthropic",
    accountLabel: "Claude Pro",
    worst: windowMeter(),
    meters: [windowMeter()],
    ...over,
  }
}

describe("trayUsageAccountKey", () => {
  it("prefers accountId and falls back to the label for custom sources", () => {
    expect(trayUsageAccountKey({ provider: "anthropic", accountId: "a1" })).toBe("anthropic:a1")
    expect(trayUsageAccountKey({ provider: "custom", accountLabel: "Relay" })).toBe("custom:Relay")
    expect(trayUsageAccountKey({ provider: "custom" })).toBe("custom:")
  })
})

describe("worstMeterOf", () => {
  it("picks the highest usedPct", () => {
    const worst = worstMeterOf([
      windowMeter({ id: "weekly", usedPct: 10 }),
      windowMeter({ id: "session", usedPct: 90, status: "crit" }),
    ])
    expect(worst?.id).toBe("session")
  })

  it("falls back to the first meter with a remaining balance", () => {
    const worst = worstMeterOf([
      windowMeter({ id: "a", usedPct: null }),
      windowMeter({ id: "credit", kind: "balance", usedPct: null, remaining: 8.5, unit: "USD" }),
    ])
    expect(worst?.id).toBe("credit")
  })

  it("returns null when nothing is displayable", () => {
    expect(worstMeterOf([windowMeter({ usedPct: null })])).toBeNull()
    expect(worstMeterOf([])).toBeNull()
  })
})

describe("summarizeLimits", () => {
  it("projects ProviderLimits into per-account summaries", () => {
    const snapshots: ProviderLimits[] = [
      {
        provider: "anthropic",
        accountId: "a1",
        accountLabel: "Claude Pro",
        fetchedAt: 100,
        meters: [
          {
            id: "session",
            kind: "window",
            usedPct: 42,
            resetAt: 500,
            status: "ok",
          },
        ],
      },
    ]
    const accounts = summarizeLimits(snapshots)
    expect(accounts).toHaveLength(1)
    expect(accounts[0].key).toBe("anthropic:a1")
    expect(accounts[0].worst?.usedPct).toBe(42)
    expect(accounts[0].meters).toHaveLength(1)
  })
})

describe("selectDisplayAccount", () => {
  const a = account({ key: "anthropic:a1", worst: windowMeter({ usedPct: 42 }) })
  const b = account({ key: "codex:b1", worst: windowMeter({ usedPct: 80, status: "warn" }) })

  it("returns the pinned account when it exists", () => {
    expect(selectDisplayAccount([a, b], "anthropic:a1")).toBe(a)
  })

  it("falls back to the worst-utilized account for stale or absent pins", () => {
    expect(selectDisplayAccount([a, b], "gone:x")).toBe(b)
    expect(selectDisplayAccount([a, b], null)).toBe(b)
  })

  it("falls back to any displayable account when no percents exist", () => {
    const creditOnly = account({
      key: "custom:c",
      worst: windowMeter({ kind: "balance", usedPct: null, remaining: 5 }),
    })
    const nothing = account({ key: "custom:n", worst: null })
    expect(selectDisplayAccount([nothing, creditOnly], null)).toBe(creditOnly)
    expect(selectDisplayAccount([nothing], null)).toBeNull()
    expect(selectDisplayAccount([], null)).toBeNull()
  })
})

describe("formatters", () => {
  it("formatMeterShort renders percents, balances, and nothing", () => {
    expect(formatMeterShort(windowMeter({ usedPct: 42.4 }))).toBe("42%")
    expect(formatMeterShort(windowMeter({ usedPct: -3 }))).toBe("0%")
    expect(
      formatMeterShort(
        windowMeter({ kind: "balance", usedPct: null, remaining: 8.505, currency: "USD" })
      )
    ).toBe("$8.51")
    expect(
      formatMeterShort(windowMeter({ kind: "balance", usedPct: null, remaining: 12, unit: "CNY" }))
    ).toBe("¥12")
    expect(
      formatMeterShort(
        windowMeter({ kind: "balance", usedPct: null, remaining: 100, unit: "tokens" })
      )
    ).toBe("100 tokens")
    expect(formatMeterShort(windowMeter({ usedPct: null }))).toBeNull()
  })

  it("formatResetDelta renders compact countdowns", () => {
    expect(formatResetDelta(null, 0)).toBeNull()
    expect(formatResetDelta(0, 1)).toBeNull()
    expect(formatResetDelta(45 * 60_000, 0)).toBe("45m")
    expect(formatResetDelta(65 * 60_000, 0)).toBe("1h05m")
    expect(formatResetDelta(72 * 3_600_000, 0)).toBe("3d")
  })

  it("formatAccountLine joins label, readout and countdown", () => {
    expect(
      formatAccountLine(account({ worst: windowMeter({ usedPct: 42, resetAt: 65 * 60_000 }) }), 0)
    ).toBe("Claude Pro · 42% · 1h05m")
    expect(formatAccountLine(account({ accountLabel: undefined }), 0)).toBe("anthropic · 42%")
    expect(formatAccountLine(account({ worst: null, error: "boom" }), 0)).toBe("Claude Pro · ⚠")
    expect(formatAccountLine(account({ worst: null }), 0)).toBe("Claude Pro")
  })
})

describe("usageTooltipFragment / usageShortText", () => {
  const usage = {
    accounts: [account({ worst: windowMeter({ usedPct: 91, status: "warn" }) })],
    fetchedAt: 1,
    selectedKey: null,
  }

  it("renders the selected account's line / short readout", () => {
    expect(usageTooltipFragment(usage, 0)).toBe("Claude Pro · 91%")
    expect(usageShortText(usage)).toEqual({ text: "91%", status: "warn" })
  })

  it("returns null for absent or empty usage", () => {
    expect(usageTooltipFragment(null, 0)).toBeNull()
    expect(usageTooltipFragment({ accounts: [], fetchedAt: null, selectedKey: null }, 0)).toBeNull()
    expect(usageShortText(null)).toBeNull()
    expect(usageShortText({ accounts: [], fetchedAt: null, selectedKey: null })).toBeNull()
  })
})
