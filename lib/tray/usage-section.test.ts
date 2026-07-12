import {
  buildUsageSection,
  USAGE_REFRESH_COMMAND,
  USAGE_SELECT_COMMAND_PREFIX,
} from "./usage-section"
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
