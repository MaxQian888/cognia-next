import { act, renderHook } from "@testing-library/react"

import { NO_RUNNING_WORKFLOWS, summarizeRunningWorkflows } from "@/lib/glance/build-fleet"
import { normalizeGlancePanelSettings } from "@/lib/glance/presets"
import type { GlanceFleetWorkflows, GlanceQuotaSlice } from "@/lib/glance/snapshot"
import type { GlanceModuleId } from "@/types/glance/layout"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/hooks/usage/use-cost-budget-status", () => ({ useCostBudgetStatus: jest.fn() }))
jest.mock("@/hooks/usage/use-usage-glance", () => ({ useUsageGlance: jest.fn() }))
jest.mock("@/lib/chat/session-exposure", () => ({
  filterExposedSessions: jest.fn((rows: unknown[]) => rows),
}))
jest.mock("@/lib/db/schema", () => ({ getDb: jest.fn() }))
jest.mock("@/lib/db/sessions", () => ({
  listWorkspaceSessionIds: jest.fn(),
  listWorkspaceSessions: jest.fn(),
}))
jest.mock("@/lib/glance/build-pet", () => ({
  buildPetSlice: jest.fn(() => ({ marker: "pet-slice" })),
}))
jest.mock("@/lib/island/projection-store", () => ({
  getIslandProjection: jest.fn(() => null),
  getIslandProjectionServerSnapshot: jest.fn(() => null),
  subscribeIslandProjection: jest.fn(() => () => {}),
}))
jest.mock("@/lib/tray/state-snapshot", () => ({ useTrayStateSnapshot: jest.fn() }))
jest.mock("@/stores/chat", () => {
  const state = { activeSessionId: null as string | null }
  return {
    useChatStore: Object.assign(
      jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
      { getState: () => state }
    ),
  }
})
jest.mock("@/stores/project/project-store", () => {
  const state = {
    activeProjectId: null as string | null,
    projects: [] as Array<{ id: string; name: string }>,
  }
  return {
    useProjectStore: Object.assign(
      jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
      { getState: () => state }
    ),
  }
})
jest.mock("@/stores/settings", () => {
  const state = { settings: {} as Record<string, unknown> | null }
  return {
    useSettingsStore: Object.assign(
      jest.fn((selector: (s: typeof state) => unknown) => selector(state)),
      { getState: () => state }
    ),
  }
})
jest.mock("./use-glance-activity", () => ({ useGlanceActivity: jest.fn() }))
jest.mock("./use-glance-agenda", () => ({ useGlanceAgenda: jest.fn() }))
jest.mock("./use-glance-quota", () => ({ useGlanceQuota: jest.fn() }))

import { useLiveQuery } from "dexie-react-hooks"

import { useCostBudgetStatus } from "@/hooks/usage/use-cost-budget-status"
import { useUsageGlance } from "@/hooks/usage/use-usage-glance"
import { filterExposedSessions } from "@/lib/chat/session-exposure"
import { getDb } from "@/lib/db/schema"
import { listWorkspaceSessionIds, listWorkspaceSessions } from "@/lib/db/sessions"
import { buildPetSlice } from "@/lib/glance/build-pet"
import { getIslandProjection } from "@/lib/island/projection-store"
import { useTrayStateSnapshot } from "@/lib/tray/state-snapshot"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useSettingsStore } from "@/stores/settings"

import { useGlanceActivity } from "./use-glance-activity"
import { useGlanceAgenda } from "./use-glance-agenda"
import { useGlanceQuota } from "./use-glance-quota"
import { resolveTrayPanelActions } from "@/lib/tray-panel/catalogue"
import { DEFAULT_TRAY_PANEL_ACTIONS } from "@/lib/tray-panel/defaults"
import type { TrayPanelAction } from "@/lib/tray-panel/types"

import { GLANCE_TICK_MS, useGlanceSources } from "./use-glance-sources"

const useLiveQueryMock = useLiveQuery as unknown as jest.Mock
const budgetMock = useCostBudgetStatus as jest.Mock
const usageGlanceMock = useUsageGlance as jest.Mock
const exposedMock = filterExposedSessions as jest.Mock
const getDbMock = getDb as unknown as jest.Mock
const workspaceIdsMock = listWorkspaceSessionIds as jest.Mock
const workspaceSessionsMock = listWorkspaceSessions as jest.Mock
const petSliceMock = buildPetSlice as jest.Mock
const islandMock = getIslandProjection as jest.Mock
const trayMock = useTrayStateSnapshot as jest.Mock
const activityMock = useGlanceActivity as jest.Mock
const agendaMock = useGlanceAgenda as jest.Mock
const quotaMock = useGlanceQuota as jest.Mock

const chatState = (
  useChatStore as unknown as { getState: () => { activeSessionId: string | null } }
).getState()
const projectState = (
  useProjectStore as unknown as {
    getState: () => {
      activeProjectId: string | null
      projects: Array<{ id: string; name: string }>
    }
  }
).getState()
const settingsState = (
  useSettingsStore as unknown as { getState: () => { settings: Record<string, unknown> | null } }
).getState()

type LiveKind = "ids" | "workflows" | "recents" | "pet"

/**
 * Which of the hook's live queries a `useLiveQuery(fn, deps, fallback)` call
 * is, from its shape: recents fall back to an array, the running workflows to
 * the empty summary, the pet profile has two deps, the workspace's session
 * ids three.
 */
function liveKind(args: readonly unknown[]): LiveKind {
  const [, deps, fallback] = args
  if (Array.isArray(fallback)) return "recents"
  if (fallback !== null && typeof fallback === "object") return "workflows"
  return (deps as unknown[]).length === 2 ? "pet" : "ids"
}

const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime()

const QUOTA_SLICE: GlanceQuotaSlice = { updatedAt: NOW, refreshing: false, sources: [] }
const AGENDA_SLICE = { marker: "agenda" }
const ACTIVITY_SLICE = { marker: "activity" }

const ALL_MODULES = ["fleet", "usage", "quota", "agenda", "activity", "recents", "pet"] as const

/** A layout with exactly these modules visible (the rest are appended hidden). */
function layoutWith(visible: readonly GlanceModuleId[], extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    preset: "custom",
    entries: visible.map((id) => ({ id, size: "standard", hidden: false })),
    ...extra,
  }
}

describe("useGlanceSources", () => {
  const refreshAll = jest.fn()
  const refreshOne = jest.fn()
  const enable = jest.fn()
  const refreshUsage = jest.fn()
  let liveSessionIds: string[] | null
  let liveRecentRows: unknown[]
  let livePetProfile: unknown
  let liveWorkflows: GlanceFleetWorkflows
  let usageGlanceValue: unknown

  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(NOW)
    jest.clearAllMocks()
    liveSessionIds = null
    liveRecentRows = []
    livePetProfile = null
    usageGlanceValue = null
    liveWorkflows = NO_RUNNING_WORKFLOWS
    // Answer each live query by what it is, not by call order.
    useLiveQueryMock.mockImplementation((...args: unknown[]) => {
      const kind = liveKind(args)
      if (kind === "ids") return liveSessionIds
      if (kind === "workflows") return liveWorkflows
      if (kind === "recents") return liveRecentRows
      return livePetProfile
    })
    budgetMock.mockReturnValue({ worst: null })
    usageGlanceMock.mockImplementation(() => ({
      snapshot: usageGlanceValue,
      refresh: refreshUsage,
    }))
    trayMock.mockReturnValue({ running: false, marker: "tray", usage: { stale: true } })
    activityMock.mockImplementation((enabled: boolean) => (enabled ? ACTIVITY_SLICE : null))
    agendaMock.mockImplementation((enabled: boolean) => (enabled ? AGENDA_SLICE : null))
    quotaMock.mockImplementation((enabled: boolean) => ({
      slice: enabled ? QUOTA_SLICE : null,
      refreshAll,
      refreshOne,
      enable,
    }))
    islandMock.mockReturnValue(null)
    exposedMock.mockImplementation((rows: unknown[]) => rows)
    petSliceMock.mockReturnValue({ marker: "pet-slice" })
    chatState.activeSessionId = null
    projectState.activeProjectId = null
    projectState.projects = []
    settingsState.settings = { trayPanelLayout: layoutWith(ALL_MODULES) }
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function render(active: boolean) {
    return renderHook(({ on }: { on: boolean }) => useGlanceSources(on), {
      initialProps: { on: active },
    })
  }

  function lastLive() {
    const last = (kind: LiveKind) => {
      const call = [...useLiveQueryMock.mock.calls].reverse().find((c) => liveKind(c) === kind)
      if (!call) throw new Error(`no ${kind} live query`)
      return { run: call[0] as () => Promise<unknown>, deps: call[1] as unknown[] }
    }
    return {
      ids: last("ids"),
      workflows: last("workflows"),
      recents: last("recents"),
      pet: last("pet"),
    }
  }

  function enabledFlags() {
    return {
      usage: usageGlanceMock.mock.calls.at(-1)?.[0].enabled,
      quota: quotaMock.mock.calls.at(-1)?.[0],
      agenda: agendaMock.mock.calls.at(-1)?.[0],
      activity: activityMock.mock.calls.at(-1)?.[0],
    }
  }

  describe("inactive", () => {
    it("builds a body with every slice null and enables nothing expensive", () => {
      const { result } = render(false)
      expect(result.current.body).toMatchObject({
        fleet: null,
        usage: null,
        quota: null,
        agenda: null,
        activity: null,
        recents: null,
        pet: null,
      })
      expect(enabledFlags()).toEqual({ usage: false, quota: false, agenda: false, activity: false })
      expect(petSliceMock).not.toHaveBeenCalled()
    })

    it("still reads the layout, workspace and when state", () => {
      projectState.activeProjectId = "p1"
      projectState.projects = [{ id: "p1", name: "Project One" }]
      const { result } = render(false)
      expect(result.current.body.config.entries.map((e) => e.id)).toContain("fleet")
      expect(result.current.body.workspace).toEqual({ id: "p1", name: "Project One" })
      expect(result.current.body.when).toMatchObject({ marker: "tray", usage: null })
    })

    it("runs none of the live queries' reads", async () => {
      settingsState.settings = {
        trayPanelLayout: layoutWith(ALL_MODULES, { scope: "workspace" }),
        petSettings: { enabled: true },
      }
      projectState.activeProjectId = "p1"
      projectState.projects = [{ id: "p1", name: "P" }]
      getDbMock.mockReturnValue({})
      render(false)
      const live = lastLive()
      await expect(live.ids.run()).resolves.toBeNull()
      await expect(live.recents.run()).resolves.toEqual([])
      await expect(live.pet.run()).resolves.toBeNull()
      expect(workspaceIdsMock).not.toHaveBeenCalled()
      expect(workspaceSessionsMock).not.toHaveBeenCalled()
      expect(getDbMock).not.toHaveBeenCalled()
    })

    it("does not tick the clock", () => {
      const { result } = render(false)
      const first = result.current.body.generatedAt
      act(() => {
        jest.setSystemTime(NOW + 5 * GLANCE_TICK_MS)
        jest.advanceTimersByTime(5 * GLANCE_TICK_MS)
      })
      expect(result.current.body.generatedAt).toBe(first)
      expect(first).toBe(NOW)
    })
  })

  describe("module visibility", () => {
    it("computes every slice when all modules are visible", () => {
      islandMock.mockReturnValue({
        generatedAt: NOW - 1,
        rows: [
          { id: "r1", title: "Task", status: "blocked", startedAt: 1, updatedAt: 2 },
          { id: "r2", title: "Other", status: "working", startedAt: 1, updatedAt: 2 },
        ],
      })
      settingsState.settings = {
        trayPanelLayout: layoutWith(ALL_MODULES),
        petSettings: { enabled: true },
      }
      const { result } = render(true)
      const { body } = result.current
      expect(body.fleet).toMatchObject({ total: 2, counts: { working: 1, awaiting: 1, failed: 0 } })
      expect(body.usage).toMatchObject({
        scope: "cognia",
        showSpend: false,
        workspaceFiltered: false,
      })
      expect(body.quota).toBe(QUOTA_SLICE)
      expect(body.agenda).toBe(AGENDA_SLICE)
      expect(body.activity).toBe(ACTIVITY_SLICE)
      expect(body.recents).toMatchObject({ rows: [] })
      expect(body.pet).toEqual({ marker: "pet-slice" })
      expect(enabledFlags()).toEqual({ usage: true, quota: true, agenda: true, activity: true })
    })

    it("with the default layout shows fleet, usage, quota, agenda, activity but not recents or pet", () => {
      settingsState.settings = {}
      const { result } = render(true)
      const { body } = result.current
      expect(body.fleet).not.toBeNull()
      expect(body.usage).not.toBeNull()
      expect(body.quota).toBe(QUOTA_SLICE)
      expect(body.agenda).toBe(AGENDA_SLICE)
      expect(body.activity).toBe(ACTIVITY_SLICE)
      expect(body.recents).toBeNull()
      expect(body.pet).toBeNull()
    })

    it("falls back to the default layout when settings are not loaded", () => {
      settingsState.settings = null
      const { result } = render(true)
      expect(result.current.body.config.preset).toBe("balanced")
      expect(result.current.body.fleet).not.toBeNull()
    })

    it.each(ALL_MODULES)("hiding everything but %s computes only that module", (only) => {
      settingsState.settings = {
        trayPanelLayout: layoutWith([only]),
        petSettings: { enabled: true },
      }
      const { result } = render(true)
      const { body } = result.current
      expect(body.fleet !== null).toBe(only === "fleet")
      expect(body.usage !== null).toBe(only === "usage")
      expect(body.quota !== null).toBe(only === "quota")
      expect(body.agenda !== null).toBe(only === "agenda")
      expect(body.activity !== null).toBe(only === "activity")
      expect(body.recents !== null).toBe(only === "recents")
      expect(body.pet !== null).toBe(only === "pet")
      expect(enabledFlags()).toEqual({
        usage: only === "usage",
        quota: only === "quota",
        agenda: only === "agenda",
        activity: only === "activity",
      })
    })

    it("hiding usage nulls the slice and disables the usage hook", () => {
      settingsState.settings = {
        trayPanelLayout: layoutWith(ALL_MODULES.filter((id) => id !== "usage")),
      }
      const { result } = render(true)
      expect(result.current.body.usage).toBeNull()
      expect(usageGlanceMock.mock.calls.at(-1)?.[0].enabled).toBe(false)
      expect(result.current.body.fleet).not.toBeNull()
    })

    it("a hidden entry in the stored layout is not computed", () => {
      settingsState.settings = {
        trayPanelLayout: {
          version: 1,
          preset: "custom",
          entries: [
            { id: "fleet", size: "standard", hidden: true },
            { id: "usage", size: "standard", hidden: false },
          ],
        },
      }
      const { result } = render(true)
      expect(result.current.body.fleet).toBeNull()
      expect(result.current.body.usage).not.toBeNull()
    })

    it("turns slices on and off as the layout changes", () => {
      settingsState.settings = { trayPanelLayout: layoutWith(["usage"]) }
      const { result, rerender } = render(true)
      expect(result.current.body.activity).toBeNull()

      settingsState.settings = { trayPanelLayout: layoutWith(["usage", "activity"]) }
      rerender({ on: true })
      expect(result.current.body.activity).toBe(ACTIVITY_SLICE)
    })

    it("the quick module has no slice of its own", () => {
      settingsState.settings = { trayPanelLayout: layoutWith(["quick"]) }
      const { result } = render(true)
      const { body } = result.current
      expect([
        body.fleet,
        body.usage,
        body.quota,
        body.agenda,
        body.activity,
        body.recents,
        body.pet,
      ]).toEqual(Array(7).fill(null))
    })
  })

  describe("config and options", () => {
    it("passes the normalized config through", () => {
      settingsState.settings = {
        trayPanelLayout: layoutWith(["usage"], { width: "wide", maxHeight: 500, scope: "all" }),
      }
      const { result } = render(true)
      expect(result.current.body.config).toMatchObject({
        width: "wide",
        maxHeight: 500,
        scope: "all",
      })
    })

    it("queries 30 days of tokens in the chosen usage scope and passes the budget", () => {
      settingsState.settings = {
        trayPanelLayout: layoutWith(["usage"], {
          options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1y" } },
        }),
      }
      budgetMock.mockReturnValue({
        worst: { ratio: 1.2, target: "month-target", period: "month", level: "exceeded" },
      })
      const { result } = render(true)
      const args = usageGlanceMock.mock.calls.at(-1)?.[0]
      expect(args.query).toEqual({ period: "30d", scope: "all-tools", metric: "tokens" })
      expect(args.budget).toEqual({
        ratio: 1.2,
        target: "month-target",
        period: "month",
        blocked: true,
      })
      expect(result.current.body.usage).toMatchObject({ scope: "all-tools", showSpend: true })
    })

    it("passes no budget when nothing is near a limit, and marks only exceeded as blocked", () => {
      render(true)
      expect(usageGlanceMock.mock.calls.at(-1)?.[0].budget).toBeNull()

      budgetMock.mockReturnValue({
        worst: { ratio: 0.9, target: "t", period: "day", level: "warn" },
      })
      render(true)
      expect(usageGlanceMock.mock.calls.at(-1)?.[0].budget).toMatchObject({ blocked: false })
    })

    it("hands the activity hook its range, the usage scope and the session filter", () => {
      settingsState.settings = {
        trayPanelLayout: layoutWith(["activity"], {
          options: { usage: { scope: "all-tools", showSpend: false }, activity: { range: "1y" } },
        }),
      }
      render(true)
      const args = activityMock.mock.calls.at(-1)!
      expect(args[0]).toBe(true)
      expect(args[1]).toBe("1y")
      expect(args[2]).toBe("all-tools")
      expect(args[3]).toBeNull()
      expect(args[4]).toBe(NOW)
    })

    it("builds the usage slice from the glance snapshot", () => {
      usageGlanceValue = {
        generatedAt: NOW - 50,
        freshness: "stale",
        daily: [],
        topModels: [{ id: "model-a", tokens: 10, knownCostUsd: 1 }],
        topProviders: [
          { id: "p1", tokens: 30, knownCostUsd: 3 },
          { id: "p2", tokens: 10, knownCostUsd: 1 },
        ],
        billableTokens: 40,
        knownCostUsd: 4,
        turns: 9,
        unpricedTurns: 2,
        budget: null,
      }
      settingsState.settings = { trayPanelLayout: layoutWith(["usage"]) }
      const { result } = render(true)
      expect(result.current.body.usage).toMatchObject({
        updatedAt: NOW - 50,
        freshness: "stale",
        month: { tokens: 40, knownCostUsd: 4, turns: 9 },
        unpricedTurns: 2,
        topModel: { id: "model-a" },
      })
      expect(result.current.body.usage?.providers.map((p) => p.share)).toEqual([0.75, 0.25])
    })

    it("exposes the quota result and refreshUsage", async () => {
      const { result } = render(true)
      expect(result.current.refreshUsage).toBe(refreshUsage)
      expect(result.current.quota.refreshAll).toBe(refreshAll)
      expect(result.current.quota.refreshOne).toBe(refreshOne)
      expect(result.current.quota.enable).toBe(enable)
    })
  })

  describe("workspace", () => {
    function scopeToWorkspace(scope: "workspace" | "all" = "workspace") {
      settingsState.settings = { trayPanelLayout: layoutWith(ALL_MODULES, { scope }) }
      projectState.activeProjectId = "p1"
      projectState.projects = [
        { id: "p0", name: "Zero" },
        { id: "p1", name: "One" },
      ]
    }

    it("resolves the active project as the workspace", () => {
      scopeToWorkspace("all")
      const { result } = render(true)
      expect(result.current.body.workspace).toEqual({ id: "p1", name: "One" })
    })

    it("has no workspace when the active project is unknown", () => {
      projectState.activeProjectId = "missing"
      projectState.projects = [{ id: "p1", name: "One" }]
      const { result } = render(true)
      expect(result.current.body.workspace).toBeNull()
    })

    it("lists the workspace's sessions via listWorkspaceSessionIds when scoped", async () => {
      scopeToWorkspace()
      workspaceIdsMock.mockResolvedValue(["s1", "s2"])
      render(true)
      const { ids } = lastLive()
      expect(ids.deps).toEqual([true, true, "p1"])
      await expect(ids.run()).resolves.toEqual(["s1", "s2"])
      expect(workspaceIdsMock).toHaveBeenCalledWith("p1")
    })

    it("filters usage and activity to an empty set until the first read lands", () => {
      scopeToWorkspace()
      liveSessionIds = null
      const { result } = render(true)
      const usageFilter = usageGlanceMock.mock.calls.at(-1)?.[0].sessionFilter as Set<string>
      expect(usageFilter).toBeInstanceOf(Set)
      expect(usageFilter.size).toBe(0)
      expect((activityMock.mock.calls.at(-1)![3] as Set<string>).size).toBe(0)
      expect(result.current.body.usage?.workspaceFiltered).toBe(true)
    })

    it("filters usage and activity to the workspace's sessions once read", () => {
      scopeToWorkspace()
      liveSessionIds = ["s1", "s2"]
      render(true)
      expect([...(usageGlanceMock.mock.calls.at(-1)?.[0].sessionFilter as Set<string>)]).toEqual([
        "s1",
        "s2",
      ])
      expect([...(activityMock.mock.calls.at(-1)![3] as Set<string>)]).toEqual(["s1", "s2"])
    })

    it("applies no filter when the scope is all", () => {
      scopeToWorkspace("all")
      const { result } = render(true)
      expect(usageGlanceMock.mock.calls.at(-1)?.[0].sessionFilter).toBeNull()
      expect(activityMock.mock.calls.at(-1)![3]).toBeNull()
      expect(result.current.body.usage?.workspaceFiltered).toBe(false)
      expect(lastLive().ids.deps).toEqual([true, false, "p1"])
    })

    it("does not scope when the layout asks for a workspace but none is active", async () => {
      settingsState.settings = { trayPanelLayout: layoutWith(ALL_MODULES, { scope: "workspace" }) }
      const { result } = render(true)
      expect(usageGlanceMock.mock.calls.at(-1)?.[0].sessionFilter).toBeNull()
      expect(result.current.body.usage?.workspaceFiltered).toBe(false)
      await expect(lastLive().ids.run()).resolves.toBeNull()
      expect(workspaceIdsMock).not.toHaveBeenCalled()
    })

    it("reads recents from the workspace's sessions, capped at the scan size", async () => {
      scopeToWorkspace()
      const rows = Array.from({ length: 60 }, (_, i) => ({
        id: `s${i}`,
        title: `T${i}`,
        updatedAt: i,
        archivedAt: undefined,
      }))
      workspaceSessionsMock.mockResolvedValue(rows)
      render(true)
      const { recents } = lastLive()
      expect(recents.deps).toEqual([true, true, "p1"])
      const out = (await recents.run()) as Array<{ id: string }>
      expect(workspaceSessionsMock).toHaveBeenCalledWith("p1")
      expect(out).toHaveLength(40)
      expect(out[0].id).toBe("s0")
    })
  })

  describe("recents", () => {
    it("reads a bounded newest-first window globally and maps archivedAt to null", async () => {
      const toArray = jest.fn().mockResolvedValue([
        { id: "a", title: "A", updatedAt: 5 },
        { id: "b", title: "B", updatedAt: 4, archivedAt: 3 },
      ])
      const limit = jest.fn(() => ({ toArray }))
      const reverse = jest.fn(() => ({ limit }))
      const orderBy = jest.fn(() => ({ reverse }))
      getDbMock.mockReturnValue({ sessions: { orderBy } })
      render(true)
      const { recents } = lastLive()
      expect(recents.deps).toEqual([true, false, undefined])
      await expect(recents.run()).resolves.toEqual([
        { id: "a", title: "A", updatedAt: 5, archivedAt: null },
        { id: "b", title: "B", updatedAt: 4, archivedAt: 3 },
      ])
      expect(orderBy).toHaveBeenCalledWith("updatedAt")
      expect(limit).toHaveBeenCalledWith(40)
      expect(exposedMock).toHaveBeenCalledWith(expect.any(Array), "main-list")
    })

    it("keeps only exposed conversations", async () => {
      const toArray = jest.fn().mockResolvedValue([
        { id: "a", title: "A", updatedAt: 5 },
        { id: "hidden", title: "H", updatedAt: 4 },
      ])
      getDbMock.mockReturnValue({
        sessions: { orderBy: () => ({ reverse: () => ({ limit: () => ({ toArray }) }) }) },
      })
      exposedMock.mockImplementation((rows: Array<{ id: string }>) =>
        rows.filter((r) => r.id !== "hidden")
      )
      render(true)
      const out = (await lastLive().recents.run()) as Array<{ id: string }>
      expect(out.map((r) => r.id)).toEqual(["a"])
    })

    it("builds the slice without the conversation already on screen or archived ones", () => {
      chatState.activeSessionId = "on-screen"
      liveRecentRows = [
        { id: "on-screen", title: "Current", updatedAt: 10, archivedAt: null },
        { id: "old", title: "Older", updatedAt: 5, archivedAt: null },
        { id: "new", title: "Newer", updatedAt: 9, archivedAt: null },
        { id: "gone", title: "Archived", updatedAt: 8, archivedAt: 1 },
      ]
      settingsState.settings = { trayPanelLayout: layoutWith(["recents"]) }
      const { result } = render(true)
      expect(result.current.body.recents?.rows.map((r) => r.id)).toEqual(["new", "old"])
    })
  })

  describe("pet", () => {
    it("reads the global pet profile only when the module and the pet are enabled", async () => {
      settingsState.settings = {
        trayPanelLayout: layoutWith(["pet"]),
        petSettings: { enabled: true },
      }
      const get = jest.fn().mockResolvedValue({ marker: "profile" })
      getDbMock.mockReturnValue({ petProfile: { get } })
      render(true)
      const { pet } = lastLive()
      expect(pet.deps).toEqual([true, true])
      await expect(pet.run()).resolves.toEqual({ marker: "profile" })
      expect(get).toHaveBeenCalledWith("global")
    })

    it("resolves null for a missing profile", async () => {
      settingsState.settings = {
        trayPanelLayout: layoutWith(["pet"]),
        petSettings: { enabled: true },
      }
      getDbMock.mockReturnValue({ petProfile: { get: jest.fn().mockResolvedValue(undefined) } })
      render(true)
      await expect(lastLive().pet.run()).resolves.toBeNull()
    })

    it("does not read the profile when the pet is disabled", async () => {
      settingsState.settings = {
        trayPanelLayout: layoutWith(["pet"]),
        petSettings: { enabled: false },
      }
      render(true)
      const { pet } = lastLive()
      expect(pet.deps).toEqual([true, false])
      await expect(pet.run()).resolves.toBeNull()
      expect(getDbMock).not.toHaveBeenCalled()
    })

    it("builds the pet slice from the enabled flag, the profile and the clock", () => {
      settingsState.settings = {
        trayPanelLayout: layoutWith(["pet"]),
        petSettings: { enabled: true },
      }
      livePetProfile = { marker: "profile" }
      render(true)
      expect(petSliceMock).toHaveBeenLastCalledWith(true, { marker: "profile" }, NOW)
    })

    it("builds a disabled pet slice when the pet setting is off", () => {
      settingsState.settings = { trayPanelLayout: layoutWith(["pet"]) }
      render(true)
      expect(petSliceMock).toHaveBeenLastCalledWith(false, null, NOW)
    })
  })

  describe("clock", () => {
    it("re-reads the time on becoming active, then ticks every GLANCE_TICK_MS", () => {
      const { result, rerender } = render(false)
      expect(result.current.body.generatedAt).toBe(NOW)

      jest.setSystemTime(NOW + 3_600_000)
      rerender({ on: true })
      act(() => {
        jest.advanceTimersByTime(0)
      })
      expect(result.current.body.generatedAt).toBe(NOW + 3_600_000)

      // Advancing fake timers moves the fake clock with them.
      act(() => {
        jest.advanceTimersByTime(GLANCE_TICK_MS)
      })
      expect(result.current.body.generatedAt).toBe(NOW + 3_600_000 + GLANCE_TICK_MS)
    })

    it("hands the clock to the quota, agenda and activity hooks", () => {
      render(true)
      expect(quotaMock.mock.calls.at(-1)![1]).toBe(NOW)
      expect(agendaMock.mock.calls.at(-1)![1]).toBe(NOW)
      expect(activityMock.mock.calls.at(-1)![4]).toBe(NOW)
    })

    it("stops ticking when it goes inactive", () => {
      const { result, rerender } = render(true)
      rerender({ on: false })
      jest.setSystemTime(NOW + 10 * GLANCE_TICK_MS)
      const before = result.current.body.generatedAt
      act(() => {
        jest.advanceTimersByTime(10 * GLANCE_TICK_MS)
      })
      expect(result.current.body.generatedAt).toBe(before)
    })
  })

  describe("when", () => {
    it("is the tray state with the usage field cleared", () => {
      trayMock.mockReturnValue({ running: true, marker: "tray", usage: { stale: false } })
      const { result } = render(true)
      expect(result.current.body.when).toEqual({ running: true, marker: "tray", usage: null })
    })
  })

  describe("actions", () => {
    const custom: TrayPanelAction = {
      id: "mine",
      label: "Mine",
      fields: [],
      trigger: { kind: "manual" },
      effect: { kind: "navigate", path: "/x" },
    }

    it("carries the shipped catalogue when settings store none", () => {
      const { result } = render(true)
      expect(result.current.body.actions).toEqual(DEFAULT_TRAY_PANEL_ACTIONS)
    })

    it("carries the shipped catalogue when settings are not loaded", () => {
      settingsState.settings = null
      const { result } = render(true)
      expect(result.current.body.actions).toEqual(DEFAULT_TRAY_PANEL_ACTIONS)
    })

    it("resolves the stored catalogue, backfilling built-ins and dropping malformed entries", () => {
      const stored = [custom, { id: "", label: "bad" }, { ...custom }]
      settingsState.settings = {
        trayPanelLayout: layoutWith(ALL_MODULES),
        trayPanelActions: stored,
      }
      const { result } = render(true)
      expect(result.current.body.actions).toEqual(resolveTrayPanelActions(stored))
      const ids = result.current.body.actions.map((a) => a.id)
      expect(ids.filter((id) => id === "mine")).toHaveLength(1)
      expect(ids).toContain("trayPanel.delegate")
    })

    it("is carried while inactive too, since a consumer needs it before anything else", () => {
      settingsState.settings = {
        trayPanelLayout: layoutWith(ALL_MODULES),
        trayPanelActions: [custom],
      }
      const { result } = render(false)
      expect(result.current.body.actions.map((a) => a.id)).toContain("mine")
    })
  })

  describe("passive", () => {
    it("is not passive by default", () => {
      render(true)
      expect(quotaMock.mock.calls.at(-1)![2]).toEqual({ passive: false })
    })

    it("forwards passive: true to the quota hook as its third argument", () => {
      renderHook(() => useGlanceSources(true, { passive: true }))
      const call = quotaMock.mock.calls.at(-1)!
      expect(call[0]).toBe(true)
      expect(call[1]).toBe(NOW)
      expect(call[2]).toEqual({ passive: true })
    })

    it("forwards an explicit passive: false", () => {
      renderHook(() => useGlanceSources(true, { passive: false }))
      expect(quotaMock.mock.calls.at(-1)![2]).toEqual({ passive: false })
    })
  })

  describe("body identity", () => {
    it("is stable across re-renders with unchanged inputs", () => {
      const { result, rerender } = render(true)
      const first = result.current.body
      rerender({ on: true })
      expect(result.current.body).toBe(first)
    })
  })
  describe("config override", () => {
    it("builds for the given layout instead of the stored tray layout", () => {
      settingsState.settings = { trayPanelLayout: layoutWith(["usage", "quota"]) }
      const config = normalizeGlancePanelSettings(
        layoutWith(["activity", "pet"], {
          scope: "all",
          options: { usage: { scope: "all-tools", showSpend: true }, activity: { range: "1m" } },
        })
      )
      const { result } = renderHook(() => useGlanceSources(true, { config }))
      const { body } = result.current
      expect(body.config).toBe(config)
      expect(body.usage).toBeNull()
      expect(body.quota).toBeNull()
      expect(body.activity).toBe(ACTIVITY_SLICE)
      expect(body.pet).not.toBeNull()
      expect(activityMock.mock.calls.at(-1)![1]).toBe("1m")
      expect(activityMock.mock.calls.at(-1)![2]).toBe("all-tools")
    })

    it("falls back to the stored layout for a null override", () => {
      settingsState.settings = { trayPanelLayout: layoutWith(["usage"]) }
      const { result } = renderHook(() => useGlanceSources(true, { config: null }))
      expect(result.current.body.config.entries.filter((e) => !e.hidden).map((e) => e.id)).toEqual([
        "usage",
      ])
      expect(result.current.body.usage).not.toBeNull()
    })

    it("still carries the stored action catalogue", () => {
      const config = normalizeGlancePanelSettings(layoutWith(["quick"]))
      const { result } = renderHook(() => useGlanceSources(false, { config }))
      expect(result.current.body.actions).toEqual(DEFAULT_TRAY_PANEL_ACTIONS)
    })
  })

  describe("workspace override", () => {
    beforeEach(() => {
      projectState.activeProjectId = "p1"
      projectState.projects = [
        { id: "p1", name: "One" },
        { id: "p2", name: "Two" },
      ]
      settingsState.settings = { trayPanelLayout: layoutWith(ALL_MODULES, { scope: "workspace" }) }
    })

    it("scopes to the named project instead of the active one", async () => {
      workspaceIdsMock.mockResolvedValue(["s9"])
      const { result } = renderHook(() => useGlanceSources(true, { workspaceId: "p2" }))
      expect(result.current.body.workspace).toEqual({ id: "p2", name: "Two" })
      const { ids } = lastLive()
      expect(ids.deps).toEqual([true, true, "p2"])
      await expect(ids.run()).resolves.toEqual(["s9"])
      expect(workspaceIdsMock).toHaveBeenCalledWith("p2")
      expect(result.current.body.usage?.workspaceFiltered).toBe(true)
    })

    it("is unscoped for an unknown project", () => {
      const { result } = renderHook(() => useGlanceSources(true, { workspaceId: "nope" }))
      expect(result.current.body.workspace).toBeNull()
      expect(usageGlanceMock.mock.calls.at(-1)?.[0].sessionFilter).toBeNull()
      expect(result.current.body.usage?.workspaceFiltered).toBe(false)
      expect(lastLive().ids.deps).toEqual([true, false, undefined])
    })

    it("is unscoped for an explicit null, even with an active project", () => {
      const { result } = renderHook(() => useGlanceSources(true, { workspaceId: null }))
      expect(result.current.body.workspace).toBeNull()
      expect(result.current.body.usage?.workspaceFiltered).toBe(false)
    })

    it("uses the active project when no override is given", () => {
      const { result } = renderHook(() => useGlanceSources(true, {}))
      expect(result.current.body.workspace).toEqual({ id: "p1", name: "One" })
    })
  })

  describe("fleet workflows", () => {
    function fakeDb(runs: Array<{ workflowId: string; startedAt: number }>, rows: unknown[]) {
      const toArray = jest.fn().mockResolvedValue(runs)
      const equals = jest.fn(() => ({ toArray }))
      const where = jest.fn(() => ({ equals }))
      const bulkGet = jest.fn().mockResolvedValue(rows)
      getDbMock.mockReturnValue({ workflowRuns: { where }, workflows: { bulkGet } })
      return { where, equals, bulkGet }
    }

    it("summarizes the running workflow runs with their workflows' names", async () => {
      settingsState.settings = { trayPanelLayout: layoutWith(["fleet"]) }
      const runs = [
        { workflowId: "wf-a", startedAt: 10 },
        { workflowId: "wf-b", startedAt: 30 },
        { workflowId: "wf-a", startedAt: 20 },
      ]
      const db = fakeDb(runs, [
        { id: "wf-a", name: "Alpha" },
        { id: "wf-b", name: "Beta" },
      ])
      render(true)
      const { workflows } = lastLive()
      expect(workflows.deps).toEqual([true])
      const out = await workflows.run()
      expect(db.where).toHaveBeenCalledWith("status")
      expect(db.equals).toHaveBeenCalledWith("running")
      expect(db.bulkGet).toHaveBeenCalledWith(["wf-a", "wf-b"])
      expect(out).toEqual(
        summarizeRunningWorkflows(
          runs,
          new Map([
            ["wf-a", "Alpha"],
            ["wf-b", "Beta"],
          ])
        )
      )
      expect(out).toMatchObject({ running: 3, latest: { workflowId: "wf-b", name: "Beta" } })
    })

    it("falls back to the workflow id for a deleted workflow", async () => {
      settingsState.settings = { trayPanelLayout: layoutWith(["fleet"]) }
      fakeDb([{ workflowId: "wf-gone", startedAt: 5 }], [undefined])
      render(true)
      await expect(lastLive().workflows.run()).resolves.toMatchObject({
        running: 1,
        latest: { workflowId: "wf-gone", name: "wf-gone" },
      })
    })

    it("answers the empty summary without reading names when nothing runs", async () => {
      settingsState.settings = { trayPanelLayout: layoutWith(["fleet"]) }
      const db = fakeDb([], [])
      render(true)
      await expect(lastLive().workflows.run()).resolves.toBe(NO_RUNNING_WORKFLOWS)
      expect(db.bulkGet).not.toHaveBeenCalled()
    })

    it("reads nothing while fleet is off", async () => {
      settingsState.settings = { trayPanelLayout: layoutWith(["usage"]) }
      render(true)
      const { workflows } = lastLive()
      expect(workflows.deps).toEqual([false])
      await expect(workflows.run()).resolves.toBe(NO_RUNNING_WORKFLOWS)
      expect(getDbMock).not.toHaveBeenCalled()
    })

    it("reads nothing while inactive, even with fleet in the layout", async () => {
      render(false)
      const { workflows } = lastLive()
      expect(workflows.deps).toEqual([false])
      await expect(workflows.run()).resolves.toBe(NO_RUNNING_WORKFLOWS)
      expect(getDbMock).not.toHaveBeenCalled()
    })

    it("carries the summary into the fleet slice", () => {
      settingsState.settings = { trayPanelLayout: layoutWith(["fleet"]) }
      liveWorkflows = {
        running: 2,
        latest: { workflowId: "wf-b", name: "Beta", startedAt: 30 },
      }
      const { result } = render(true)
      expect(result.current.body.fleet?.workflows).toEqual(liveWorkflows)
    })

    it("carries the empty summary before the first read lands", () => {
      settingsState.settings = { trayPanelLayout: layoutWith(["fleet"]) }
      const { result } = render(true)
      expect(result.current.body.fleet?.workflows).toEqual(NO_RUNNING_WORKFLOWS)
    })
  })
})
