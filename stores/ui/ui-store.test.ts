/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import { DEFAULT_BAR_ITEMS, useMemberStatus, useUIStore, type SelectedGuild } from "./ui-store"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import {
  DEFAULT_STATUS_BAR_LAYOUT,
  DEFAULT_TITLE_BAR_LAYOUT,
  STATUS_BAR_ITEMS,
  TITLE_BAR_ITEMS,
} from "@/types/shell/bars"

const RESET = {
  selectedGuild: { kind: "dm" } as SelectedGuild,
  memberStatus: {},
  showMemberList: true,
  scratchpadCollapsed: {},
  stopRequestedFor: {},
  pendingSettingsRequest: null,
  pendingCreateRequest: null,
  guildRailCollapsed: false,
  statusBarCollapsed: false,
  sidebarCollapsed: false,
  sidebarWidth: 256,
  channelListView: "active" as const,
  collapsedFolderIds: [] as string[],
  barItems: { ...DEFAULT_BAR_ITEMS },
  findOpen: false,
}

describe("useUIStore", () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUIStore.setState(RESET)
  })

  describe("selectedGuild", () => {
    it("defaults to direct messages", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.selectedGuild).toEqual({ kind: "dm" })
    })

    it("setSelectedGuild switches between dm / team / canvas", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.setSelectedGuild({ kind: "team", teamId: "t1" }))
      expect(result.current.selectedGuild).toEqual({ kind: "team", teamId: "t1" })
      act(() => result.current.setSelectedGuild({ kind: "canvas" }))
      expect(result.current.selectedGuild).toEqual({ kind: "canvas" })
      act(() => result.current.setSelectedGuild({ kind: "dm" }))
      expect(result.current.selectedGuild).toEqual({ kind: "dm" })
    })

    it("bumps selectedGuildEpoch on every set", () => {
      const { result } = renderHook(() => useUIStore())
      const start = result.current.selectedGuildEpoch
      act(() => result.current.setSelectedGuild({ kind: "team", teamId: "t1" }))
      const afterFirst = result.current.selectedGuildEpoch
      expect(afterFirst).toBeGreaterThan(start)
      act(() => result.current.setSelectedGuild({ kind: "dm" }))
      expect(result.current.selectedGuildEpoch).toBeGreaterThan(afterFirst)
    })
  })

  describe("memberStatus", () => {
    it("setMemberStatus stores the status under the composite key", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.setMemberStatus("ts1", "char-a", "thinking"))
      expect(result.current.memberStatus).toEqual({ "ts1::char-a": "thinking" })
    })

    it("clearMemberStatusFor removes only entries belonging to the given session", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => {
        result.current.setMemberStatus("ts1", "a", "thinking")
        result.current.setMemberStatus("ts1", "b", "errored")
        result.current.setMemberStatus("ts2", "c", "thinking")
      })
      act(() => result.current.clearMemberStatusFor("ts1"))
      expect(result.current.memberStatus).toEqual({ "ts2::c": "thinking" })
    })
  })

  describe("showMemberList", () => {
    it("defaults to true and toggles", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.showMemberList).toBe(true)
      act(() => result.current.setShowMemberList(false))
      expect(result.current.showMemberList).toBe(false)
      act(() => result.current.setShowMemberList(true))
      expect(result.current.showMemberList).toBe(true)
    })
  })

  describe("scratchpadCollapsed", () => {
    it("setScratchpadCollapsed records per-session collapse state", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.setScratchpadCollapsed("ts1", true))
      act(() => result.current.setScratchpadCollapsed("ts2", false))
      expect(result.current.scratchpadCollapsed).toEqual({ ts1: true, ts2: false })
    })
  })

  describe("stop requests", () => {
    it("requestStopMember adds char id and dedupes repeated requests", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.requestStopMember("ts1", "a"))
      act(() => result.current.requestStopMember("ts1", "a")) // duplicate
      expect(result.current.stopRequestedFor).toEqual({ ts1: ["a"] })

      act(() => result.current.requestStopMember("ts1", "b"))
      expect(result.current.stopRequestedFor.ts1).toEqual(["a", "b"])
    })

    it("clearStopRequest filters out the char id", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => {
        result.current.requestStopMember("ts1", "a")
        result.current.requestStopMember("ts1", "b")
      })
      act(() => result.current.clearStopRequest("ts1", "a"))
      expect(result.current.stopRequestedFor).toEqual({ ts1: ["b"] })
    })

    it("clearStopRequest deletes the team-session key when the char list empties", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.requestStopMember("ts1", "only"))
      act(() => result.current.clearStopRequest("ts1", "only"))
      expect(result.current.stopRequestedFor).toEqual({})
    })

    it("clearStopRequest is a no-op when the team session is unknown", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.clearStopRequest("missing", "any"))
      expect(result.current.stopRequestedFor).toEqual({})
    })

    it("clearStopRequest is a no-op when the char id is not in the list", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.requestStopMember("ts1", "a"))
      const before = result.current.stopRequestedFor
      act(() => result.current.clearStopRequest("ts1", "ghost"))
      expect(result.current.stopRequestedFor).toEqual(before)
    })

    it("clearStopRequestsFor removes the team-session key, no-op when absent", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => {
        result.current.requestStopMember("ts1", "a")
        result.current.requestStopMember("ts2", "b")
      })
      act(() => result.current.clearStopRequestsFor("ts1"))
      expect(result.current.stopRequestedFor).toEqual({ ts2: ["b"] })

      // No-op for unknown
      act(() => result.current.clearStopRequestsFor("ts9"))
      expect(result.current.stopRequestedFor).toEqual({ ts2: ["b"] })
    })

    it("isStopRequested returns true / false / false for present / absent / unknown", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.requestStopMember("ts1", "a"))
      expect(result.current.isStopRequested("ts1", "a")).toBe(true)
      expect(result.current.isStopRequested("ts1", "ghost")).toBe(false)
      expect(result.current.isStopRequested("ts9", "a")).toBe(false)
    })
  })

  describe("pendingSettingsRequest", () => {
    it("defaults to null", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.pendingSettingsRequest).toBeNull()
    })

    it("requestOpenSettings increments the nonce and stores the tab", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.requestOpenSettings("api-key"))
      expect(result.current.pendingSettingsRequest).toEqual({
        tab: "api-key",
        nonce: 1,
      })

      act(() => result.current.requestOpenSettings("appearance"))
      expect(result.current.pendingSettingsRequest).toEqual({
        tab: "appearance",
        nonce: 2,
      })
    })

    it("requestOpenSettings without a tab still bumps the nonce", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.requestOpenSettings())
      expect(result.current.pendingSettingsRequest).toEqual({
        tab: undefined,
        nonce: 1,
      })
    })

    it("clearPendingSettings resets the request to null", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.requestOpenSettings("data"))
      act(() => result.current.clearPendingSettings())
      expect(result.current.pendingSettingsRequest).toBeNull()
    })
  })

  describe("persistence partialize", () => {
    it("persists only the safe-to-restore fields", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => {
        result.current.setSelectedGuild({ kind: "team", teamId: "t1" })
        result.current.setShowMemberList(false)
        result.current.setScratchpadCollapsed("ts1", true)
        result.current.setGuildRailCollapsed(true)
        result.current.setStatusBarCollapsed(true)
        // Transient fields — must NOT appear in localStorage
        result.current.setMemberStatus("ts1", "a", "thinking")
        result.current.requestStopMember("ts1", "a")
        result.current.requestOpenSettings("data")
      })

      const raw = window.localStorage.getItem("cognia-ui")
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> }
      expect(parsed.state).toEqual({
        selectedGuild: { kind: "team", teamId: "t1" },
        showMemberList: false,
        scratchpadCollapsed: { ts1: true },
        sidebarCollapsed: false,
        sidebarWidth: 256,
        channelListView: "active",
        collapsedFolderIds: [],
        groupCollapseOverrides: {},
        guildRailCollapsed: true,
        statusBarCollapsed: true,
        barItems: { ...DEFAULT_BAR_ITEMS },
      })
      // Transient fields explicitly excluded
      expect(parsed.state.memberStatus).toBeUndefined()
      expect(parsed.state.stopRequestedFor).toBeUndefined()
      expect(parsed.state.pendingSettingsRequest).toBeUndefined()
    })
  })

  describe("v3 migration", () => {
    // `partialize` writes barItems / statusBarCollapsed / guildRailCollapsed
    // unconditionally and `merge` lets the persisted value win, so anyone who
    // has ever opened the app pins the old chrome defaults forever. Changing
    // DEFAULT_BAR_ITEMS without this migration ships a no-op to every existing
    // install.
    const writeV2Snapshot = (state: Record<string, unknown>) =>
      window.localStorage.setItem("cognia-ui", JSON.stringify({ state, version: 2 }))

    it("drops the stale chrome keys so the new defaults apply", async () => {
      writeV2Snapshot({
        selectedGuild: { kind: "dm" },
        sidebarWidth: 320,
        collapsedFolderIds: ["f1"],
        guildRailCollapsed: true,
        statusBarCollapsed: true,
        barItems: { ...DEFAULT_BAR_ITEMS, accountTop: true, quickActions: true },
      })
      await act(async () => {
        await useUIStore.persist.rehydrate()
      })
      const { result } = renderHook(() => useUIStore())
      expect(result.current.barItems.accountTop).toBe(false)
      expect(result.current.barItems.quickActions).toBe(false)
      expect(result.current.guildRailCollapsed).toBe(false)
      expect(result.current.statusBarCollapsed).toBe(false)
    })

    it("keeps the preferences the user actually chose", async () => {
      writeV2Snapshot({
        selectedGuild: { kind: "team", teamId: "t9" },
        sidebarWidth: 320,
        collapsedFolderIds: ["f1"],
        channelListView: "archived",
        barItems: { ...DEFAULT_BAR_ITEMS },
      })
      await act(async () => {
        await useUIStore.persist.rehydrate()
      })
      const { result } = renderHook(() => useUIStore())
      expect(result.current.selectedGuild).toEqual({ kind: "team", teamId: "t9" })
      expect(result.current.sidebarWidth).toBe(320)
      expect(result.current.collapsedFolderIds).toEqual(["f1"])
      expect(result.current.channelListView).toBe("archived")
    })

    it("leaves a v3 snapshot untouched", async () => {
      window.localStorage.setItem(
        "cognia-ui",
        JSON.stringify({
          state: {
            guildRailCollapsed: true,
            statusBarCollapsed: true,
            barItems: { ...DEFAULT_BAR_ITEMS, usage: false },
          },
          version: 3,
        })
      )
      await act(async () => {
        await useUIStore.persist.rehydrate()
      })
      const { result } = renderHook(() => useUIStore())
      // Post-migration choices are the user's own — never reset them again.
      expect(result.current.guildRailCollapsed).toBe(true)
      expect(result.current.statusBarCollapsed).toBe(true)
      expect(result.current.barItems.usage).toBe(false)
    })
  })

  describe("guildRailCollapsed", () => {
    it("defaults to false and toggles", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.guildRailCollapsed).toBe(false)
      act(() => result.current.toggleGuildRail())
      expect(result.current.guildRailCollapsed).toBe(true)
      act(() => result.current.toggleGuildRail())
      expect(result.current.guildRailCollapsed).toBe(false)
    })

    it("setGuildRailCollapsed sets the state directly", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.setGuildRailCollapsed(true))
      expect(result.current.guildRailCollapsed).toBe(true)
      act(() => result.current.setGuildRailCollapsed(false))
      expect(result.current.guildRailCollapsed).toBe(false)
    })
  })

  describe("statusBarCollapsed", () => {
    it("defaults to false and toggles", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.statusBarCollapsed).toBe(false)
      act(() => result.current.toggleStatusBar())
      expect(result.current.statusBarCollapsed).toBe(true)
      act(() => result.current.toggleStatusBar())
      expect(result.current.statusBarCollapsed).toBe(false)
    })

    it("setStatusBarCollapsed sets the state directly", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.setStatusBarCollapsed(true))
      expect(result.current.statusBarCollapsed).toBe(true)
      act(() => result.current.setStatusBarCollapsed(false))
      expect(result.current.statusBarCollapsed).toBe(false)
    })
  })

  // `barItems` is legacy: both bars persist a full `{ order, hidden }` layout
  // on AppSettings now (see `@/types/shell/bars`). It survives only as the
  // migration source `components/shell/use-bar-layout.ts` folds in once, so
  // what matters here is that it still reads back — not that it can be written.
  describe("barItems (legacy migration source)", () => {
    it("exposes no setter", () => {
      const { result } = renderHook(() => useUIStore())
      expect((result.current as unknown as Record<string, unknown>).toggleBarItem).toBeUndefined()
    })

    it("keeps ids that match the new bar catalogs, so migration is an identity map", () => {
      const catalogIds = new Set([
        ...TITLE_BAR_ITEMS.map((m) => m.id),
        ...STATUS_BAR_ITEMS.map((m) => m.id),
      ])
      for (const id of Object.keys(DEFAULT_BAR_ITEMS)) {
        expect(catalogIds.has(id)).toBe(true)
      }
    })

    it("agrees with the shipped bar layouts about what is hidden", () => {
      // A fresh install migrates through this map, so a disagreement here would
      // silently change the default chrome for everyone.
      const legacyOff = Object.entries(DEFAULT_BAR_ITEMS)
        .filter(([, on]) => !on)
        .map(([id]) => id)
        .sort()
      const shippedHidden = [
        ...DEFAULT_TITLE_BAR_LAYOUT.hidden,
        ...DEFAULT_STATUS_BAR_LAYOUT.hidden,
      ].sort()
      expect(legacyOff).toEqual(shippedHidden)
    })

    it("defaults to DEFAULT_BAR_ITEMS with perf off", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.barItems).toEqual(DEFAULT_BAR_ITEMS)
      expect(result.current.barItems.perf).toBe(false)
      expect(result.current.barItems.connectivity).toBe(true)
    })

    it("ships the account button in exactly one bar", () => {
      // `accountTop` + `accountStatus` were both on, so the same control
      // rendered in the title bar AND the status bar at once.
      expect(DEFAULT_BAR_ITEMS.accountTop).toBe(false)
      expect(DEFAULT_BAR_ITEMS.accountStatus).toBe(true)
    })

    it("keeps the one-off launchers out of the title bar by default", () => {
      // Pet / OCR / clipboard are not touched per conversation — they belong in
      // the Views menu, not in permanent 32px chrome.
      expect(DEFAULT_BAR_ITEMS.quickActions).toBe(false)
    })

    it("reads back a persisted opt-out so the migration can see it", () => {
      act(() => {
        useUIStore.setState({ barItems: { ...DEFAULT_BAR_ITEMS, usage: false } })
      })
      expect(useUIStore.getState().barItems.usage).toBe(false)
    })
  })

  describe("findOpen", () => {
    it("defaults closed and toggles via openFind/closeFind", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.findOpen).toBe(false)
      act(() => result.current.openFind())
      expect(result.current.findOpen).toBe(true)
      act(() => result.current.closeFind())
      expect(result.current.findOpen).toBe(false)
    })

    it("is not persisted to localStorage", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.openFind())
      const raw = window.localStorage.getItem("cognia-ui")
      const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> }
      expect(parsed.state.findOpen).toBeUndefined()
    })
  })

  describe("sidebarWidth", () => {
    it("defaults to 256 and clamps into [220, 420]", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.sidebarWidth).toBe(256)
      act(() => result.current.setSidebarWidth(300))
      expect(result.current.sidebarWidth).toBe(300)
      act(() => result.current.setSidebarWidth(9999))
      expect(result.current.sidebarWidth).toBe(420)
      act(() => result.current.setSidebarWidth(10))
      expect(result.current.sidebarWidth).toBe(220)
    })

    it("rounds fractional widths and rejects non-finite values", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.setSidebarWidth(301.6))
      expect(result.current.sidebarWidth).toBe(302)
      act(() => result.current.setSidebarWidth(Number.NaN))
      expect(result.current.sidebarWidth).toBe(256)
    })
  })

  describe("channelListView", () => {
    it("defaults to active and switches", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.channelListView).toBe("active")
      act(() => result.current.setChannelListView("archived"))
      expect(result.current.channelListView).toBe("archived")
      act(() => result.current.setChannelListView("active"))
      expect(result.current.channelListView).toBe("active")
    })
  })

  describe("groupCollapseOverrides", () => {
    it("records an explicit choice in both directions", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.groupCollapseOverrides).toEqual({})
      // A tri-state: absent means "use the default", which is not uniform —
      // every workspace but the active one starts collapsed.
      act(() => result.current.setGroupCollapsed("workspace:w1", false))
      expect(result.current.groupCollapseOverrides).toEqual({ "workspace:w1": false })
      act(() => result.current.setGroupCollapsed("workspace:w1", true))
      expect(result.current.groupCollapseOverrides).toEqual({ "workspace:w1": true })
    })

    it("no-ops when the value already matches", () => {
      act(() => useUIStore.getState().setGroupCollapsed("agent:a1", true))
      const before = useUIStore.getState().groupCollapseOverrides
      act(() => useUIStore.getState().setGroupCollapsed("agent:a1", true))
      expect(useUIStore.getState().groupCollapseOverrides).toBe(before)
    })
  })

  describe("collapsedFolderIds", () => {
    it("toggleCollapsedFolder adds then removes an id", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.collapsedFolderIds).toEqual([])
      act(() => result.current.toggleCollapsedFolder("f1"))
      expect(result.current.collapsedFolderIds).toEqual(["f1"])
      act(() => result.current.toggleCollapsedFolder("f2"))
      expect(result.current.collapsedFolderIds).toEqual(["f1", "f2"])
      act(() => result.current.toggleCollapsedFolder("f1"))
      expect(result.current.collapsedFolderIds).toEqual(["f2"])
    })

    it("setCollapsedFolders replaces the whole set", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.setCollapsedFolders(["a", "b"]))
      expect(result.current.collapsedFolderIds).toEqual(["a", "b"])
      act(() => result.current.setCollapsedFolders([]))
      expect(result.current.collapsedFolderIds).toEqual([])
    })
  })

  describe("pendingCreateRequest", () => {
    it("defaults to null", () => {
      const { result } = renderHook(() => useUIStore())
      expect(result.current.pendingCreateRequest).toBeNull()
    })

    it("requestCreate bumps the nonce per call", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.requestCreate("workflow"))
      expect(result.current.pendingCreateRequest).toEqual({
        kind: "workflow",
        nonce: 1,
      })
      act(() => result.current.requestCreate("workflow"))
      expect(result.current.pendingCreateRequest).toEqual({
        kind: "workflow",
        nonce: 2,
      })
      act(() => result.current.requestCreate("agentTeam"))
      expect(result.current.pendingCreateRequest).toEqual({
        kind: "agentTeam",
        nonce: 3,
      })
    })

    it("clearPendingCreate resets to null", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.requestCreate("character"))
      act(() => result.current.clearPendingCreate())
      expect(result.current.pendingCreateRequest).toBeNull()
    })

    it("is not persisted across reloads", () => {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.requestCreate("workflow"))
      const raw = window.localStorage.getItem("cognia-ui")
      expect(raw).not.toBeNull()
      const parsed = JSON.parse(raw as string) as { state: Record<string, unknown> }
      expect(parsed.state.pendingCreateRequest).toBeUndefined()
    })
  })
})

describe("plugin event dispatch — onSidebarToggle", () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUIStore.setState(RESET)
  })

  it("toggleSidebar dispatches the negated visibility through getPluginEventHooks", () => {
    const spy = jest
      .spyOn(getPluginEventHooks(), "dispatchSidebarToggle")
      .mockImplementation(() => {})
    try {
      const { result } = renderHook(() => useUIStore())
      // Default sidebarCollapsed === false → toggle makes it collapsed === true → visible === false
      act(() => result.current.toggleSidebar())
      expect(spy).toHaveBeenLastCalledWith(false)
      // Toggle back: collapsed === false → visible === true
      act(() => result.current.toggleSidebar())
      expect(spy).toHaveBeenLastCalledWith(true)
    } finally {
      spy.mockRestore()
    }
  })

  it("setSidebarCollapsed dispatches once with the inverted boolean", () => {
    const spy = jest
      .spyOn(getPluginEventHooks(), "dispatchSidebarToggle")
      .mockImplementation(() => {})
    try {
      const { result } = renderHook(() => useUIStore())
      act(() => result.current.setSidebarCollapsed(true))
      expect(spy).toHaveBeenLastCalledWith(false)
      act(() => result.current.setSidebarCollapsed(false))
      expect(spy).toHaveBeenLastCalledWith(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe("useMemberStatus selector", () => {
  beforeEach(() => {
    window.localStorage.clear()
    useUIStore.setState(RESET)
  })

  it("returns 'idle' when teamSessionId is null", () => {
    const { result } = renderHook(() => useMemberStatus(null, "anyone"))
    expect(result.current).toBe("idle")
  })

  it("returns 'idle' when no status is recorded for that pair", () => {
    const { result } = renderHook(() => useMemberStatus("ts1", "ghost"))
    expect(result.current).toBe("idle")
  })

  it("returns the recorded status when present", () => {
    act(() => useUIStore.getState().setMemberStatus("ts1", "char-a", "errored"))
    const { result } = renderHook(() => useMemberStatus("ts1", "char-a"))
    expect(result.current).toBe("errored")
  })
})
