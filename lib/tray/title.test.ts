/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

import { localDay } from "@/lib/usage/session-analytics"

const glanceMock = jest.fn()
let glanceDaily: unknown[] | null = null
let islandRows: unknown[] | null = null
// useSyncExternalStore needs a stable snapshot per state.
let islandCache: { rows: unknown[] } | null = null
function island() {
  if (!islandRows) return null
  if (!islandCache || islandCache.rows !== islandRows) islandCache = { rows: islandRows }
  return islandCache
}
let budgetWorst: { ratio: number } | null = null
let mainWindow = true
let tauri = true

jest.mock("@/hooks/usage/use-usage-glance", () => ({
  useUsageGlance: (opts: unknown) => {
    glanceMock(opts)
    return { snapshot: glanceDaily ? { daily: glanceDaily } : null, refresh: jest.fn() }
  },
}))
jest.mock("@/hooks/usage/use-cost-budget-status", () => ({
  useCostBudgetStatus: () => ({ worst: budgetWorst }),
}))
jest.mock("@/lib/island/projection-store", () => ({
  subscribeIslandProjection: () => () => {},
  getIslandProjection: () => island(),
  getIslandProjectionServerSnapshot: () => null,
}))
jest.mock("@/lib/pet/window-role", () => ({ isMainAppWindow: () => mainWindow }))
jest.mock("@/lib/tauri", () => ({ isTauri: () => tauri }))

import { fleetTitleCounts, useTrayTitle } from "./title"
import type { TrayTitleField } from "./title-format"
import type { TrayUsageSnapshot } from "./types"

const today = localDay(Date.now())

function display(fields: TrayTitleField[], mode: "off" | "iconBadge" | "title" = "title") {
  return { taskbarUsageMode: mode, titleFields: fields, usageScope: "cognia" as const }
}

const usage: TrayUsageSnapshot = {
  accounts: [
    {
      key: "anthropic:a",
      provider: "anthropic",
      worst: { id: "w", kind: "window", usedPct: 81.6, status: "warn" },
      meters: [],
    },
    {
      key: "codex:b",
      provider: "codex",
      worst: { id: "w", kind: "window", usedPct: 12, status: "ok" },
      meters: [],
    },
  ],
  fetchedAt: 1,
  selectedKey: null,
}

beforeEach(() => {
  glanceMock.mockClear()
  glanceDaily = null
  islandRows = null
  budgetWorst = null
  mainWindow = true
  tauri = true
})

describe("fleetTitleCounts", () => {
  it("counts working and blocked rows and skips stale ones", () => {
    expect(
      fleetTitleCounts([
        { status: "working" },
        { status: "working", stale: true },
        { status: "blocked" },
        { status: "failed" },
        { status: "done" },
      ])
    ).toEqual({ working: 1, awaiting: 1 })
  })

  it("is null without an island", () => {
    expect(fleetTitleCounts(null)).toBeNull()
  })
})

describe("useTrayTitle", () => {
  it("composes every field from its own feed", () => {
    glanceDaily = [{ day: today, tokens: 103_300_000, knownCostUsd: 2, turns: 3, unpricedTurns: 0 }]
    islandRows = [{ status: "working" }, { status: "working" }, { status: "blocked" }]
    budgetWorst = { ratio: 0.5 }
    const { result } = renderHook(() =>
      useTrayTitle(
        display([
          { kind: "usage", period: "1d", metric: "tokens" },
          { kind: "running" },
          { kind: "awaiting" },
          { kind: "quota" },
          { kind: "budget" },
        ]),
        usage
      )
    )
    expect(result.current).toBe("1D 103.3M · ▶2 · ⚑1 · Q 82% · B 50%")
  })

  it("reads the pinned subscription's quota when one is pinned", () => {
    const { result } = renderHook(() =>
      useTrayTitle(display([{ kind: "quota" }]), { ...usage, selectedKey: "codex:b" })
    )
    expect(result.current).toBe("Q 12%")
  })

  it("reads 30 days of usage in the tray's counted scope, only when a usage field is shown", () => {
    renderHook(() =>
      useTrayTitle(
        { ...display([{ kind: "usage", period: "7d", metric: "spend" }]), usageScope: "all-tools" },
        null
      )
    )
    expect(glanceMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        query: { period: "30d", scope: "all-tools", metric: "tokens" },
      })
    )
    glanceMock.mockClear()
    renderHook(() => useTrayTitle(display([{ kind: "running" }]), null))
    expect(glanceMock).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
  })

  it.each([
    ["the readout is not the title", () => {}, "iconBadge" as const],
    [
      "this is not the main window",
      () => {
        mainWindow = false
      },
      "title" as const,
    ],
    [
      "this is not the desktop app",
      () => {
        tauri = false
      },
      "title" as const,
    ],
  ])("is null and reads nothing when %s", (_name, arrange, mode) => {
    arrange()
    islandRows = [{ status: "working" }]
    const { result } = renderHook(() =>
      useTrayTitle(
        display([{ kind: "running" }, { kind: "usage", period: "1d", metric: "tokens" }], mode),
        usage
      )
    )
    expect(result.current).toBeNull()
    expect(glanceMock).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }))
  })

  it("is null when no field has anything to say", () => {
    const { result } = renderHook(() =>
      useTrayTitle(display([{ kind: "running" }, { kind: "quota" }]), null)
    )
    expect(result.current).toBeNull()
  })
})
