/**
 * @jest-environment jsdom
 */

import {
  useTerminalStore,
  TERMINAL_LAYOUT_DEFAULTS,
  TERMINAL_LAYOUT_BOUNDS,
  TERMINAL_HISTORY_RING_SIZE,
  TERMINAL_PROMPT_RING_SIZE,
  displayTitle,
  orderTabRows,
  snapPanelPct,
  type TerminalSessionRow,
  type TerminalStoreState,
} from "./terminal-store"
import type { SessionInfo } from "@/lib/terminal/types"

function baseInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s-1",
    projectId: "proj-a",
    extensionId: null,
    origin: "local",
    shell: "/bin/bash",
    ...overrides,
  }
}

beforeEach(() => {
  useTerminalStore.getState().reset()
})

describe("dock layout state", () => {
  it("starts with defaults", () => {
    expect(useTerminalStore.getState().panelOpen).toBe(TERMINAL_LAYOUT_DEFAULTS.panelOpen)
    expect(useTerminalStore.getState().panelHeightPct).toBe(TERMINAL_LAYOUT_DEFAULTS.panelHeightPct)
  })

  it("toggles panelOpen", () => {
    const start = useTerminalStore.getState().panelOpen
    useTerminalStore.getState().togglePanel()
    expect(useTerminalStore.getState().panelOpen).toBe(!start)
    useTerminalStore.getState().togglePanel()
    expect(useTerminalStore.getState().panelOpen).toBe(start)
  })

  it("tracks actionable terminal-host state without persisting it", () => {
    useTerminalStore.getState().setHostState("unauthorized", "grant revoked")
    expect(useTerminalStore.getState()).toMatchObject({
      hostState: "unauthorized",
      hostStateMessage: "grant revoked",
    })
    const { partialize } = useTerminalStore.persist.getOptions()
    expect(partialize?.(useTerminalStore.getState())).not.toHaveProperty("hostState")
  })

  it("clamps panelHeight within bounds", () => {
    useTerminalStore.getState().setPanelHeight(99)
    expect(useTerminalStore.getState().panelHeightPct).toBe(TERMINAL_LAYOUT_BOUNDS.panelMaxPct)
    useTerminalStore.getState().setPanelHeight(0)
    expect(useTerminalStore.getState().panelHeightPct).toBe(TERMINAL_LAYOUT_BOUNDS.panelMinPct)
  })

  it("persists reload-safe layout but not panelOpen", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "b" }))
    useTerminalStore.getState().addPaneToGroup("a", "b", "col")
    useTerminalStore.getState().setFocusedPane("a", "a")
    useTerminalStore.getState().renameSession("b", "Tests")
    useTerminalStore.getState().setActiveSession("proj-a", "a")

    const { partialize } = useTerminalStore.persist.getOptions()
    const persisted = partialize?.({ ...useTerminalStore.getState(), panelOpen: true })
    expect(persisted).toEqual({
      panelHeightPct: useTerminalStore.getState().panelHeightPct,
      panelWidthPct: useTerminalStore.getState().panelWidthPct,
      panelPosition: useTerminalStore.getState().panelPosition,
      pendingReloadLayout: {
        splitPanes: { a: ["b"] },
        focusedPaneByAnchor: { a: "a" },
        splitDirection: { a: "col" },
        activeSessionIdByProject: { "proj-a": "a" },
        customTitles: { b: "Tests" },
        stableHostSessionIds: [],
        controllerBySession: {},
        tabOrder: {},
      },
    })
  })

  it("persists stable host-session identity and last controller for reload handoff", () => {
    useTerminalStore
      .getState()
      .registerSession(baseInfo({ id: "durable", hostId: "host-a", currentController: "desktop" }))
    const { partialize } = useTerminalStore.persist.getOptions()
    expect(partialize?.(useTerminalStore.getState()).pendingReloadLayout).toMatchObject({
      stableHostSessionIds: ["durable"],
      controllerBySession: { durable: "desktop" },
    })
  })

  it("migrate drops a v1 persisted panelOpen but keeps the tuned height", () => {
    const { migrate } = useTerminalStore.persist.getOptions()
    const migrated = migrate?.({ panelOpen: true, panelHeightPct: 40 }, 1) as {
      panelHeightPct: number
      pendingReloadLayout: unknown
      panelOpen?: boolean
    }
    expect(migrated.panelOpen).toBeUndefined()
    expect(migrated.panelHeightPct).toBe(40)
    expect(migrated.pendingReloadLayout).toBeNull()
  })

  it("migrate falls back to the default height when the old value is invalid", () => {
    const { migrate } = useTerminalStore.persist.getOptions()
    const migrated = migrate?.({ panelHeightPct: "junk" }, 1) as { panelHeightPct: number }
    expect(migrated.panelHeightPct).toBe(TERMINAL_LAYOUT_DEFAULTS.panelHeightPct)
  })

  it("migrate v4 → v5 fills in the dock edge and width", () => {
    const { migrate } = useTerminalStore.persist.getOptions()
    const migrated = migrate?.({ panelHeightPct: 40 }, 4) as {
      panelPosition: string
      panelWidthPct: number
    }
    expect(migrated.panelPosition).toBe("bottom")
    expect(migrated.panelWidthPct).toBe(TERMINAL_LAYOUT_DEFAULTS.panelWidthPct)
  })

  it("migrate v5 keeps a valid dock edge and clamps an out-of-range width", () => {
    const { migrate } = useTerminalStore.persist.getOptions()
    const migrated = migrate?.({ panelPosition: "right", panelWidthPct: 500 }, 5) as {
      panelPosition: string
      panelWidthPct: number
    }
    expect(migrated.panelPosition).toBe("right")
    expect(migrated.panelWidthPct).toBe(TERMINAL_LAYOUT_BOUNDS.panelMaxWidthPct)
  })

  it("migrate rejects a garbage dock edge rather than trusting localStorage", () => {
    const { migrate } = useTerminalStore.persist.getOptions()
    const migrated = migrate?.({ panelPosition: "sideways", panelWidthPct: "wide" }, 5) as {
      panelPosition: string
      panelWidthPct: number
    }
    expect(migrated.panelPosition).toBe(TERMINAL_LAYOUT_DEFAULTS.panelPosition)
    expect(migrated.panelWidthPct).toBe(TERMINAL_LAYOUT_DEFAULTS.panelWidthPct)
  })
})

describe("dock position", () => {
  it("starts docked at the bottom", () => {
    expect(useTerminalStore.getState().panelPosition).toBe("bottom")
    expect(useTerminalStore.getState().panelWidthPct).toBe(TERMINAL_LAYOUT_DEFAULTS.panelWidthPct)
  })

  it("moving the dock leaves the other axis's size untouched", () => {
    useTerminalStore.getState().setPanelHeight(44)
    useTerminalStore.getState().setPanelPosition("right")
    expect(useTerminalStore.getState().panelHeightPct).toBe(44)
    expect(useTerminalStore.getState().panelWidthPct).toBe(TERMINAL_LAYOUT_DEFAULTS.panelWidthPct)
  })

  it("moving the dock exits maximize so the other axis's max is not inherited", () => {
    useTerminalStore.getState().toggleMaximized()
    expect(useTerminalStore.getState().maximized).toBe(true)
    useTerminalStore.getState().setPanelPosition("right")
    expect(useTerminalStore.getState().maximized).toBe(false)
  })

  it("setting the position it already has is a no-op", () => {
    useTerminalStore.getState().toggleMaximized()
    useTerminalStore.getState().setPanelPosition("bottom")
    expect(useTerminalStore.getState().maximized).toBe(true)
  })

  it("setPanelSize routes to the axis the dock currently occupies", () => {
    useTerminalStore.getState().setPanelSize(40)
    expect(useTerminalStore.getState().panelHeightPct).toBe(40)
    expect(useTerminalStore.getState().panelSizePct()).toBe(40)

    useTerminalStore.getState().setPanelPosition("right")
    useTerminalStore.getState().setPanelSize(45)
    expect(useTerminalStore.getState().panelWidthPct).toBe(45)
    expect(useTerminalStore.getState().panelHeightPct).toBe(40)
    expect(useTerminalStore.getState().panelSizePct()).toBe(45)
  })

  it("clamps the width to its own, narrower bounds", () => {
    useTerminalStore.getState().setPanelPosition("right")
    useTerminalStore.getState().setPanelSize(99)
    expect(useTerminalStore.getState().panelWidthPct).toBe(TERMINAL_LAYOUT_BOUNDS.panelMaxWidthPct)
    useTerminalStore.getState().setPanelSize(1)
    expect(useTerminalStore.getState().panelWidthPct).toBe(TERMINAL_LAYOUT_BOUNDS.panelMinWidthPct)
  })

  it("setPanelHeight still tunes the height while docked right", () => {
    useTerminalStore.getState().setPanelPosition("right")
    useTerminalStore.getState().setPanelHeight(41)
    expect(useTerminalStore.getState().panelHeightPct).toBe(41)
    expect(useTerminalStore.getState().panelWidthPct).toBe(TERMINAL_LAYOUT_DEFAULTS.panelWidthPct)
  })

  it("maximize round-trips on the width axis", () => {
    useTerminalStore.getState().setPanelPosition("right")
    useTerminalStore.getState().setPanelSize(40)
    useTerminalStore.getState().toggleMaximized()
    expect(useTerminalStore.getState().panelWidthPct).toBe(TERMINAL_LAYOUT_BOUNDS.panelMaxWidthPct)
    expect(useTerminalStore.getState().preMaxWidthPct).toBe(40)
    useTerminalStore.getState().toggleMaximized()
    expect(useTerminalStore.getState().panelWidthPct).toBe(40)
    expect(useTerminalStore.getState().maximized).toBe(false)
  })
})

describe("snapPanelPct", () => {
  it("settles onto a nearby snap point", () => {
    expect(snapPanelPct(24.3)).toBe(25)
    expect(snapPanelPct(50.9)).toBe(50)
  })

  it("leaves a value outside the tolerance alone", () => {
    expect(snapPanelPct(40)).toBe(40)
    expect(snapPanelPct(28)).toBe(28)
  })

  it("picks the closest snap when two are in range", () => {
    expect(snapPanelPct(32.4, [32, 33], 2)).toBe(32)
    expect(snapPanelPct(32.6, [32, 33], 2)).toBe(33)
  })

  it("is a no-op with no snap points or a non-finite value", () => {
    expect(snapPanelPct(24.3, [])).toBe(24.3)
    expect(snapPanelPct(Number.NaN)).toBeNaN()
  })

  it("drag and arrow-key resizes both land on a snap point", () => {
    useTerminalStore.getState().setPanelSize(33.4)
    expect(useTerminalStore.getState().panelHeightPct).toBe(33)
  })
})

describe("tab order", () => {
  function row(id: string, createdAt: number): TerminalSessionRow {
    return { id, createdAt } as TerminalSessionRow
  }

  it("orderTabRows falls back to creation order without an order list", () => {
    const rows = [row("b", 2), row("a", 1)]
    expect(orderTabRows(rows, undefined).map((r) => r.id)).toEqual(["a", "b"])
    expect(orderTabRows(rows, []).map((r) => r.id)).toEqual(["a", "b"])
  })

  it("orderTabRows honours the order and appends unranked rows by createdAt", () => {
    const rows = [row("a", 1), row("b", 2), row("c", 3), row("d", 4)]
    expect(orderTabRows(rows, ["c", "a"]).map((r) => r.id)).toEqual(["c", "a", "b", "d"])
  })

  it("setTabOrder drops foreign and unknown ids and appends the leftovers", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "b" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "x", projectId: "proj-b" }))

    useTerminalStore.getState().setTabOrder("proj-a", ["b", "x", "ghost", "b"])
    expect(useTerminalStore.getState().tabOrder["proj-a"]).toEqual(["b", "a"])
  })

  it("tabsForProject reflects the user order", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "b" }))
    useTerminalStore.getState().setTabOrder("proj-a", ["b", "a"])
    expect(
      useTerminalStore
        .getState()
        .tabsForProject("proj-a")
        .map((r) => r.id)
    ).toEqual(["b", "a"])
  })

  it("removeSession prunes the order and the throttle flag", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "b" }))
    useTerminalStore.getState().setTabOrder("proj-a", ["b", "a"])
    useTerminalStore.getState().setOutputThrottled("b", true)

    useTerminalStore.getState().removeSession("b")
    expect(useTerminalStore.getState().tabOrder["proj-a"]).toEqual(["a"])
    expect(useTerminalStore.getState().outputThrottled).toEqual({})
  })

  it("rides the reload channel and drops ids that did not come back", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "b" }))
    useTerminalStore.getState().setTabOrder("proj-a", ["b", "a"])

    const { partialize } = useTerminalStore.persist.getOptions()
    const snapshot = partialize?.(useTerminalStore.getState())
    expect(snapshot?.pendingReloadLayout?.tabOrder).toEqual({ "proj-a": ["b", "a"] })

    // Only `a` survives the reload; the stale `b` must not pin a phantom slot.
    useTerminalStore.getState().reset()
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.setState({ pendingReloadLayout: snapshot!.pendingReloadLayout })
    useTerminalStore.getState().restorePersistedLayout()
    expect(useTerminalStore.getState().tabOrder["proj-a"]).toEqual(["a"])
  })

  it("normalizes a malformed persisted tab order", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.setState({
      pendingReloadLayout: {
        tabOrder: { "proj-a": ["a", 7, null] },
      } as never,
    })
    useTerminalStore.getState().restorePersistedLayout()
    expect(useTerminalStore.getState().tabOrder["proj-a"]).toEqual(["a"])
  })
})

describe("renderer backpressure flag", () => {
  it("sets and clears the throttled flag", () => {
    useTerminalStore.getState().setOutputThrottled("s-1", true)
    expect(useTerminalStore.getState().outputThrottled).toEqual({ "s-1": true })
    useTerminalStore.getState().setOutputThrottled("s-1", false)
    expect(useTerminalStore.getState().outputThrottled).toEqual({})
  })

  it("is a no-op when the flag is already in the requested state", () => {
    useTerminalStore.getState().setOutputThrottled("s-1", true)
    const before = useTerminalStore.getState().outputThrottled
    useTerminalStore.getState().setOutputThrottled("s-1", true)
    expect(useTerminalStore.getState().outputThrottled).toBe(before)
  })
})

describe("maximize toggle", () => {
  it("starts unmaximized", () => {
    expect(useTerminalStore.getState().maximized).toBe(false)
  })

  it("toggleMaximized snaps to the max height and remembers the previous size", () => {
    useTerminalStore.getState().setPanelHeight(40)
    useTerminalStore.getState().toggleMaximized()
    const s = useTerminalStore.getState()
    expect(s.maximized).toBe(true)
    expect(s.panelHeightPct).toBe(TERMINAL_LAYOUT_BOUNDS.panelMaxPct)
    expect(s.preMaxHeightPct).toBe(40)
  })

  it("supports continuous dock resizing through the complete 15–85 percent range", () => {
    useTerminalStore.getState().setPanelHeight(84.5)
    expect(useTerminalStore.getState().panelHeightPct).toBe(84.5)
    expect(TERMINAL_LAYOUT_BOUNDS).toEqual({
      panelMinPct: 15,
      panelMaxPct: 85,
      panelMinWidthPct: 15,
      panelMaxWidthPct: 70,
    })
  })

  it("toggling again restores the pre-maximize height", () => {
    useTerminalStore.getState().setPanelHeight(40)
    useTerminalStore.getState().toggleMaximized()
    useTerminalStore.getState().toggleMaximized()
    const s = useTerminalStore.getState()
    expect(s.maximized).toBe(false)
    expect(s.panelHeightPct).toBe(40)
  })

  it("a manual resize exits the maximized state", () => {
    useTerminalStore.getState().toggleMaximized()
    expect(useTerminalStore.getState().maximized).toBe(true)
    useTerminalStore.getState().setPanelHeight(30)
    expect(useTerminalStore.getState().maximized).toBe(false)
    expect(useTerminalStore.getState().panelHeightPct).toBe(30)
  })

  it("reset clears the maximized flag", () => {
    useTerminalStore.getState().toggleMaximized()
    useTerminalStore.getState().reset()
    expect(useTerminalStore.getState().maximized).toBe(false)
    expect(useTerminalStore.getState().preMaxHeightPct).toBe(
      TERMINAL_LAYOUT_DEFAULTS.panelHeightPct
    )
  })
})

describe("session registry", () => {
  it("registers a new session and makes it active for its project", () => {
    useTerminalStore.getState().registerSession(baseInfo())
    const state = useTerminalStore.getState()
    expect(state.sessions["s-1"]).toMatchObject({
      id: "s-1",
      projectId: "proj-a",
      status: "idle",
      shell: "/bin/bash",
    })
    expect(state.getActiveSession("proj-a")).toBe("s-1")
  })

  it("derives a sensible title from the shell path", () => {
    useTerminalStore.getState().registerSession(baseInfo({ shell: "/usr/local/bin/zsh" }))
    expect(useTerminalStore.getState().sessions["s-1"]?.title).toBe("zsh")
  })

  it("title strips .exe on Windows shells", () => {
    useTerminalStore
      .getState()
      .registerSession(baseInfo({ id: "s-w", shell: "C:\\Windows\\System32\\pwsh.exe" }))
    expect(useTerminalStore.getState().sessions["s-w"]?.title).toBe("pwsh")
  })

  it("title prefixes extensionId when present", () => {
    useTerminalStore
      .getState()
      .registerSession(baseInfo({ id: "s-ext", extensionId: "cline.cline", shell: "/bin/bash" }))
    expect(useTerminalStore.getState().sessions["s-ext"]?.title).toContain("cline.cline")
  })

  it("removeSession drops the row and falls back to the next-most-recent tab", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "s-1" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "s-2" }))
    useTerminalStore.getState().setActiveSession("proj-a", "s-2")
    useTerminalStore.getState().removeSession("s-2")
    expect(useTerminalStore.getState().sessions["s-2"]).toBeUndefined()
    expect(useTerminalStore.getState().getActiveSession("proj-a")).toBe("s-1")
  })

  it("removeSession on the last tab clears the active pointer", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "s-1" }))
    useTerminalStore.getState().removeSession("s-1")
    expect(useTerminalStore.getState().getActiveSession("proj-a")).toBeNull()
  })

  it("setSessionStatus updates only the matching row", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "b" }))
    useTerminalStore.getState().setSessionStatus("a", "running")
    expect(useTerminalStore.getState().sessions["a"]?.status).toBe("running")
    expect(useTerminalStore.getState().sessions["b"]?.status).toBe("idle")
  })

  it("setSessionExit flips status to exited and records the code", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().setSessionExit("a", 1)
    expect(useTerminalStore.getState().sessions["a"]?.status).toBe("exited")
    expect(useTerminalStore.getState().sessions["a"]?.exitCode).toBe(1)
  })

  it("setSessionCwd updates the cwd field", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().setSessionCwd("a", "/tmp/foo")
    expect(useTerminalStore.getState().sessions["a"]?.cwd).toBe("/tmp/foo")
  })

  it("setSessionTitle replaces the title", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().setSessionTitle("a", "Build · cargo run")
    expect(useTerminalStore.getState().sessions["a"]?.title).toBe("Build · cargo run")
  })

  it("ignores updates targeting unknown session ids", () => {
    useTerminalStore.getState().setSessionStatus("ghost", "running")
    useTerminalStore.getState().setSessionExit("ghost", 0)
    useTerminalStore.getState().setSessionCwd("ghost", "/tmp")
    useTerminalStore.getState().setSessionTitle("ghost", "Phantom")
    expect(useTerminalStore.getState().sessions["ghost"]).toBeUndefined()
  })
})

describe("project filtering", () => {
  it("sessionsForProject returns only the matching project's tabs, sorted by createdAt", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a", projectId: "proj-a" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "b", projectId: "proj-b" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "c", projectId: "proj-a" }))
    const a = useTerminalStore
      .getState()
      .sessionsForProject("proj-a")
      .map((r) => r.id)
    expect(a).toEqual(["a", "c"])
  })

  it("sessionsForProject handles null projectId (orphan tabs)", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "orphan", projectId: null }))
    const rows = useTerminalStore.getState().sessionsForProject(null)
    expect(rows.map((r) => r.id)).toEqual(["orphan"])
  })

  it("active session per project is independent", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a", projectId: "proj-a" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "b", projectId: "proj-b" }))
    expect(useTerminalStore.getState().getActiveSession("proj-a")).toBe("a")
    expect(useTerminalStore.getState().getActiveSession("proj-b")).toBe("b")
  })
})

describe("reset", () => {
  it("clears every session + restores layout defaults", () => {
    useTerminalStore.getState().setPanelOpen(true)
    useTerminalStore.getState().setPanelHeight(50)
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().reset()
    expect(useTerminalStore.getState().panelOpen).toBe(TERMINAL_LAYOUT_DEFAULTS.panelOpen)
    expect(useTerminalStore.getState().panelHeightPct).toBe(TERMINAL_LAYOUT_DEFAULTS.panelHeightPct)
    expect(useTerminalStore.getState().sessions).toEqual({})
  })
})

describe("custom title (Rename)", () => {
  it("renameSession sets customTitle and displayTitle prefers it", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().renameSession("a", "Build")
    const row = useTerminalStore.getState().sessions["a"]!
    expect(row.customTitle).toBe("Build")
    expect(displayTitle(row)).toBe("Build")
  })

  it("renameSession with empty string clears the override", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().renameSession("a", "Build")
    useTerminalStore.getState().renameSession("a", "")
    const row = useTerminalStore.getState().sessions["a"]!
    expect(row.customTitle).toBeNull()
    expect(displayTitle(row)).toBe(row.title)
  })

  it("renameSession with whitespace-only clears the override", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().renameSession("a", "Build")
    useTerminalStore.getState().renameSession("a", "   ")
    expect(useTerminalStore.getState().sessions["a"]?.customTitle).toBeNull()
  })

  it("renameSession trims whitespace", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().renameSession("a", "  Build  ")
    expect(useTerminalStore.getState().sessions["a"]?.customTitle).toBe("Build")
  })

  it("displayTitle falls back to auto title when customTitle is null", () => {
    expect(displayTitle({ title: "zsh", customTitle: null })).toBe("zsh")
  })
})

describe("agent trust + spawner", () => {
  it("defaults to untrusted and no spawner", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    const row = useTerminalStore.getState().sessions["a"]!
    expect(row.agentTrusted).toBe(false)
    expect(row.agentSpawner).toBeNull()
  })

  it("registerSession can record an agentSpawner up front", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }), {
      agentSpawner: "claude:sess-xyz",
    })
    expect(useTerminalStore.getState().sessions["a"]?.agentSpawner).toBe("claude:sess-xyz")
  })

  it("setAgentTrusted flips the flag", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().setAgentTrusted("a", true)
    expect(useTerminalStore.getState().sessions["a"]?.agentTrusted).toBe(true)
    useTerminalStore.getState().setAgentTrusted("a", false)
    expect(useTerminalStore.getState().sessions["a"]?.agentTrusted).toBe(false)
  })

  it("setAgentSpawner can update or clear the spawner", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().setAgentSpawner("a", "claude:sess-xyz")
    expect(useTerminalStore.getState().sessions["a"]?.agentSpawner).toBe("claude:sess-xyz")
    useTerminalStore.getState().setAgentSpawner("a", null)
    expect(useTerminalStore.getState().sessions["a"]?.agentSpawner).toBeNull()
  })

  it("sessionsForAgent returns only matching agentSpawner rows sorted by createdAt", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }), { agentSpawner: "agent-1" })
    useTerminalStore.getState().registerSession(baseInfo({ id: "b" }), { agentSpawner: "agent-2" })
    useTerminalStore.getState().registerSession(baseInfo({ id: "c" }), { agentSpawner: "agent-1" })
    const ids = useTerminalStore
      .getState()
      .sessionsForAgent("agent-1")
      .map((r) => r.id)
    expect(ids).toEqual(["a", "c"])
  })

  it("sessionsForAgent excludes user-spawned tabs (null spawner)", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "user" }))
    useTerminalStore
      .getState()
      .registerSession(baseInfo({ id: "agent" }), { agentSpawner: "agent-1" })
    const ids = useTerminalStore
      .getState()
      .sessionsForAgent("agent-1")
      .map((r) => r.id)
    expect(ids).toEqual(["agent"])
  })
})

describe("prompt boundaries (OSC 633 A/B)", () => {
  it("pushPrompt appends an open boundary", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().pushPrompt("a", 1000)
    const row = useTerminalStore.getState().sessions["a"]!
    expect(row.promptBoundaries).toEqual([{ startMs: 1000 }])
  })

  it("closePrompt fills endMs on the tail boundary", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().pushPrompt("a", 1000)
    useTerminalStore.getState().closePrompt("a", 1500)
    expect(useTerminalStore.getState().sessions["a"]?.promptBoundaries).toEqual([
      { startMs: 1000, endMs: 1500 },
    ])
  })

  it("closePrompt on an already-closed tail is a no-op", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().pushPrompt("a", 1000)
    useTerminalStore.getState().closePrompt("a", 1500)
    useTerminalStore.getState().closePrompt("a", 9999)
    expect(useTerminalStore.getState().sessions["a"]?.promptBoundaries).toEqual([
      { startMs: 1000, endMs: 1500 },
    ])
  })

  it("closePrompt with no boundaries is a no-op", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().closePrompt("a", 5000)
    expect(useTerminalStore.getState().sessions["a"]?.promptBoundaries).toEqual([])
  })

  it("ring trims to TERMINAL_PROMPT_RING_SIZE", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    for (let i = 0; i < TERMINAL_PROMPT_RING_SIZE + 5; i++) {
      useTerminalStore.getState().pushPrompt("a", i)
    }
    const row = useTerminalStore.getState().sessions["a"]!
    expect(row.promptBoundaries.length).toBe(TERMINAL_PROMPT_RING_SIZE)
    expect(row.promptBoundaries[0].startMs).toBe(5)
    expect(row.promptBoundaries[row.promptBoundaries.length - 1].startMs).toBe(
      TERMINAL_PROMPT_RING_SIZE + 4
    )
  })
})

describe("command history ring", () => {
  it("pushCommand appends entries", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    useTerminalStore.getState().pushCommand("a", { cmd: "ls", exitCode: 0, endedAt: 1 })
    useTerminalStore.getState().pushCommand("a", { cmd: "pwd", exitCode: 0, endedAt: 2 })
    const row = useTerminalStore.getState().sessions["a"]!
    expect(row.lastCommands.map((r) => r.cmd)).toEqual(["ls", "pwd"])
  })

  it("ring trims to TERMINAL_HISTORY_RING_SIZE keeping the newest", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    for (let i = 0; i < TERMINAL_HISTORY_RING_SIZE + 3; i++) {
      useTerminalStore.getState().pushCommand("a", { cmd: `c${i}`, exitCode: 0, endedAt: i })
    }
    const row = useTerminalStore.getState().sessions["a"]!
    expect(row.lastCommands.length).toBe(TERMINAL_HISTORY_RING_SIZE)
    expect(row.lastCommands[0].cmd).toBe("c3")
    expect(row.lastCommands[row.lastCommands.length - 1].cmd).toBe(
      `c${TERMINAL_HISTORY_RING_SIZE + 2}`
    )
  })

  it("pushCommand on unknown session is a no-op", () => {
    useTerminalStore.getState().pushCommand("ghost", { cmd: "x", exitCode: 0, endedAt: 0 })
    expect(useTerminalStore.getState().sessions["ghost"]).toBeUndefined()
  })
})

describe("history panel toggle", () => {
  it("setHistoryOpen flips the per-tab flag", () => {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))
    expect(useTerminalStore.getState().sessions["a"]?.historyOpen).toBe(false)
    useTerminalStore.getState().setHistoryOpen("a", true)
    expect(useTerminalStore.getState().sessions["a"]?.historyOpen).toBe(true)
  })
})

describe("split panes (1A)", () => {
  function twoSessions() {
    useTerminalStore.getState().registerSession(baseInfo({ id: "a", projectId: "proj-a" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "b", projectId: "proj-a" }))
  }

  it("addPaneToGroup attaches a pane, focuses it, keeps the anchor active", () => {
    twoSessions()
    useTerminalStore.getState().addPaneToGroup("a", "b", "row")
    const s = useTerminalStore.getState()
    expect(s.panesForGroup("a")).toEqual(["a", "b"])
    expect(s.focusedPaneByAnchor["a"]).toBe("b")
    expect(s.splitDirection["a"]).toBe("row")
    // anchor restored as the active tab (b was made active by registerSession)
    expect(s.getActiveSession("proj-a")).toBe("a")
  })

  it("defaults split direction to row when none given", () => {
    twoSessions()
    useTerminalStore.getState().addPaneToGroup("a", "b")
    expect(useTerminalStore.getState().splitDirection["a"]).toBe("row")
  })

  it("hides split members from tabsForProject but keeps them in sessions", () => {
    twoSessions()
    useTerminalStore.getState().addPaneToGroup("a", "b")
    const tabs = useTerminalStore
      .getState()
      .tabsForProject("proj-a")
      .map((r) => r.id)
    expect(tabs).toEqual(["a"])
    expect(useTerminalStore.getState().sessions["b"]).toBeDefined()
  })

  it("addPaneToGroup is idempotent and rejects self / unknown", () => {
    twoSessions()
    useTerminalStore.getState().addPaneToGroup("a", "b")
    useTerminalStore.getState().addPaneToGroup("a", "b") // dup
    useTerminalStore.getState().addPaneToGroup("a", "a") // self
    useTerminalStore.getState().addPaneToGroup("a", "ghost") // unknown
    expect(useTerminalStore.getState().splitPanes["a"]).toEqual(["b"])
  })

  it("groupAnchorOf resolves members to their anchor and standalone to self", () => {
    twoSessions()
    useTerminalStore.getState().addPaneToGroup("a", "b")
    expect(useTerminalStore.getState().groupAnchorOf("b")).toBe("a")
    expect(useTerminalStore.getState().groupAnchorOf("a")).toBe("a")
  })

  it("setFocusedPane resolves the anchor from a member id", () => {
    twoSessions()
    useTerminalStore.getState().addPaneToGroup("a", "b")
    useTerminalStore.getState().setFocusedPane("b", "a")
    expect(useTerminalStore.getState().focusedPaneByAnchor["a"]).toBe("a")
  })

  it("removing a non-anchor pane keeps the group and resets focus to anchor", () => {
    twoSessions()
    useTerminalStore.getState().addPaneToGroup("a", "b")
    useTerminalStore.getState().removeSession("b")
    const s = useTerminalStore.getState()
    expect(s.panesForGroup("a")).toEqual(["a"])
    expect(s.splitPanes["a"]).toBeUndefined()
    expect(s.focusedPaneByAnchor["a"]).toBe("a")
    expect(s.tabsForProject("proj-a").map((r) => r.id)).toEqual(["a"])
  })

  it("removing the anchor promotes the next pane and the active pointer follows", () => {
    twoSessions()
    useTerminalStore.getState().registerSession(baseInfo({ id: "c", projectId: "proj-a" }))
    useTerminalStore.getState().addPaneToGroup("a", "b")
    useTerminalStore.getState().addPaneToGroup("a", "c")
    useTerminalStore.getState().setActiveSession("proj-a", "a")
    useTerminalStore.getState().removeSession("a")
    const s = useTerminalStore.getState()
    // b promoted to anchor, c stays as its member
    expect(s.panesForGroup("b")).toEqual(["b", "c"])
    expect(s.getActiveSession("proj-a")).toBe("b")
    expect(s.tabsForProject("proj-a").map((r) => r.id)).toEqual(["b"])
  })

  it("reset clears split state", () => {
    twoSessions()
    useTerminalStore.getState().addPaneToGroup("a", "b")
    useTerminalStore.getState().reset()
    expect(useTerminalStore.getState().splitPanes).toEqual({})
    expect(useTerminalStore.getState().focusedPaneByAnchor).toEqual({})
    expect(useTerminalStore.getState().splitDirection).toEqual({})
  })

  it("restores a persisted split layout after surviving sessions register", () => {
    useTerminalStore.setState({
      pendingReloadLayout: {
        splitPanes: { a: ["b"] },
        focusedPaneByAnchor: { a: "b" },
        splitDirection: { a: "col" },
        activeSessionIdByProject: { "proj-a": "a" },
        customTitles: { a: "Server", b: "Tests" },
        stableHostSessionIds: [],
        controllerBySession: {},
        tabOrder: { "proj-a": ["b", "a"] },
      },
    })
    twoSessions()

    useTerminalStore.getState().restorePersistedLayout()

    const state = useTerminalStore.getState()
    expect(state.pendingReloadLayout).toBeNull()
    expect(state.panesForGroup("a")).toEqual(["a", "b"])
    expect(state.focusedPaneByAnchor).toEqual({ a: "b" })
    expect(state.splitDirection).toEqual({ a: "col" })
    expect(state.getActiveSession("proj-a")).toBe("a")
    expect(state.sessions["a"]?.customTitle).toBe("Server")
    expect(state.sessions["b"]?.customTitle).toBe("Tests")
    expect(state.tabOrder["proj-a"]).toEqual(["b", "a"])
  })

  it("drops stale and cross-project pane references during restore", () => {
    useTerminalStore.setState({
      pendingReloadLayout: {
        splitPanes: { a: ["missing", "b", "other"] },
        focusedPaneByAnchor: { a: "missing" },
        splitDirection: { a: "row" },
        activeSessionIdByProject: { "proj-a": "missing", "proj-b": "other" },
        customTitles: { missing: "Gone", b: "Restored", other: "Other" },
        stableHostSessionIds: [],
        controllerBySession: {},
        // `missing` never re-registers, and `other` belongs to proj-b — both
        // must be pruned rather than pinning phantom slots in the strip.
        tabOrder: { "proj-a": ["missing", "b", "other"], "proj-b": ["other"] },
      },
    })
    twoSessions()
    useTerminalStore.getState().registerSession(baseInfo({ id: "other", projectId: "proj-b" }))

    useTerminalStore.getState().restorePersistedLayout()

    const state = useTerminalStore.getState()
    expect(state.panesForGroup("a")).toEqual(["a", "b"])
    expect(state.focusedPaneByAnchor).toEqual({ a: "a" })
    expect(state.getActiveSession("proj-a")).toBe("a")
    expect(state.getActiveSession("proj-b")).toBe("other")
    expect(state.sessions["b"]?.customTitle).toBe("Restored")
    expect(state.sessions["other"]?.customTitle).toBe("Other")
    expect(state.tabOrder).toEqual({ "proj-a": ["b"], "proj-b": ["other"] })
  })

  it("clears a persisted layout when no PTY sessions survived", () => {
    useTerminalStore.setState({
      pendingReloadLayout: {
        splitPanes: { gone: ["also-gone"] },
        focusedPaneByAnchor: { gone: "also-gone" },
        splitDirection: { gone: "col" },
        activeSessionIdByProject: { "proj-a": "gone" },
        customTitles: { gone: "Old" },
        stableHostSessionIds: [],
        controllerBySession: {},
        tabOrder: { "proj-a": ["gone"] },
      },
    })

    useTerminalStore.getState().restorePersistedLayout()

    const state = useTerminalStore.getState()
    expect(state.pendingReloadLayout).toBeNull()
    expect(state.splitPanes).toEqual({})
    expect(state.activeSessionIdByProject).toEqual({})
    expect(state.tabOrder).toEqual({})
  })

  it("normalizes malformed persisted metadata instead of trusting localStorage", () => {
    useTerminalStore.setState({
      pendingReloadLayout: {
        splitPanes: { a: "not-an-array" },
        focusedPaneByAnchor: [],
        splitDirection: { a: "diagonal" },
        activeSessionIdByProject: [],
        customTitles: null,
      } as unknown as TerminalStoreState["pendingReloadLayout"],
    })
    useTerminalStore.getState().registerSession(baseInfo({ id: "a" }))

    useTerminalStore.getState().restorePersistedLayout()

    const state = useTerminalStore.getState()
    expect(state.pendingReloadLayout).toBeNull()
    expect(state.splitPanes).toEqual({})
    expect(state.focusedPaneByAnchor).toEqual({})
    expect(state.splitDirection).toEqual({})
    expect(state.getActiveSession("proj-a")).toBe("a")
  })

  it("repairs duplicate groups, invalid direction, focus, title, and active tab", () => {
    useTerminalStore.setState({
      pendingReloadLayout: {
        splitPanes: {
          a: ["a", "b", "b", "cross"],
          b: ["c"],
          missing: ["c"],
        },
        focusedPaneByAnchor: { a: "a" },
        splitDirection: { a: "diagonal" },
        activeSessionIdByProject: {},
        customTitles: { a: "   " },
      } as unknown as TerminalStoreState["pendingReloadLayout"],
    })
    twoSessions()
    useTerminalStore.getState().registerSession(baseInfo({ id: "c" }))
    useTerminalStore.getState().registerSession(baseInfo({ id: "cross", projectId: "proj-b" }))
    useTerminalStore.getState().setActiveSession("proj-a", "gone")

    useTerminalStore.getState().restorePersistedLayout()

    const state = useTerminalStore.getState()
    expect(state.splitPanes).toEqual({ a: ["b"] })
    expect(state.focusedPaneByAnchor).toEqual({ a: "a" })
    expect(state.splitDirection).toEqual({ a: "row" })
    expect(state.getActiveSession("proj-a")).toBe("c")
    expect(state.sessions["a"]?.customTitle).toBeNull()
  })

  it("discards a non-object persisted snapshot", () => {
    useTerminalStore.setState({
      pendingReloadLayout: [] as unknown as TerminalStoreState["pendingReloadLayout"],
    })

    useTerminalStore.getState().restorePersistedLayout()

    expect(useTerminalStore.getState().pendingReloadLayout).toBeNull()
  })
})
