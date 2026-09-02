import {
  buildUsageSection,
  USAGE_REFRESH_COMMAND,
  USAGE_SELECT_COMMAND_PREFIX,
} from "./usage-section"
import {
  buildUsageGlance,
  USAGE_GLANCE_PERIODS,
  type UsageGlanceSnapshotV1,
} from "@/lib/usage/usage-glance"
import type { TrayMenuItem, TrayUsageAccount, TrayUsageSnapshot } from "./types"

function account(over: Partial<TrayUsageAccount> = {}): TrayUsageAccount {
  return {
    key: "anthropic:a1",
    provider: "anthropic",
    accountLabel: "Claude Pro",
    worst: { id: "session", kind: "window", usedPct: 42, status: "ok", resetAt: null },
    meters: [],
    ...over,
  }
}

function usage(accounts: TrayUsageAccount[], selectedKey: string | null = null): TrayUsageSnapshot {
  return { accounts, fetchedAt: accounts.length ? 1 : null, selectedKey }
}

function ids(rows: TrayMenuItem[]): string[] {
  return rows.map((r) => r.id)
}

describe("buildUsageSection", () => {
  it("renders an empty-state row plus the refresh/settings actions when no accounts exist", () => {
    const rows = buildUsageSection(usage([]), 0)
    expect(ids(rows)).toEqual([
      "tray.usage.empty",
      "tray.usage.sep-0",
      "tray.usage.refresh",
      "tray.usage.open-settings",
    ])
    const empty = rows[0]
    expect(empty).toMatchObject({ kind: "action", disabled: true })
  })

  it("renders a single account as a plain disabled info row (no selection UI)", () => {
    const rows = buildUsageSection(usage([account()]), 0)
    expect(ids(rows)).toEqual([
      "tray.usage.account:anthropic:a1",
      "tray.usage.sep-0",
      "tray.usage.refresh",
      "tray.usage.open-settings",
    ])
    expect(rows[0]).toMatchObject({
      kind: "action",
      label: "Claude Pro · 42%",
      disabled: true,
      checked: undefined,
      payload: { kind: "native", action: "noop" },
    })
  })

  it("renders 2+ accounts as checkable pin-selection rows plus the Auto row", () => {
    const a = account()
    const b = account({ key: "codex:b1", provider: "codex", accountLabel: "ChatGPT" })
    const rows = buildUsageSection(usage([a, b], "codex:b1"), 0)
    expect(ids(rows)).toEqual([
      "tray.usage.account:anthropic:a1",
      "tray.usage.account:codex:b1",
      "tray.usage.auto",
      "tray.usage.sep-0",
      "tray.usage.refresh",
      "tray.usage.open-settings",
    ])
    expect(rows[0]).toMatchObject({
      checked: false,
      disabled: false,
      payload: { kind: "command", commandId: `${USAGE_SELECT_COMMAND_PREFIX}anthropic:a1` },
    })
    expect(rows[1]).toMatchObject({ checked: true })
    expect(rows[2]).toMatchObject({
      checked: false,
      payload: { kind: "command", commandId: USAGE_SELECT_COMMAND_PREFIX },
    })
  })

  it("checks the Auto row when nothing is pinned", () => {
    const rows = buildUsageSection(
      usage([account(), account({ key: "codex:b1", provider: "codex" })], null),
      0
    )
    const auto = rows.find((r) => r.id === "tray.usage.auto")
    expect(auto).toMatchObject({ checked: true })
  })

  it("wires the refresh row to the dispatcher-intercepted command id", () => {
    const rows = buildUsageSection(usage([]), 0)
    const refresh = rows.find((r) => r.id === "tray.usage.refresh")
    expect(refresh).toMatchObject({
      payload: { kind: "command", commandId: USAGE_REFRESH_COMMAND },
    })
    const settings = rows.find((r) => r.id === "tray.usage.open-settings")
    expect(settings).toMatchObject({ payload: { kind: "native", action: "settings" } })
  })
})

/* ── ADR-0165: the glance dimensions ───────────────────────────────────── */

const spendDisplay = {
  usageMetric: "spend" as const,
  usagePeriod: "7d" as const,
  usageScope: "cognia" as const,
}

function glance(over: Partial<UsageGlanceSnapshotV1> = {}): UsageGlanceSnapshotV1 {
  return {
    ...buildUsageGlance({
      rows: [],
      query: { period: "7d", scope: "cognia", metric: "spend" },
      now: 0,
    }),
    ...over,
  }
}

describe("buildUsageSection with glance dimensions", () => {
  it("keeps the historical quota-only menu when no display prefs are passed", () => {
    const rows = buildUsageSection(usage([account()]), 0)
    expect(ids(rows).some((id) => id.startsWith("tray.usage.metric:"))).toBe(false)
  })

  it("offers spend, tokens and quota, with the active one checked", () => {
    const rows = buildUsageSection(usage([account()]), 0, spendDisplay)
    const metrics = rows.filter((r) => r.id.startsWith("tray.usage.metric:"))
    expect(metrics.map((r) => r.id)).toEqual([
      "tray.usage.metric:spend",
      "tray.usage.metric:tokens",
      "tray.usage.metric:quota",
    ])
    expect(metrics.find((r) => r.id === "tray.usage.metric:spend")).toMatchObject({ checked: true })
  })

  it("does not offer budget in the menu, where most installs would see a dash", () => {
    const rows = buildUsageSection(usage([account()]), 0, spendDisplay)
    expect(ids(rows)).not.toContain("tray.usage.metric:budget")
  })

  it("checks the active period and offers every declared window", () => {
    const rows = buildUsageSection(usage([account()]), 0, spendDisplay)
    const periods = rows.filter((r) => r.id.startsWith("tray.usage.period:"))
    expect(periods).toHaveLength(USAGE_GLANCE_PERIODS.length)
    expect(periods.find((r) => r.id === "tray.usage.period:7d")).toMatchObject({ checked: true })
  })

  it("disables period and scope under quota, where the window is the provider's", () => {
    const rows = buildUsageSection(usage([account()]), 0, {
      ...spendDisplay,
      usageMetric: "quota",
    })
    const period = rows.find((r) => r.id === "tray.usage.period:today")
    const scope = rows.find((r) => r.id === "tray.usage.scope:all-tools")
    expect(period).toMatchObject({ disabled: true, payload: { kind: "native", action: "noop" } })
    expect(scope).toMatchObject({ disabled: true })
  })

  it("renders the headline from the projection", () => {
    const rows = buildUsageSection(
      { ...usage([account()]), glance: glance({ knownCostUsd: 4.2, turns: 3 }) },
      0,
      spendDisplay
    )
    expect(rows.find((r) => r.id === "tray.usage.headline")).toMatchObject({
      label: "$4.2",
      disabled: true,
    })
  })

  it("shows a loading row rather than a zero before the first read lands", () => {
    // A zero here is indistinguishable from "you spent nothing", which is the
    // one reading the menu must never accidentally assert.
    const rows = buildUsageSection(usage([account()]), 0, spendDisplay)
    expect(rows.find((r) => r.id === "tray.usage.headline")).toMatchObject({
      label: "tray.usage.loading",
    })
  })

  it("discloses incomplete coverage instead of presenting it as a total", () => {
    const rows = buildUsageSection(
      {
        ...usage([account()]),
        glance: glance({ knownCostUsd: 1, turns: 1, freshness: "partial" }),
      },
      0,
      spendDisplay
    )
    expect(rows.find((r) => r.id === "tray.usage.freshness")).toMatchObject({
      label: "tray.usage.freshness.partial",
    })
  })

  it("adds no freshness row when the answer is complete", () => {
    const rows = buildUsageSection(
      { ...usage([account()]), glance: glance({ knownCostUsd: 1, turns: 1, freshness: "fresh" }) },
      0,
      spendDisplay
    )
    expect(ids(rows)).not.toContain("tray.usage.freshness")
  })

  it("still ends with refresh and settings", () => {
    const rows = buildUsageSection(usage([account()]), 0, spendDisplay)
    expect(ids(rows).slice(-2)).toEqual(["tray.usage.refresh", "tray.usage.open-settings"])
  })

  it("routes every dimension row through a command payload", () => {
    const rows = buildUsageSection(usage([account()]), 0, spendDisplay)
    for (const row of rows) {
      if (!row.id.startsWith("tray.usage.scope:")) continue
      expect(row.payload).toMatchObject({ kind: "command" })
    }
  })
})
