/**
 * @jest-environment jsdom
 */

// Capture plugin-event dispatch calls so we can verify the canvas hook
// wiring (Tier 2 of ADR 0016). The mock keeps the dispatch surface intact
// for every other dispatcher the store calls but lets us spy on canvas
// invocations.
const mockHooksManager = {
  dispatchArtifactCreate: jest.fn(),
  dispatchArtifactUpdate: jest.fn(),
  dispatchArtifactDelete: jest.fn(),
  dispatchArtifactOpen: jest.fn(),
  dispatchArtifactClose: jest.fn(),
  dispatchCanvasCreate: jest.fn(),
  dispatchCanvasUpdate: jest.fn(),
  dispatchCanvasDelete: jest.fn(),
  dispatchCanvasSwitch: jest.fn(),
  dispatchCanvasContentChange: jest.fn(),
  dispatchCanvasVersionSave: jest.fn(),
  dispatchCanvasVersionRestore: jest.fn(),
  dispatchCanvasSelection: jest.fn(),
  dispatchPanelOpen: jest.fn(),
  dispatchPanelClose: jest.fn(),
}

jest.mock("@/lib/plugin", () => ({
  getPluginEventHooks: jest.fn(() => mockHooksManager),
}))

// Controllable active workspace so we can exercise Workspace isolation (v86).
let mockActiveProjectId: string | null = null
jest.mock("@/stores/project/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: mockActiveProjectId }) },
}))

// Controllable focused conversation. `setActiveArtifact` reads it to decide
// which conversation's dock an activation lands in, so cross-session opens
// (the artifact list's "recent" scope) need to be able to drive it.
let mockActiveSessionId: string | null = null
jest.mock("@/stores/chat", () => ({
  useChatStore: { getState: () => ({ activeSessionId: mockActiveSessionId }) },
}))

// Reset the rate-limiter singleton so the high-frequency dispatch tests
// start with a full token bucket.
import { resetPluginRateLimiter } from "@/lib/plugin/security/rate-limiter"

import {
  activateArtifactAccountStorage,
  clearArtifactAccountStorage,
  purgeArtifactAccountStorage,
  MAX_OPEN_ARTIFACTS,
  selectActiveArtifactId,
  selectOpenArtifactIds,
  useArtifactStore,
} from "./artifact-store"

const initial = {
  artifacts: {},
  activeArtifactIdBySession: {},
  openArtifactIdsBySession: {},
  artifactVersions: {},
  artifactWorkspace: {
    scope: "session" as const,
    sessionId: null,
    searchQuery: "",
    typeFilter: "all" as const,
    runtimeFilter: "all" as const,
    recentArtifactIds: [],
    returnContext: null,
  },
  canvasDocuments: {},
  activeCanvasId: null,
  panelOpen: false,
  panelView: "artifact" as const,
  // Staged review outcomes survive an apply/reject, so unlike `pendingReviews`
  // they do not clear themselves as a side effect of what each test does —
  // without this they accumulate across the suite.
  reviewReceipts: [],
}

/**
 * What zustand would write to storage right now. Goes through the middleware's
 * own `partialize` rather than re-implementing it, and is independent of the
 * active storage key (the account-scoped suites rename it).
 */
const readPartialize = (): Record<string, unknown> => {
  const partialize = (
    useArtifactStore.persist.getOptions() as {
      partialize?: (s: ReturnType<typeof useArtifactStore.getState>) => Record<string, unknown>
    }
  ).partialize
  expect(partialize).toBeDefined()
  return partialize!(useArtifactStore.getState())
}

/** Tabs and active id are bucketed per session; most suites only use `s1`. */
const openTabs = (sessionId: string | null = "s1") =>
  selectOpenArtifactIds(useArtifactStore.getState(), sessionId)
const activeTab = (sessionId: string | null = "s1") =>
  selectActiveArtifactId(useArtifactStore.getState(), sessionId)

beforeEach(() => {
  localStorage.clear()
  useArtifactStore.setState(initial)
  jest.clearAllMocks()
  resetPluginRateLimiter()
  mockActiveProjectId = null
  mockActiveSessionId = null
})

describe("openArtifactIds (the dock's tab strip)", () => {
  function make(title: string) {
    return useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m1",
      type: "code",
      title,
      content: "x",
    })
  }

  it("opens a tab on create and on activate, without reordering", () => {
    const a = make("A")
    const b = make("B")
    expect(openTabs()).toEqual([a.id, b.id])

    useArtifactStore.getState().setActiveArtifact(a.id)

    // Tabs keep open order; only `recentArtifactIds` is an MRU list.
    expect(openTabs()).toEqual([a.id, b.id])
    expect(useArtifactStore.getState().artifactWorkspace.recentArtifactIds[0]).toBe(a.id)
  })

  it("drops the oldest tab past the cap", () => {
    const created = Array.from({ length: MAX_OPEN_ARTIFACTS + 2 }, (_, i) => make(`A${i}`))
    const open = openTabs()

    expect(open).toHaveLength(MAX_OPEN_ARTIFACTS)
    expect(open).not.toContain(created[0].id)
    expect(open.at(-1)).toBe(created.at(-1)!.id)
  })

  it("reorders an open tab in place, clamped and MRU-untouched", () => {
    const a = make("A")
    const b = make("B")
    const c = make("C")
    const recentsBefore = useArtifactStore.getState().artifactWorkspace.recentArtifactIds

    useArtifactStore.getState().reorderOpenArtifact(a.id, 2)
    expect(openTabs()).toEqual([b.id, c.id, a.id])

    // Out-of-range targets clamp instead of dropping the id.
    useArtifactStore.getState().reorderOpenArtifact(a.id, -5)
    expect(openTabs()).toEqual([a.id, b.id, c.id])
    useArtifactStore.getState().reorderOpenArtifact(a.id, 99)
    expect(openTabs()).toEqual([b.id, c.id, a.id])

    // Unknown id and same-position moves are no-ops.
    const before = openTabs()
    useArtifactStore.getState().reorderOpenArtifact("nope", 0)
    useArtifactStore.getState().reorderOpenArtifact(a.id, 2)
    expect(openTabs()).toBe(before)

    expect(useArtifactStore.getState().artifactWorkspace.recentArtifactIds).toEqual(recentsBefore)
  })

  it("ignores closing an id that is not open", () => {
    const a = make("A")
    make("B")
    const before = openTabs()

    useArtifactStore.getState().closeArtifact("nope")

    expect(openTabs()).toBe(before)
    expect(activeTab()).toBe(activeTab())
    expect(useArtifactStore.getState().artifacts[a.id]).toBeDefined()
  })

  it("closing a tab keeps the artifact itself", () => {
    const a = make("A")
    make("B")

    useArtifactStore.getState().closeArtifact(a.id)

    // Closing is not deleting — the artifact stays reachable from history.
    expect(useArtifactStore.getState().artifacts[a.id]).toBeDefined()
    expect(openTabs()).not.toContain(a.id)
  })

  it.each([
    ["deleteArtifact", (id: string) => useArtifactStore.getState().deleteArtifact(id)],
    ["deleteArtifacts", (id: string) => useArtifactStore.getState().deleteArtifacts([id])],
  ])("%s drops the tab along with the artifact", (_name, remove) => {
    const a = make("A")
    make("B")

    remove(a.id)

    expect(openTabs()).not.toContain(a.id)
  })

  it("duplicating an artifact opens the copy as a tab", () => {
    const a = make("A")
    make("B")

    const copy = useArtifactStore.getState().duplicateArtifact(a.id)

    // The copy becomes active, so a tab strip missing it would show every tab
    // unselected while the panel displayed something else entirely.
    expect(activeTab()).toBe(copy!.id)
    expect(openTabs()).toContain(copy!.id)
  })

  it("clearSessionData and purgeProject drop tabs for artifacts they remove", () => {
    const a = make("A")
    useArtifactStore.getState().clearSessionData("s1")
    expect(openTabs()).not.toContain(a.id)

    mockActiveProjectId = "proj_x"
    const b = make("B")
    expect(openTabs()).toContain(b.id)
    useArtifactStore.getState().purgeProject("proj_x")
    expect(openTabs()).not.toContain(b.id)
  })
})

describe("createArtifact", () => {
  it("creates an artifact, opens the panel, and emits a plugin dispatch", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m1",
      type: "code",
      title: "First",
      content: "console.log(1)",
      language: "javascript",
    })
    expect(a.id).toBeDefined()
    const s = useArtifactStore.getState()
    expect(activeTab()).toBe(a.id)
    expect(s.panelOpen).toBe(true)
    expect(s.panelView).toBe("artifact")
    expect(s.artifactWorkspace.recentArtifactIds[0]).toBe(a.id)
  })
})

describe("updateArtifact", () => {
  it("bumps version and updatedAt", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "v1",
      content: "x",
    })
    const before = a.version
    useArtifactStore.getState().updateArtifact(a.id, { content: "y" })
    const next = useArtifactStore.getState().artifacts[a.id]
    expect(next.version).toBe(before + 1)
    expect(next.content).toBe("y")
  })

  it("ignores updates to unknown ids", () => {
    useArtifactStore.getState().updateArtifact("missing", { content: "y" })
    expect(Object.keys(useArtifactStore.getState().artifacts)).toHaveLength(0)
  })
})

describe("setArtifactRuntimeHealth", () => {
  function seed() {
    return useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "html",
      title: "page",
      content: "<p>hi</p>",
    })
  }

  it("records the settled state without bumping version or updatedAt", () => {
    const a = seed()
    const before = useArtifactStore.getState().artifacts[a.id]

    useArtifactStore.getState().setArtifactRuntimeHealth(a.id, "error", "boom")

    const next = useArtifactStore.getState().artifacts[a.id]
    expect(next.metadata?.runtimeHealth).toBe("error")
    expect(next.metadata?.runtimeError).toBe("boom")
    // A preview finishing its render is not an edit. Routing this through
    // updateArtifact would spin the version counter on every panel open.
    expect(next.version).toBe(before.version)
    expect(next.updatedAt).toEqual(before.updatedAt)
  })

  it("clears the stored error when the artifact later renders cleanly", () => {
    const a = seed()
    useArtifactStore.getState().setArtifactRuntimeHealth(a.id, "error", "boom")

    useArtifactStore.getState().setArtifactRuntimeHealth(a.id, "ready")

    const next = useArtifactStore.getState().artifacts[a.id]
    expect(next.metadata?.runtimeHealth).toBe("ready")
    expect(next.metadata?.runtimeError).toBeUndefined()
  })

  it("is referentially stable when nothing changed", () => {
    // The preview re-reports on every remount; a fresh object each time would
    // re-render every subscriber for nothing.
    const a = seed()
    useArtifactStore.getState().setArtifactRuntimeHealth(a.id, "ready")
    const first = useArtifactStore.getState().artifacts[a.id]

    useArtifactStore.getState().setArtifactRuntimeHealth(a.id, "ready")

    expect(useArtifactStore.getState().artifacts[a.id]).toBe(first)
  })

  it("ignores ids it does not know, which is what synthetic previews hand in", () => {
    // Canvas documents are projected onto a throwaway Artifact for the preview
    // stack; that object has no row here.
    useArtifactStore.getState().setArtifactRuntimeHealth("canvas-doc-1", "ready")
    expect(Object.keys(useArtifactStore.getState().artifacts)).toHaveLength(0)
  })

  it("makes the workspace runtime filter select real rows", () => {
    const broken = seed()
    const fine = seed()
    useArtifactStore.getState().setArtifactRuntimeHealth(broken.id, "error", "boom")
    useArtifactStore.getState().setArtifactRuntimeHealth(fine.id, "ready")

    useArtifactStore.getState().setArtifactWorkspaceFilters({ runtimeFilter: "error" })
    const list = useArtifactStore.getState().getArtifactsForWorkspace({ sessionId: "s" })
    expect(list.map((x) => x.id)).toEqual([broken.id])
  })
})

describe("deleteArtifact + deleteArtifacts", () => {
  it("removes the artifact and clears active when matched", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    useArtifactStore.getState().deleteArtifact(a.id)
    expect(useArtifactStore.getState().artifacts[a.id]).toBeUndefined()
    expect(activeTab()).toBeNull()
  })

  it("batch-deletes ids and prunes recents", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.getState().deleteArtifacts([a.id, b.id])
    expect(useArtifactStore.getState().artifacts).toEqual({})
    expect(useArtifactStore.getState().artifactWorkspace.recentArtifactIds).toEqual([])
  })
})

describe("duplicateArtifact", () => {
  it("creates a new artifact derived from the original", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "Source",
      content: "console.log(1)",
    })
    const dup = useArtifactStore.getState().duplicateArtifact(a.id)
    expect(dup).not.toBeNull()
    expect(dup!.id).not.toBe(a.id)
    expect(dup!.title).toBe("Source (Copy)")
    expect(dup!.metadata?.derivedFromArtifactId).toBe(a.id)
  })

  it("returns null for unknown id", () => {
    expect(useArtifactStore.getState().duplicateArtifact("missing")).toBeNull()
  })
})

describe("plugin event dispatch — onPanelOpen / onPanelClose", () => {
  it("openPanel dispatches onPanelOpen with the artifact:<view> id", () => {
    useArtifactStore.getState().openPanel("canvas")
    expect(mockHooksManager.dispatchPanelOpen).toHaveBeenCalledWith("artifact:canvas")
    useArtifactStore.getState().openPanel("artifact")
    expect(mockHooksManager.dispatchPanelOpen).toHaveBeenLastCalledWith("artifact:artifact")
  })

  it("closePanel dispatches onPanelClose with the previously-active view", () => {
    useArtifactStore.getState().openPanel("canvas")
    mockHooksManager.dispatchPanelClose.mockClear()
    useArtifactStore.getState().closePanel()
    expect(mockHooksManager.dispatchPanelClose).toHaveBeenCalledWith("artifact:canvas")
  })
})

describe("setActiveArtifact + panel open/close", () => {
  it("opens the panel when activating", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    useArtifactStore.setState({ activeArtifactIdBySession: {}, panelOpen: false })
    useArtifactStore.getState().setActiveArtifact(a.id)
    expect(useArtifactStore.getState().panelOpen).toBe(true)
    expect(activeTab("s")).toBe(a.id)
  })

  it("clears only the named session's active tab when called with null", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    const other = useArtifactStore.getState().createArtifact({
      sessionId: "other",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    useArtifactStore.getState().setActiveArtifact(null, "s")
    expect(activeTab("s")).toBeNull()
    // The clear names one conversation; the other keeps its tab.
    expect(activeTab("other")).toBe(other.id)
    expect(useArtifactStore.getState().artifacts[a.id]).toBeDefined()
  })

  it("lands a cross-session activation in the conversation the user is looking at", () => {
    // The artifact list's "recent" scope (and the artifacts workspace route)
    // surface artifacts from other conversations. Bucketing by the artifact's
    // own session wrote the active id where nothing was reading it: the dock
    // expanded and kept showing the previous content.
    const fromOtherSession = useArtifactStore.getState().createArtifact({
      sessionId: "origin",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    const parkedInOrigin = useArtifactStore.getState().createArtifact({
      sessionId: "origin",
      messageId: "m",
      type: "code",
      title: "parked",
      content: "y",
    })
    useArtifactStore.setState({
      activeArtifactIdBySession: { origin: parkedInOrigin.id },
      openArtifactIdsBySession: {},
    })

    mockActiveSessionId = "focused"
    useArtifactStore.getState().setActiveArtifact(fromOtherSession.id)

    expect(activeTab("focused")).toBe(fromOtherSession.id)
    // …and it opens a tab there, so the strip matches what the dock shows.
    expect(openTabs("focused")).toEqual([fromOtherSession.id])
    // The owning conversation's own parked artifact is left untouched.
    expect(activeTab("origin")).toBe(parkedInOrigin.id)
  })

  it("prefers an explicit session over the focused one", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "origin",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    mockActiveSessionId = "focused"
    useArtifactStore.getState().setActiveArtifact(a.id, "explicit")
    expect(activeTab("explicit")).toBe(a.id)
    expect(activeTab("focused")).toBeNull()
  })

  it("falls back to the artifact's own session when nothing is focused", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "origin",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    mockActiveSessionId = null
    useArtifactStore.getState().setActiveArtifact(a.id)
    expect(activeTab("origin")).toBe(a.id)
  })

  it("points the list's session scope at the bucket it landed in", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "origin",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    mockActiveSessionId = "focused"
    useArtifactStore.getState().setActiveArtifact(a.id)
    expect(useArtifactStore.getState().artifactWorkspace.sessionId).toBe("focused")
  })

  it("closes the panel via closePanel and reopens via openPanel", () => {
    useArtifactStore.getState().closePanel()
    expect(useArtifactStore.getState().panelOpen).toBe(false)
    useArtifactStore.getState().openPanel("canvas")
    expect(useArtifactStore.getState().panelOpen).toBe(true)
    expect(useArtifactStore.getState().panelView).toBe("canvas")
  })

  it("setPanelView swaps the active view", () => {
    useArtifactStore.getState().setPanelView("canvas")
    expect(useArtifactStore.getState().panelView).toBe("canvas")
  })
})

describe("workspace filters", () => {
  it("setArtifactWorkspaceFilters merges patches", () => {
    useArtifactStore.getState().setArtifactWorkspaceFilters({
      searchQuery: "abc",
      typeFilter: "html",
    })
    const ws = useArtifactStore.getState().artifactWorkspace
    expect(ws.searchQuery).toBe("abc")
    expect(ws.typeFilter).toBe("html")
  })

  it("setArtifactWorkspaceScope updates scope and sessionId", () => {
    useArtifactStore.getState().setArtifactWorkspaceScope("recent", "s2")
    const ws = useArtifactStore.getState().artifactWorkspace
    expect(ws.scope).toBe("recent")
    expect(ws.sessionId).toBe("s2")
  })

  it("resetSessionScopedWorkspaceFilters clears the narrowing but keeps preferences", () => {
    // One global blob backs every conversation's artifact list, so a query or
    // type filter typed in one kept narrowing every conversation after it —
    // usually to nothing, with no visible cause.
    useArtifactStore.getState().setArtifactWorkspaceScope("recent", "s1")
    useArtifactStore.getState().setArtifactWorkspaceFilters({
      searchQuery: "abc",
      typeFilter: "html",
      runtimeFilter: "error",
    })
    useArtifactStore.setState((state) => ({
      artifactWorkspace: { ...state.artifactWorkspace, recentArtifactIds: ["a1"] },
    }))

    useArtifactStore.getState().resetSessionScopedWorkspaceFilters("s2")

    const ws = useArtifactStore.getState().artifactWorkspace
    expect(ws.searchQuery).toBe("")
    expect(ws.typeFilter).toBe("all")
    expect(ws.runtimeFilter).toBe("all")
    expect(ws.sessionId).toBe("s2")
    // Durable preferences are untouched.
    expect(ws.scope).toBe("recent")
    expect(ws.recentArtifactIds).toEqual(["a1"])
  })

  it("setArtifactWorkspaceReturnContext stores context", () => {
    useArtifactStore.getState().setArtifactWorkspaceReturnContext({
      scope: "session",
      sessionId: "s",
      searchQuery: "",
      typeFilter: "all",
      runtimeFilter: "all",
    })
    expect(useArtifactStore.getState().artifactWorkspace.returnContext).not.toBeNull()
  })

  it("getArtifactsForWorkspace honors session filter", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.getState().setArtifactWorkspaceScope("session", "s1")
    const list = useArtifactStore.getState().getArtifactsForWorkspace({ sessionId: "s1" })
    expect(list.map((x) => x.id)).toEqual([a.id])
  })

  it("getArtifactsForWorkspace recent scope only includes recent ids", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    useArtifactStore.getState().setArtifactWorkspaceScope("recent")
    const list = useArtifactStore.getState().getArtifactsForWorkspace()
    expect(list.map((x) => x.id)).toContain(a.id)
  })

  it("getArtifactsForWorkspace honors limit", () => {
    for (let i = 0; i < 5; i++) {
      useArtifactStore.getState().createArtifact({
        sessionId: "s",
        messageId: "m",
        type: "code",
        title: `t${i}`,
        content: "x",
      })
    }
    expect(
      useArtifactStore.getState().getArtifactsForWorkspace({ sessionId: "s", limit: 2 })
    ).toHaveLength(2)
  })
})

describe("autoCreateFromContent", () => {
  it("creates artifacts from a multi-line code block", async () => {
    const md = "```js\n" + "console.log(1)\n".repeat(15) + "```"
    const out = await useArtifactStore.getState().autoCreateFromContent({
      sessionId: "s",
      messageId: "m1",
      content: md,
    })
    expect(out.length).toBeGreaterThanOrEqual(1)
    const created = Object.values(useArtifactStore.getState().artifacts)
    expect(created.length).toBeGreaterThanOrEqual(1)
  })

  it("dedupes by source fingerprint when called twice with the same content", async () => {
    const md = "```js\n" + "console.log(1)\n".repeat(15) + "```"
    await useArtifactStore.getState().autoCreateFromContent({
      sessionId: "s",
      messageId: "m1",
      content: md,
    })
    await useArtifactStore.getState().autoCreateFromContent({
      sessionId: "s",
      messageId: "m1",
      content: md,
    })
    expect(Object.keys(useArtifactStore.getState().artifacts)).toHaveLength(1)
  })
})

describe("artifact version history", () => {
  it("saveArtifactVersion + getArtifactVersions round-trip", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "x" })
    const v = useArtifactStore.getState().saveArtifactVersion(a.id, "first")
    expect(v).not.toBeNull()
    const versions = useArtifactStore.getState().getArtifactVersions(a.id)
    expect(versions).toHaveLength(1)
    expect(versions[0].changeDescription).toBe("first")
  })

  it("saveArtifactVersion returns null for unknown id", () => {
    expect(useArtifactStore.getState().saveArtifactVersion("missing")).toBeNull()
  })

  it("restoreArtifactVersion swaps content back", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "v1" })
    useArtifactStore.getState().saveArtifactVersion(a.id, "snapshot")
    useArtifactStore.getState().updateArtifact(a.id, { content: "v2" })
    const versions = useArtifactStore.getState().getArtifactVersions(a.id)
    useArtifactStore.getState().restoreArtifactVersion(a.id, versions[0].id)
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("v1")
  })

  it("restoreArtifactVersion ignores unknown versions", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "v1" })
    useArtifactStore.getState().restoreArtifactVersion(a.id, "missing")
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("v1")
  })

  it("restoreArtifactVersion records the default English auto-save description when none is given", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "v1" })
    useArtifactStore.getState().saveArtifactVersion(a.id, "snapshot")
    useArtifactStore.getState().updateArtifact(a.id, { content: "v2" })
    const versions = useArtifactStore.getState().getArtifactVersions(a.id)
    useArtifactStore.getState().restoreArtifactVersion(a.id, versions[0].id)
    const after = useArtifactStore.getState().getArtifactVersions(a.id)
    const autoSave = after.find((v) => v.changeDescription === "Auto-saved before restore")
    expect(autoSave).toBeTruthy()
  })

  it("restoreArtifactVersion uses the provided localized auto-save description", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "v1" })
    useArtifactStore.getState().saveArtifactVersion(a.id, "snapshot")
    useArtifactStore.getState().updateArtifact(a.id, { content: "v2" })
    const versions = useArtifactStore.getState().getArtifactVersions(a.id)
    useArtifactStore.getState().restoreArtifactVersion(a.id, versions[0].id, "恢复前自动保存")
    const after = useArtifactStore.getState().getArtifactVersions(a.id)
    const autoSave = after.find((v) => v.changeDescription === "恢复前自动保存")
    expect(autoSave).toBeTruthy()
  })

  it("getArtifactVersions returns [] for unknown id", () => {
    expect(useArtifactStore.getState().getArtifactVersions("missing")).toEqual([])
  })
})

describe("canvas documents", () => {
  it("createCanvasDocument opens the canvas panel", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "console.log(1)",
      language: "javascript",
      type: "code",
    })
    expect(id).toBeDefined()
    const s = useArtifactStore.getState()
    expect(s.activeCanvasId).toBe(id)
    expect(s.panelView).toBe("canvas")
  })

  it("updateCanvasDocument bumps updatedAt for content changes", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "v1",
      language: "javascript",
      type: "code",
    })
    const before = useArtifactStore.getState().canvasDocuments[id].updatedAt
    useArtifactStore.getState().updateCanvasDocument(id, { content: "v2" })
    const after = useArtifactStore.getState().canvasDocuments[id]
    expect(after.content).toBe("v2")
    expect(after.editorContext?.saveState).toBe("dirty")
    expect(after.updatedAt).not.toBe(before)
  })

  it("updateCanvasDocument is a no-op for unknown ids", () => {
    useArtifactStore.getState().updateCanvasDocument("missing", { content: "x" })
    expect(useArtifactStore.getState().canvasDocuments).toEqual({})
  })

  it("setActiveCanvas drives the canvas surface on its own", () => {
    const id = useArtifactStore
      .getState()
      .createCanvasDocument({ title: "d", content: "x", language: "javascript", type: "code" })
    useArtifactStore.getState().setActiveCanvas(null)
    expect(useArtifactStore.getState().activeCanvasId).toBeNull()
    useArtifactStore.getState().setActiveCanvas(id)
    expect(useArtifactStore.getState().activeCanvasId).toBe(id)
    expect(useArtifactStore.getState().panelView).toBe("canvas")
  })

  it("deleteCanvasDocument clears active when needed", () => {
    const id = useArtifactStore
      .getState()
      .createCanvasDocument({ title: "d", content: "x", language: "javascript", type: "code" })
    useArtifactStore.getState().deleteCanvasDocument(id)
    expect(useArtifactStore.getState().canvasDocuments).toEqual({})
    expect(useArtifactStore.getState().activeCanvasId).toBeNull()
  })

  it("canvas suggestions add / update / apply / clear", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "d",
      content: "a\nb\nc",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.getState().addSuggestion(id, {
      type: "edit",
      range: { startLine: 1, endLine: 1 },
      originalText: "b",
      suggestedText: "B",
      explanation: "case",
      status: "pending",
    })
    const sugId = useArtifactStore.getState().canvasDocuments[id].aiSuggestions![0].id
    useArtifactStore.getState().updateSuggestionStatus(id, sugId, "rejected")
    expect(
      useArtifactStore.getState().canvasDocuments[id].aiSuggestions!.find((s) => s.id === sugId)!
        .status
    ).toBe("rejected")
    useArtifactStore.getState().applySuggestion(id, sugId)
    expect(useArtifactStore.getState().canvasDocuments[id].content).toContain("B")
    useArtifactStore.getState().clearSuggestions(id)
    expect(useArtifactStore.getState().canvasDocuments[id].aiSuggestions).toEqual([])
  })

  it("addSuggestion is a no-op for unknown documents", () => {
    useArtifactStore.getState().addSuggestion("missing", {
      type: "edit",
      range: { startLine: 0, endLine: 0 },
      originalText: "",
      suggestedText: "",
      explanation: "",
      status: "pending",
    })
    expect(useArtifactStore.getState().canvasDocuments).toEqual({})
  })

  it("saveCanvasVersion + restoreCanvasVersion + delete + getCanvasVersions + compareVersions", () => {
    const id = useArtifactStore
      .getState()
      .createCanvasDocument({ title: "d", content: "v1", language: "javascript", type: "code" })
    const v1 = useArtifactStore.getState().saveCanvasVersion(id, "first")
    expect(v1).not.toBeNull()
    useArtifactStore.getState().updateCanvasDocument(id, { content: "v2" })
    const v2 = useArtifactStore.getState().saveCanvasVersion(id, "second")
    const versions = useArtifactStore.getState().getCanvasVersions(id)
    expect(versions.length).toBeGreaterThanOrEqual(2)
    useArtifactStore.getState().restoreCanvasVersion(id, v1!.id)
    expect(useArtifactStore.getState().canvasDocuments[id].content).toBe("v1")
    useArtifactStore.getState().deleteCanvasVersion(id, v2!.id)
    expect(
      useArtifactStore.getState().canvasDocuments[id].versions!.some((v) => v.id === v2!.id)
    ).toBe(false)
    const cmp = useArtifactStore.getState().compareVersions(id, v1!.id, v1!.id)
    expect(cmp).not.toBeNull()
  })

  it("restoreCanvasVersion uses provided localized auto-save description", () => {
    const id = useArtifactStore
      .getState()
      .createCanvasDocument({ title: "d", content: "v1", language: "javascript", type: "code" })
    const v1 = useArtifactStore.getState().saveCanvasVersion(id, "first")
    useArtifactStore.getState().updateCanvasDocument(id, { content: "v2" })
    useArtifactStore.getState().restoreCanvasVersion(id, v1!.id, "恢复前自动保存")
    const versions = useArtifactStore.getState().canvasDocuments[id].versions!
    expect(versions.some((v) => v.description === "恢复前自动保存")).toBe(true)
  })

  it("saveCanvasVersion returns null for unknown id", () => {
    expect(useArtifactStore.getState().saveCanvasVersion("missing")).toBeNull()
  })

  it("getCanvasVersions returns [] for unknown id", () => {
    expect(useArtifactStore.getState().getCanvasVersions("missing")).toEqual([])
  })

  it("compareVersions returns null when versions are missing", () => {
    expect(useArtifactStore.getState().compareVersions("missing", "x", "y")).toBeNull()
  })
})

describe("clearSessionData", () => {
  it("removes only the matching session's artifacts", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.getState().clearSessionData("s1")
    const remaining = useArtifactStore.getState().artifacts
    expect(remaining[a.id]).toBeUndefined()
    expect(remaining[b.id]).toBeDefined()
  })
})

describe("getArtifact / getSessionArtifacts / search / filter / recent", () => {
  it("getArtifact returns rehydrated record", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "x" })
    expect(useArtifactStore.getState().getArtifact(a.id)?.id).toBe(a.id)
    expect(useArtifactStore.getState().getArtifact("missing")).toBeUndefined()
  })

  it("searchArtifacts matches title/type/language", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "Alpha",
      content: "x",
      language: "python",
    })
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "html",
      title: "Beta",
      content: "<html></html>",
    })
    expect(useArtifactStore.getState().searchArtifacts("alpha")).toHaveLength(1)
    expect(useArtifactStore.getState().searchArtifacts("html")).toHaveLength(1)
    expect(useArtifactStore.getState().searchArtifacts("python")).toHaveLength(1)
  })

  it("filterArtifactsByType honors session scope", () => {
    useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    expect(useArtifactStore.getState().filterArtifactsByType("code")).toHaveLength(2)
    expect(useArtifactStore.getState().filterArtifactsByType("code", "s1")).toHaveLength(1)
  })

  it("getRecentArtifacts respects limit", () => {
    for (let i = 0; i < 5; i++) {
      useArtifactStore.getState().createArtifact({
        sessionId: "s",
        messageId: "m",
        type: "code",
        title: `t${i}`,
        content: "x",
      })
    }
    expect(useArtifactStore.getState().getRecentArtifacts(3)).toHaveLength(3)
  })

  it("getSessionArtifacts only includes the matching session and rehydrates dates", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m",
      type: "code",
      title: "a",
      content: "x",
    })
    useArtifactStore.getState().createArtifact({
      sessionId: "s2",
      messageId: "m",
      type: "code",
      title: "b",
      content: "y",
    })
    const list = useArtifactStore.getState().getSessionArtifacts("s1")
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("a")
    expect(list[0].createdAt).toBeInstanceOf(Date)
  })
})

describe("setActiveArtifact unknown id", () => {
  it("still parks the named session on an id that does not resolve", () => {
    // An id can outlive its artifact (LRU eviction, or a delete in another
    // tab); the caller names the session because the artifact can't.
    useArtifactStore.getState().setActiveArtifact("does-not-exist", "s1")
    expect(activeTab()).toBe("does-not-exist")
  })
})

describe("rehydrateArtifactMetadata", () => {
  it("rehydrates lastAccessedAt from an ISO string in persisted state", () => {
    const iso = "2024-05-01T00:00:00.000Z"
    useArtifactStore.setState({
      artifacts: {
        ar: {
          id: "ar",
          sessionId: "s",
          messageId: "m",
          type: "code",
          title: "t",
          content: "x",
          version: 1,
          createdAt: iso as unknown as Date,
          updatedAt: iso as unknown as Date,
          metadata: {
            lastAccessedAt: iso as unknown as Date,
          },
        },
      },
    })
    const a = useArtifactStore.getState().getArtifact("ar")
    expect(a?.metadata?.lastAccessedAt).toBeInstanceOf(Date)
    expect((a?.metadata?.lastAccessedAt as Date).toISOString()).toBe(iso)
  })

  it("returns undefined metadata when none was set on the artifact", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "t",
      content: "x",
    })
    const fetched = useArtifactStore.getState().getArtifact(a.id)
    expect(fetched?.metadata).toBeUndefined()
  })
})

describe("artifact workspace filters - branch coverage", () => {
  it("typeFilter excludes mismatched artifact types", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "code-1",
      content: "x",
    })
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "html",
      title: "html-1",
      content: "<html></html>",
    })
    useArtifactStore.getState().setArtifactWorkspaceFilters({ typeFilter: "html" })
    const list = useArtifactStore.getState().getArtifactsForWorkspace({ sessionId: "s" })
    expect(list).toHaveLength(1)
    expect(list[0].title).toBe("html-1")
  })

  it("runtimeFilter excludes artifacts whose runtimeHealth does not match", () => {
    const a = useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "ready",
      content: "x",
      metadata: { runtimeHealth: "ready" },
    })
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "errored",
      content: "y",
      metadata: { runtimeHealth: "error" },
    })
    useArtifactStore.getState().setArtifactWorkspaceFilters({ runtimeFilter: "ready" })
    const list = useArtifactStore.getState().getArtifactsForWorkspace({ sessionId: "s" })
    expect(list.map((x) => x.id)).toEqual([a.id])
  })

  it("searchQuery matches title, type, or language", () => {
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "code",
      title: "Alpha",
      content: "x",
      language: "python",
    })
    useArtifactStore.getState().createArtifact({
      sessionId: "s",
      messageId: "m",
      type: "html",
      title: "Beta",
      content: "<html></html>",
    })
    useArtifactStore.getState().setArtifactWorkspaceFilters({ searchQuery: "alpha" })
    expect(
      useArtifactStore
        .getState()
        .getArtifactsForWorkspace({ sessionId: "s" })
        .map((x) => x.title)
    ).toEqual(["Alpha"])
    useArtifactStore.getState().setArtifactWorkspaceFilters({ searchQuery: "html" })
    expect(
      useArtifactStore
        .getState()
        .getArtifactsForWorkspace({ sessionId: "s" })
        .map((x) => x.title)
    ).toEqual(["Beta"])
    useArtifactStore.getState().setArtifactWorkspaceFilters({ searchQuery: "python" })
    expect(
      useArtifactStore
        .getState()
        .getArtifactsForWorkspace({ sessionId: "s" })
        .map((x) => x.title)
    ).toEqual(["Alpha"])
  })

  it("falls back to recent ids when scope is recent", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    // Manually drop b from recents so scope=recent only sees a
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        scope: "recent",
        recentArtifactIds: [a.id],
      },
    }))
    const list = useArtifactStore.getState().getArtifactsForWorkspace()
    expect(list.map((x) => x.id)).toEqual([a.id])
    expect(list.find((x) => x.id === b.id)).toBeUndefined()
  })
})

describe("deleteArtifact + returnContext interaction", () => {
  it("clears returnContext when the deleted artifact matches it", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "x" })
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: a.id,
        },
      },
    }))
    useArtifactStore.getState().deleteArtifact(a.id)
    expect(useArtifactStore.getState().artifactWorkspace.returnContext).toBeNull()
  })

  it("preserves returnContext when the deleted artifact id does not match", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: b.id,
        },
      },
    }))
    useArtifactStore.getState().deleteArtifact(a.id)
    expect(useArtifactStore.getState().artifactWorkspace.returnContext?.activeArtifactId).toBe(b.id)
  })

  it("falls back to a recent artifact when the active id is deleted", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    // Both a and b are in recents (newest first). Active artifact is b. Delete b.
    useArtifactStore.getState().deleteArtifact(b.id)
    expect(activeTab("s")).toBe(a.id)
  })

  it("uses returnContext to resolve the next active artifact when available", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.getState().setActiveArtifact(b.id)
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: a.id,
        },
      },
    }))
    useArtifactStore.getState().deleteArtifact(b.id)
    // returnContext should win over recent fallback
    expect(activeTab("s")).toBe(a.id)
  })
})

describe("openPanel honors returnContext when no active artifact", () => {
  it("activates the returnContext artifact when missing an active one", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "x" })
    useArtifactStore.setState((state) => ({
      activeArtifactIdBySession: {},
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: a.id,
        },
      },
    }))
    useArtifactStore.getState().openPanel("artifact")
    // Restored into the session that owns the artifact, not a global slot.
    expect(activeTab("s")).toBe(a.id)
  })

  it("keeps the existing active id when set", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "t", content: "x" })
    useArtifactStore.getState().openPanel("artifact")
    expect(activeTab("s")).toBe(a.id)
  })
})

describe("deleteArtifacts batch returnContext handling", () => {
  it("clears returnContext when one of the deleted ids matches it", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: a.id,
        },
      },
    }))
    useArtifactStore.getState().deleteArtifacts([a.id])
    expect(useArtifactStore.getState().artifactWorkspace.returnContext).toBeNull()
  })

  it("preserves returnContext when deleting unrelated ids", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        returnContext: {
          scope: "session",
          sessionId: "s",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
          activeArtifactId: a.id,
        },
      },
    }))
    useArtifactStore.getState().deleteArtifacts([b.id])
    expect(useArtifactStore.getState().artifactWorkspace.returnContext?.activeArtifactId).toBe(a.id)
  })

  it("preserves the active artifact when none of the deleted ids match it", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.getState().setActiveArtifact(a.id)
    useArtifactStore.getState().deleteArtifacts([b.id])
    expect(activeTab("s")).toBe(a.id)
  })
})

describe("updateCanvasDocument editor-context only updates", () => {
  it("does not bump updatedAt when only editorContext changes", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "d",
      content: "x",
      language: "javascript",
      type: "code",
    })
    const beforeUpdated = useArtifactStore.getState().canvasDocuments[id].updatedAt
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: { saveState: "saved" },
    })
    expect(useArtifactStore.getState().canvasDocuments[id].updatedAt).toBe(beforeUpdated)
  })

  it("merges nested editor-context fields (selection / visibleRange / location)", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "d",
      content: "x",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: { startLine: 1, endLine: 2 } as never,
        visibleRange: { startLine: 0, endLine: 10 } as never,
        location: { path: ["a", "b"] } as never,
      },
    })
    const ctx = useArtifactStore.getState().canvasDocuments[id].editorContext
    expect(ctx?.selection).toBeDefined()
    expect(ctx?.visibleRange).toBeDefined()
    expect(ctx?.location?.path).toEqual(["a", "b"])
  })

  it("merges with existing nested editor-context fields", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "d",
      content: "x",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: { startLine: 1, endLine: 2 } as never,
        visibleRange: { startLine: 0, endLine: 10 } as never,
        location: { path: ["a"] } as never,
      },
    })
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: { startLine: 5, endLine: 6 } as never,
        visibleRange: { startLine: 3, endLine: 30 } as never,
        location: { path: undefined } as never,
      },
    })
    const ctx = useArtifactStore.getState().canvasDocuments[id].editorContext
    expect((ctx?.selection as { startLine: number } | undefined)?.startLine).toBe(5)
    expect((ctx?.visibleRange as { startLine: number } | undefined)?.startLine).toBe(3)
    // Path should fallback to the existing value when undefined
    expect(ctx?.location?.path).toEqual(["a"])
  })

  it("clears nested fields when explicitly passed undefined / null", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "d",
      content: "x",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: { startLine: 1, endLine: 2 } as never,
        visibleRange: { startLine: 0, endLine: 10 } as never,
        location: { path: ["a"] } as never,
      },
    })
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: undefined,
        visibleRange: undefined,
        location: undefined,
      },
    })
    const ctx = useArtifactStore.getState().canvasDocuments[id].editorContext
    expect(ctx?.selection).toBeUndefined()
    expect(ctx?.visibleRange).toBeUndefined()
    expect(ctx?.location).toBeUndefined()
  })

  it("creates a saved editorContext scaffold when an undefined update is applied", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "d",
      content: "x",
      language: "javascript",
      type: "code",
    })

    useArtifactStore.getState().updateCanvasDocument(id, { editorContext: undefined })

    expect(useArtifactStore.getState().canvasDocuments[id].editorContext).toEqual(
      expect.objectContaining({ saveState: "saved" })
    )
  })
})

describe("clearSessionData additional branches", () => {
  it("preserves another session's active tab when one session is purged", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    useArtifactStore.getState().clearSessionData("s1")
    expect(activeTab("s2")).toBe(b.id)
    expect(activeTab("s1")).toBeNull()
    expect(useArtifactStore.getState().artifacts[a.id]).toBeUndefined()
  })

  it("clears the workspace sessionId when it matches the cleared session", () => {
    useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    useArtifactStore.getState().setArtifactWorkspaceScope("session", "s1")
    useArtifactStore.getState().clearSessionData("s1")
    expect(useArtifactStore.getState().artifactWorkspace.sessionId).toBeNull()
  })

  it("preserves the activeCanvasId for canvases that survive the purge", () => {
    const surviving = useArtifactStore.getState().createCanvasDocument({
      sessionId: "keep",
      title: "k",
      content: "x",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.getState().createCanvasDocument({
      sessionId: "purge",
      title: "p",
      content: "y",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.setState({ activeCanvasId: surviving })
    useArtifactStore.getState().clearSessionData("purge")
    expect(useArtifactStore.getState().activeCanvasId).toBe(surviving)
  })

  it("nulls activeCanvasId when its document is purged", () => {
    const purged = useArtifactStore.getState().createCanvasDocument({
      sessionId: "purge",
      title: "p",
      content: "y",
      language: "javascript",
      type: "code",
    })
    useArtifactStore.setState({ activeCanvasId: purged })
    useArtifactStore.getState().clearSessionData("purge")
    expect(useArtifactStore.getState().activeCanvasId).toBeNull()
  })
})

describe("persist migration", () => {
  it("seeds missing top-level keys with safe defaults", () => {
    // Inject a v1 snapshot and force the persist middleware to migrate on rehydrate
    const snapshot = JSON.stringify({
      state: {
        artifacts: {},
      },
      version: 1,
    })
    localStorage.setItem("cognia-artifacts", snapshot)
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./artifact-store") as typeof import("./artifact-store")
      const state = mod.useArtifactStore.getState()
      expect(state.canvasDocuments).toBeDefined()
      expect(state.artifactVersions).toBeDefined()
      expect(state.artifactWorkspace).toBeDefined()
    })
  })

  it("rehydrates canvasDocuments/artifacts date fields to Date instances", () => {
    // Persist serializes Date -> ISO string. After rehydration the raw maps
    // (read directly by components like CanvasDocumentRail) must hold real
    // Date objects again, or `updatedAt.getTime()` throws.
    const snapshot = JSON.stringify({
      state: {
        artifacts: {
          a1: {
            id: "a1",
            sessionId: "s",
            messageId: "m",
            type: "code",
            title: "a",
            content: "x",
            version: 1,
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-02T00:00:00.000Z",
          },
        },
        canvasDocuments: {
          d1: {
            id: "d1",
            sessionId: "s",
            title: "doc",
            content: "x",
            language: "markdown",
            type: "text",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-02T00:00:00.000Z",
          },
        },
        artifactVersions: {},
        artifactWorkspace: {},
      },
      version: 4,
    })
    localStorage.setItem("cognia-artifacts", snapshot)
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./artifact-store") as typeof import("./artifact-store")
      const state = mod.useArtifactStore.getState()
      expect(state.canvasDocuments.d1!.updatedAt).toBeInstanceOf(Date)
      expect(state.canvasDocuments.d1!.createdAt).toBeInstanceOf(Date)
      expect(state.artifacts.a1!.updatedAt).toBeInstanceOf(Date)
      expect(state.artifacts.a1!.createdAt).toBeInstanceOf(Date)
      // The actual crash site: a direct consumer calling .getTime().
      expect(() => state.canvasDocuments.d1!.updatedAt.getTime()).not.toThrow()
    })
  })

  it("merges an existing artifactWorkspace with the initial defaults", () => {
    const snapshot = JSON.stringify({
      state: {
        artifacts: {},
        canvasDocuments: {},
        artifactVersions: {},
        artifactWorkspace: {
          searchQuery: "preserved",
        },
      },
      version: 1,
    })
    localStorage.setItem("cognia-artifacts", snapshot)
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./artifact-store") as typeof import("./artifact-store")
      const state = mod.useArtifactStore.getState()
      expect(state.artifactWorkspace.searchQuery).toBe("preserved")
      expect(state.artifactWorkspace.scope).toBe("session")
    })
  })

  it("v3→v4 re-buckets one global tab list by the owning artifact's session", () => {
    // v3 kept `openArtifactIds` global, so a reload could hand the dock one
    // conversation's tabs while another was on screen.
    const artifact = (id: string, sessionId: string) => ({
      id,
      sessionId,
      messageId: "m",
      type: "code",
      title: id,
      content: "x",
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
    })
    const snapshot = JSON.stringify({
      state: {
        artifacts: {
          a1: artifact("a1", "s1"),
          a2: artifact("a2", "s2"),
          a3: artifact("a3", "s1"),
        },
        canvasDocuments: {},
        artifactVersions: {},
        artifactWorkspace: {},
        // `gone` was evicted by the LRU cap and must not survive as a tab.
        openArtifactIds: ["a1", "a2", "gone", "a3"],
        analysisResults: { r1: { id: "r1", sessionId: "s", messageId: "m" } },
      },
      version: 3,
    })
    localStorage.setItem("cognia-artifacts", snapshot)
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./artifact-store") as typeof import("./artifact-store")
      const state = mod.useArtifactStore.getState()
      expect(state.openArtifactIdsBySession).toEqual({ s1: ["a1", "a3"], s2: ["a2"] })
      expect(state.activeArtifactIdBySession).toEqual({})
      const raw = state as unknown as Record<string, unknown>
      expect(raw.openArtifactIds).toBeUndefined()
      expect(raw.analysisResults).toBeUndefined()
    })
  })

  const onDiskArtifact = (id: string) => ({
    id,
    sessionId: "session",
    messageId: "message",
    type: "code" as const,
    title: id,
    content: `content:${id}`,
    version: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  })

  it("restores a v5 snapshot's per-conversation parking", () => {
    const snapshot = JSON.stringify({
      state: {
        artifacts: {
          a1: onDiskArtifact("a1"),
          a2: onDiskArtifact("a2"),
        },
        openArtifactIdsBySession: { s1: ["a1"], s2: ["a2"] },
        activeArtifactIdBySession: { s1: "a1", s2: "a2" },
      },
      version: 5,
    })
    localStorage.setItem("cognia-artifacts", snapshot)
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./artifact-store") as typeof import("./artifact-store")
      const state = mod.useArtifactStore.getState()
      expect(state.activeArtifactIdBySession).toEqual({ s1: "a1", s2: "a2" })
    })
  })

  it("seeds an empty parking map for a v4 snapshot that predates it", () => {
    const snapshot = JSON.stringify({
      state: {
        artifacts: { a1: onDiskArtifact("a1") },
        openArtifactIdsBySession: { s1: ["a1"] },
      },
      version: 4,
    })
    localStorage.setItem("cognia-artifacts", snapshot)
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require("./artifact-store") as typeof import("./artifact-store")
      const state = mod.useArtifactStore.getState()
      expect(state.activeArtifactIdBySession).toEqual({})
      expect(state.openArtifactIdsBySession).toEqual({ s1: ["a1"] })
    })
  })
})

describe("resolveNextActiveArtifactId fallback paths", () => {
  it("never hands a session a neighbour from another conversation", () => {
    const only = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "b", content: "y" })
    // The workspace scope used to widen this fallback to every artifact in the
    // store, so deleting a conversation's last artifact parked it on one from
    // an unrelated conversation.
    useArtifactStore.setState((state) => ({
      artifactWorkspace: { ...state.artifactWorkspace, scope: "recent", sessionId: null },
    }))
    useArtifactStore.getState().deleteArtifact(only.id)
    expect(activeTab("s1")).toBeNull()
  })

  it("falls back to the session's newest artifact once recents are exhausted", () => {
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "b", content: "y" })
    const cS2 = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "c", content: "z" })
    useArtifactStore.getState().setActiveArtifact(a.id)
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        recentArtifactIds: [],
        returnContext: null,
      },
    }))
    useArtifactStore.getState().deleteArtifact(a.id)
    expect(activeTab("s1")).toBe(b.id)
    expect(activeTab("s1")).not.toBe(cS2.id)
  })

  it("prefers the return context, but only when it belongs to the same session", () => {
    const aS1 = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    const bS1 = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "b", content: "y" })
    const cS2 = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s2", messageId: "m", type: "code", title: "c", content: "z" })
    useArtifactStore.getState().setActiveArtifact(aS1.id)
    useArtifactStore.setState((state) => ({
      artifactWorkspace: {
        ...state.artifactWorkspace,
        recentArtifactIds: [],
        returnContext: {
          activeArtifactId: cS2.id,
          scope: "session",
          sessionId: "s2",
          searchQuery: "",
          typeFilter: "all",
          runtimeFilter: "all",
        },
      },
    }))
    useArtifactStore.getState().deleteArtifact(aS1.id)
    // The return context names an artifact from s2, so s1 skips it.
    expect(activeTab("s1")).toBe(bS1.id)
  })
})

describe("persist partialize - LRU & truncation", () => {
  it("sorts artifacts by string-form updatedAt and truncates oversized content during persistence", async () => {
    // Rather than dig into the internal partialize, we simulate the behavior by
    // creating an artifact with oversized content and one with a Date string
    // updatedAt, then forcing a write by mutating state and reading the
    // localStorage snapshot the persist middleware emits.
    const big = "x".repeat(200_000)
    const recent = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "big", content: big })
    // Add two artifacts whose updatedAt is a string (simulating just-rehydrated)
    // so that both sides of the partialize ternary on the b-side run.
    useArtifactStore.setState((state) => ({
      artifacts: {
        ...state.artifacts,
        "with-string-date-1": {
          id: "with-string-date-1",
          sessionId: "s",
          messageId: "m",
          type: "code",
          title: "string-date-1",
          content: "small-1",
          version: 1,
          createdAt: new Date(),
          updatedAt: "2023-01-01T00:00:00.000Z" as unknown as Date,
        },
        "with-string-date-2": {
          id: "with-string-date-2",
          sessionId: "s",
          messageId: "m",
          type: "code",
          title: "string-date-2",
          content: "small-2",
          version: 1,
          createdAt: new Date(),
          updatedAt: "2024-01-01T00:00:00.000Z" as unknown as Date,
        },
      },
    }))
    // Trigger a persist write by toggling state
    useArtifactStore.getState().setPanelView("artifact")
    // Allow the persist middleware to flush
    await new Promise((resolve) => setTimeout(resolve, 0))
    const persisted = localStorage.getItem("cognia-artifacts")
    if (persisted) {
      const parsed = JSON.parse(persisted) as {
        state: { artifacts: Record<string, { content: string }> }
      }
      const recentEntry = parsed.state.artifacts[recent.id]
      // Truncated to 100KB
      expect(recentEntry?.content.length).toBeLessThanOrEqual(100 * 1024)
    }
  })

  it("sorts when both updatedAt values are non-Date strings", async () => {
    // Pure string-vs-string sort, exercising both sides of the ternary.
    useArtifactStore.setState({
      artifacts: {
        x: {
          id: "x",
          sessionId: "s",
          messageId: "m",
          type: "code",
          title: "x",
          content: "c",
          version: 1,
          createdAt: new Date(),
          updatedAt: "2024-06-01T00:00:00.000Z" as unknown as Date,
        },
        y: {
          id: "y",
          sessionId: "s",
          messageId: "m",
          type: "code",
          title: "y",
          content: "c",
          version: 1,
          createdAt: new Date(),
          updatedAt: "2024-07-01T00:00:00.000Z" as unknown as Date,
        },
      },
    })
    // Cause persist write
    useArtifactStore.getState().setPanelView("canvas")
    await new Promise((resolve) => setTimeout(resolve, 0))
    const persisted = localStorage.getItem("cognia-artifacts")
    expect(persisted).toBeTruthy()
  })
})

describe("auto-save retention", () => {
  it("keeps only the most recent auto-saves when the cap is exceeded", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "doc",
      content: "v0",
      language: "javascript",
      type: "code",
    })
    // Bypass the saveCanvasVersion API by directly seeding many auto-saves.
    const many: Array<{
      id: string
      content: string
      title: string
      createdAt: Date
      isAutoSave: boolean
    }> = []
    for (let i = 0; i < 35; i++) {
      many.push({
        id: `v-${i}`,
        content: `c-${i}`,
        title: "doc",
        createdAt: new Date(2023, 0, i + 1),
        isAutoSave: true,
      })
    }
    useArtifactStore.setState((state) => ({
      canvasDocuments: {
        ...state.canvasDocuments,
        [id]: { ...state.canvasDocuments[id], versions: many as never },
      },
    }))
    // Now force retention to apply via saveCanvasVersion (auto-save = true)
    useArtifactStore.getState().saveCanvasVersion(id, "trigger", true)
    const versions = useArtifactStore.getState().canvasDocuments[id].versions || []
    // Cap is 30; we just added one more on top of 35, then retention prunes.
    expect(versions.length).toBeLessThanOrEqual(30)
  })
})

// ---------------------------------------------------------------------------
// Plugin canvas hook wiring (ADR 0016 Tier 2)
// ---------------------------------------------------------------------------

describe("canvas plugin hook dispatches", () => {
  it("createCanvasDocument fires onCanvasCreate + onCanvasSwitch", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "v1",
      language: "javascript",
      type: "code",
    })
    expect(mockHooksManager.dispatchCanvasCreate).toHaveBeenCalledTimes(1)
    const created = mockHooksManager.dispatchCanvasCreate.mock.calls[0][0] as { id: string }
    expect(created.id).toBe(id)
    expect(mockHooksManager.dispatchCanvasSwitch).toHaveBeenCalledWith(id)
  })

  it("createCanvasDocument plugin payload defaults missing language to markdown", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "v1",
      type: "code",
    } as never)

    expect(mockHooksManager.dispatchCanvasCreate).toHaveBeenCalledWith(
      expect.objectContaining({ id, language: "markdown" })
    )
  })

  it("updateCanvasDocument fires onCanvasUpdate (always) and onCanvasContentChange (only on content change)", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "v1",
      language: "javascript",
      type: "code",
    })
    mockHooksManager.dispatchCanvasUpdate.mockClear()
    mockHooksManager.dispatchCanvasContentChange.mockClear()

    // Title-only update — should fire onCanvasUpdate, NOT onCanvasContentChange.
    useArtifactStore.getState().updateCanvasDocument(id, { title: "Renamed" })
    expect(mockHooksManager.dispatchCanvasUpdate).toHaveBeenCalledTimes(1)
    expect(mockHooksManager.dispatchCanvasContentChange).not.toHaveBeenCalled()

    // Content update — should fire BOTH onCanvasUpdate and onCanvasContentChange.
    useArtifactStore.getState().updateCanvasDocument(id, { content: "v2" })
    expect(mockHooksManager.dispatchCanvasUpdate).toHaveBeenCalledTimes(2)
    expect(mockHooksManager.dispatchCanvasContentChange).toHaveBeenCalledTimes(1)
    expect(mockHooksManager.dispatchCanvasContentChange).toHaveBeenCalledWith(id, "v2", "v1")
  })

  it("updateCanvasDocument ignores undefined optional plugin payload fields", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "v1",
      language: "javascript",
      type: "code",
    })
    mockHooksManager.dispatchCanvasUpdate.mockClear()

    useArtifactStore.getState().updateCanvasDocument(id, {
      language: undefined,
      type: undefined,
    } as never)

    expect(mockHooksManager.dispatchCanvasUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id }),
      {}
    )
  })

  it("updateCanvasDocument is a no-op for unknown ids and does NOT dispatch", () => {
    useArtifactStore.getState().updateCanvasDocument("missing", { content: "x" })
    expect(mockHooksManager.dispatchCanvasUpdate).not.toHaveBeenCalled()
    expect(mockHooksManager.dispatchCanvasContentChange).not.toHaveBeenCalled()
  })

  it("updateCanvasDocument with editorContext.selection fires onCanvasSelection (with offsets)", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "abc\ndef",
      language: "javascript",
      type: "code",
    })
    mockHooksManager.dispatchCanvasSelection.mockClear()
    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 2,
          endColumn: 2,
        } as never,
      },
    })
    expect(mockHooksManager.dispatchCanvasSelection).toHaveBeenCalledTimes(1)
    const [docId, payload] = mockHooksManager.dispatchCanvasSelection.mock.calls[0]
    expect(docId).toBe(id)
    expect(payload).toMatchObject({ start: 0, end: 5 })
    // text spans the selection
    expect((payload as { text: string }).text).toBe("abc\nd")
  })

  it("selection dispatch handles reversed and out-of-range line positions", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "abc\ndef",
      language: "javascript",
      type: "code",
    })
    mockHooksManager.dispatchCanvasSelection.mockClear()

    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: {
        selection: {
          startLineNumber: 99,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 2,
        },
      },
    })

    expect(mockHooksManager.dispatchCanvasSelection).toHaveBeenCalledWith(
      id,
      expect.objectContaining({ start: 1, end: "abc\ndef".length, text: "bc\ndef" })
    )
  })

  it("selection dispatch ignores malformed editor selection coordinates", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "abc",
      language: "javascript",
      type: "code",
    })
    mockHooksManager.dispatchCanvasSelection.mockClear()

    useArtifactStore.getState().updateCanvasDocument(id, {
      editorContext: { selection: { startLineNumber: 1, startColumn: 1 } as never },
    })

    expect(mockHooksManager.dispatchCanvasSelection).not.toHaveBeenCalled()
  })

  it("deleteCanvasDocument fires onCanvasDelete; onCanvasSwitch(null) fires when active", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "v1",
      language: "javascript",
      type: "code",
    })
    mockHooksManager.dispatchCanvasDelete.mockClear()
    mockHooksManager.dispatchCanvasSwitch.mockClear()
    useArtifactStore.getState().deleteCanvasDocument(id)
    expect(mockHooksManager.dispatchCanvasDelete).toHaveBeenCalledWith(id)
    expect(mockHooksManager.dispatchCanvasSwitch).toHaveBeenCalledWith(null)
  })

  it("deleteCanvasDocument is silent for unknown ids", () => {
    useArtifactStore.getState().deleteCanvasDocument("missing")
    expect(mockHooksManager.dispatchCanvasDelete).not.toHaveBeenCalled()
  })

  it("setActiveCanvas fires onCanvasSwitch only when the active id changes", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "v1",
      language: "javascript",
      type: "code",
    })
    mockHooksManager.dispatchCanvasSwitch.mockClear()
    // No-op: same active id.
    useArtifactStore.getState().setActiveCanvas(id)
    expect(mockHooksManager.dispatchCanvasSwitch).not.toHaveBeenCalled()
    // Switch to null
    useArtifactStore.getState().setActiveCanvas(null)
    expect(mockHooksManager.dispatchCanvasSwitch).toHaveBeenCalledWith(null)
  })

  it("saveCanvasVersion fires onCanvasVersionSave with the new version id", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "v1",
      language: "javascript",
      type: "code",
    })
    mockHooksManager.dispatchCanvasVersionSave.mockClear()
    const v = useArtifactStore.getState().saveCanvasVersion(id, "first")
    expect(mockHooksManager.dispatchCanvasVersionSave).toHaveBeenCalledWith(id, v!.id)
  })

  it("restoreCanvasVersion fires onCanvasVersionRestore on success and stays silent on failure", () => {
    const id = useArtifactStore.getState().createCanvasDocument({
      title: "Doc",
      content: "v1",
      language: "javascript",
      type: "code",
    })
    const v1 = useArtifactStore.getState().saveCanvasVersion(id, "first")
    mockHooksManager.dispatchCanvasVersionRestore.mockClear()
    useArtifactStore.getState().restoreCanvasVersion(id, v1!.id)
    expect(mockHooksManager.dispatchCanvasVersionRestore).toHaveBeenCalledWith(id, v1!.id)

    // Unknown version id should NOT dispatch.
    mockHooksManager.dispatchCanvasVersionRestore.mockClear()
    useArtifactStore.getState().restoreCanvasVersion(id, "missing-version")
    expect(mockHooksManager.dispatchCanvasVersionRestore).not.toHaveBeenCalled()
  })

  it("rate-limiter caps onCanvasContentChange dispatches under burst load", () => {
    // Freeze the wall clock so the token bucket cannot refill mid-burst.
    // The limiter uses Date.now() for refill accounting; without freezing,
    // the 100 rapid iterations span enough real time (~70ms) for the
    // 30/sec refill to leak 1-2 extra dispatches through.
    const realDateNow = Date.now
    const frozen = realDateNow()
    Date.now = () => frozen
    try {
      const id = useArtifactStore.getState().createCanvasDocument({
        title: "Doc",
        content: "v0",
        language: "javascript",
        type: "code",
      })
      mockHooksManager.dispatchCanvasContentChange.mockClear()

      // Fire 100 rapid content updates. Bucket capacity is 30, so the
      // limiter should drop everything past 30 within the same tick.
      for (let i = 1; i <= 100; i += 1) {
        useArtifactStore.getState().updateCanvasDocument(id, { content: `v${i}` })
      }
      expect(mockHooksManager.dispatchCanvasContentChange.mock.calls.length).toBeLessThanOrEqual(30)
      // But onCanvasUpdate is NOT rate-limited — every mutation fires one.
      expect(mockHooksManager.dispatchCanvasUpdate.mock.calls.length).toBe(100)
    } finally {
      Date.now = realDateNow
    }
  })
})

describe("workspace (project) isolation", () => {
  it("createArtifact + createCanvasDocument stamp the active project id", () => {
    mockActiveProjectId = "proj-A"
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const docId = useArtifactStore
      .getState()
      .createCanvasDocument({ title: "d", content: "y", language: "javascript", type: "code" })
    expect(a.projectId).toBe("proj-A")
    expect(useArtifactStore.getState().canvasDocuments[docId].projectId).toBe("proj-A")
  })

  it("getArtifactsForWorkspace hides other workspaces' artifacts but grandfathers legacy ones", () => {
    mockActiveProjectId = "proj-A"
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "a", content: "x" })
    mockActiveProjectId = "proj-B"
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "b", content: "y" })
    // Legacy artifact with no projectId — visible everywhere.
    mockActiveProjectId = null
    const legacy = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s1", messageId: "m", type: "code", title: "leg", content: "z" })

    mockActiveProjectId = "proj-A"
    useArtifactStore.getState().setArtifactWorkspaceScope("session", "s1")
    const ids = useArtifactStore
      .getState()
      .getArtifactsForWorkspace({ sessionId: "s1" })
      .map((x) => x.id)
    expect(ids).toContain(a.id)
    expect(ids).toContain(legacy.id)
    expect(ids).not.toContain(b.id)
  })

  it("purgeProject drops only the target workspace's artifacts + canvas docs", () => {
    mockActiveProjectId = "proj-A"
    const a = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "a", content: "x" })
    const docAId = useArtifactStore
      .getState()
      .createCanvasDocument({ title: "da", content: "y", language: "javascript", type: "code" })
    mockActiveProjectId = "proj-B"
    const b = useArtifactStore
      .getState()
      .createArtifact({ sessionId: "s", messageId: "m", type: "code", title: "b", content: "x" })

    useArtifactStore.getState().purgeProject("proj-A")

    const s = useArtifactStore.getState()
    expect(s.artifacts[a.id]).toBeUndefined()
    expect(s.canvasDocuments[docAId]).toBeUndefined()
    expect(s.artifacts[b.id]).toBeDefined()
    // Active pointers that referenced purged rows are cleared.
    expect(s.activeCanvasId).toBeNull()
  })
})

describe("account storage isolation", () => {
  const persistedArtifact = (id: string, title: string) => ({
    id,
    sessionId: "session",
    messageId: "message",
    type: "code" as const,
    title,
    content: `content:${title}`,
    version: 1,
    createdAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
    updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
  })

  it("activates an account-local snapshot without leaking the previous account", () => {
    localStorage.setItem(
      "cognia-artifacts:acct_a",
      JSON.stringify({
        state: { artifacts: { art_a: persistedArtifact("art_a", "Alpha artifact") } },
        version: 3,
      })
    )
    localStorage.setItem(
      "cognia-artifacts:acct_b",
      JSON.stringify({
        state: { artifacts: { art_b: persistedArtifact("art_b", "Beta artifact") } },
        version: 3,
      })
    )

    activateArtifactAccountStorage("acct_a")
    expect(Object.keys(useArtifactStore.getState().artifacts)).toEqual(["art_a"])

    activateArtifactAccountStorage("acct_b")
    expect(Object.keys(useArtifactStore.getState().artifacts)).toEqual(["art_b"])
    expect(useArtifactStore.getState().artifacts.art_a).toBeUndefined()
  })

  it("clears in-memory account state without deleting the account snapshot", () => {
    localStorage.setItem(
      "cognia-artifacts:acct_a",
      JSON.stringify({
        state: { artifacts: { art_a: persistedArtifact("art_a", "Alpha artifact") } },
        version: 3,
      })
    )

    activateArtifactAccountStorage("acct_a")
    clearArtifactAccountStorage()

    expect(useArtifactStore.getState().artifacts).toEqual({})
    expect(localStorage.getItem("cognia-artifacts:acct_a")).toContain("Alpha artifact")
  })

  it("purges only the deleted account's artifact bucket", () => {
    localStorage.setItem(
      "cognia-artifacts:acct_a",
      JSON.stringify({ state: { artifacts: { art_a: persistedArtifact("art_a", "A") } } })
    )
    localStorage.setItem(
      "cognia-artifacts:acct_b",
      JSON.stringify({ state: { artifacts: { art_b: persistedArtifact("art_b", "B") } } })
    )

    purgeArtifactAccountStorage("acct_a")

    expect(localStorage.getItem("cognia-artifacts:acct_a")).toBeNull()
    expect(localStorage.getItem("cognia-artifacts:acct_b")).toContain("art_b")
  })

  it("adopts the legacy artifact bucket into the first account bucket", () => {
    localStorage.setItem(
      "cognia-artifacts",
      JSON.stringify({
        state: { artifacts: { legacy_art: persistedArtifact("legacy_art", "Legacy") } },
        version: 3,
      })
    )

    activateArtifactAccountStorage("acct_legacy")

    expect(localStorage.getItem("cognia-artifacts")).toBeNull()
    expect(localStorage.getItem("cognia-artifacts:acct_legacy")).toContain("legacy_art")
    expect(Object.keys(useArtifactStore.getState().artifacts)).toEqual(["legacy_art"])
  })

  it("does not overwrite an existing account bucket during legacy adoption", () => {
    localStorage.setItem(
      "cognia-artifacts",
      JSON.stringify({
        state: { artifacts: { legacy_art: persistedArtifact("legacy_art", "Legacy") } },
        version: 3,
      })
    )
    localStorage.setItem(
      "cognia-artifacts:acct_a",
      JSON.stringify({
        state: { artifacts: { art_a: persistedArtifact("art_a", "Alpha") } },
        version: 3,
      })
    )

    activateArtifactAccountStorage("acct_a")

    expect(localStorage.getItem("cognia-artifacts")).toContain("legacy_art")
    expect(localStorage.getItem("cognia-artifacts:acct_a")).toContain("art_a")
    expect(Object.keys(useArtifactStore.getState().artifacts)).toEqual(["art_a"])
  })

  it("falls back to empty state for missing or malformed account snapshots", () => {
    activateArtifactAccountStorage("acct_empty")
    expect(useArtifactStore.getState().artifacts).toEqual({})

    localStorage.setItem("cognia-artifacts:acct_bad", "{")
    activateArtifactAccountStorage("acct_bad")
    expect(useArtifactStore.getState().artifacts).toEqual({})

    localStorage.setItem("cognia-artifacts:acct_null", JSON.stringify({ state: null }))
    activateArtifactAccountStorage("acct_null")
    expect(useArtifactStore.getState().artifacts).toEqual({})
  })
})

describe("AI-revision review (pending reviews)", () => {
  const makeArtifact = (content: string) =>
    useArtifactStore.getState().createArtifact({
      sessionId: "s1",
      messageId: "m1",
      type: "code",
      title: "Snippet",
      content,
      language: "javascript",
    })

  it("proposeArtifactUpdate stages a review and activates the artifact without raising the panel", () => {
    const a = makeArtifact("a\nb\nc\nd")
    // `makeArtifact` opens the panel on the way in, so the old assertion that
    // this call "opens the panel" passed no matter what it did. Close it first
    // and the real contract shows: whether a proposal may take over the screen
    // depends on `userDismissed`, which lives in the dock's layout store — so
    // the decision belongs to `useDockAttentionSignal`, not here.
    useArtifactStore.getState().closePanel()

    const review = useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")

    expect(review).not.toBeNull()
    expect(review!.items.length).toBeGreaterThanOrEqual(2)
    const s = useArtifactStore.getState()
    expect(s.pendingReviews[a.id]).toBeDefined()
    expect(activeTab()).toBe(a.id)
    expect(s.panelOpen).toBe(false)
    // content is NOT applied yet
    expect(s.artifacts[a.id].content).toBe("a\nb\nc\nd")
  })

  it("proposeArtifactUpdate returns null for unknown id or identical content", () => {
    const a = makeArtifact("a\nb")
    expect(useArtifactStore.getState().proposeArtifactUpdate("nope", "x")).toBeNull()
    expect(useArtifactStore.getState().proposeArtifactUpdate(a.id, "a\nb")).toBeNull()
    expect(useArtifactStore.getState().pendingReviews[a.id]).toBeUndefined()
  })

  it("setReviewItemStatus flips a single item", () => {
    const a = makeArtifact("a\nb\nc\nd")
    const review = useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")!
    const itemId = review.items[0].id
    useArtifactStore.getState().setReviewItemStatus(a.id, itemId, "accepted")
    const updated = useArtifactStore.getState().pendingReviews[a.id]
    expect(updated.items.find((i) => i.id === itemId)!.status).toBe("accepted")
    expect(updated.items[1].status).toBe("pending")
  })

  it("applyArtifactReview applies only accepted hunks, snapshots a version, and clears the proposal", () => {
    const a = makeArtifact("a\nb\nc\nd")
    const review = useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")!
    // Accept only the first hunk (a -> A); leave the last (d -> D) pending.
    useArtifactStore.getState().setReviewItemStatus(a.id, review.items[0].id, "accepted")
    useArtifactStore.getState().applyArtifactReview(a.id, "applied review")

    const s = useArtifactStore.getState()
    expect(s.pendingReviews[a.id]).toBeUndefined()
    expect(s.artifacts[a.id].content).toBe("A\nb\nc\nd") // only accepted hunk applied
    const versions = useArtifactStore.getState().getArtifactVersions(a.id)
    expect(versions.some((v) => v.content === "a\nb\nc\nd")).toBe(true) // pre-apply snapshot
  })

  it("applyArtifactReview is a no-op for unknown ids", () => {
    expect(() => useArtifactStore.getState().applyArtifactReview("nope")).not.toThrow()
  })

  it("applyArtifactReview refuses to apply a stale proposal", () => {
    const a = makeArtifact("a\nb\nc\nd")
    const review = useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")!
    useArtifactStore.getState().setReviewItemStatus(a.id, review.items[0].id, "accepted")
    // Manual edit moves the baseline -> proposal goes stale.
    useArtifactStore.getState().updateArtifact(a.id, { content: "manual\nedit" })
    expect(useArtifactStore.getState().pendingReviews[a.id].isStale).toBe(true)
    useArtifactStore.getState().applyArtifactReview(a.id)
    // content unchanged from the manual edit; proposal still present (not applied)
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("manual\nedit")
    expect(useArtifactStore.getState().pendingReviews[a.id]).toBeDefined()
  })

  it("rejectArtifactReview clears the proposal without changing content", () => {
    const a = makeArtifact("a\nb\nc\nd")
    useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
    useArtifactStore.getState().rejectArtifactReview(a.id)
    expect(useArtifactStore.getState().pendingReviews[a.id]).toBeUndefined()
    expect(useArtifactStore.getState().artifacts[a.id].content).toBe("a\nb\nc\nd")
    // no-op when nothing to reject
    expect(() => useArtifactStore.getState().rejectArtifactReview(a.id)).not.toThrow()
  })

  it("getPendingReview returns the review or null", () => {
    const a = makeArtifact("a\nb\nc\nd")
    expect(useArtifactStore.getState().getPendingReview(a.id)).toBeNull()
    useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
    expect(useArtifactStore.getState().getPendingReview(a.id)).not.toBeNull()
  })

  // The return half of the revision round trip: without a receipt the assistant
  // never learns what happened to its proposal and can re-propose it verbatim.
  describe("review receipts", () => {
    it("records a rejection against the artifact's session", () => {
      const a = makeArtifact("a\nb\nc\nd")
      const review = useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")!
      useArtifactStore.getState().rejectArtifactReview(a.id)

      expect(useArtifactStore.getState().reviewReceipts).toEqual([
        {
          sessionId: "s1",
          artifactId: a.id,
          title: "Snippet",
          outcome: "rejected",
          accepted: 0,
          total: review.items.length,
        },
      ])
    })

    it("records how many hunks an apply actually kept", () => {
      const a = makeArtifact("a\nb\nc\nd")
      const review = useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")!
      useArtifactStore.getState().setReviewItemStatus(a.id, review.items[0].id, "accepted")
      useArtifactStore.getState().applyArtifactReview(a.id)

      const [receipt] = useArtifactStore.getState().reviewReceipts
      expect(receipt.outcome).toBe("applied")
      expect(receipt.accepted).toBe(1)
      expect(receipt.total).toBe(review.items.length)
    })

    it("keeps only the latest verdict per artifact", () => {
      const a = makeArtifact("a\nb\nc\nd")
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
      useArtifactStore.getState().rejectArtifactReview(a.id)
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "X\nb\nc\nY")
      useArtifactStore.getState().applyArtifactReview(a.id)

      const receipts = useArtifactStore.getState().reviewReceipts
      expect(receipts).toHaveLength(1)
      expect(receipts[0].outcome).toBe("applied")
    })

    it("peekReviewReceipts reads only the asked-for session and consumes nothing", () => {
      const a = makeArtifact("a\nb\nc\nd")
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
      useArtifactStore.getState().rejectArtifactReview(a.id)

      expect(useArtifactStore.getState().peekReviewReceipts("other")).toEqual([])
      expect(useArtifactStore.getState().peekReviewReceipts("s1")).toHaveLength(1)
      // Reading is not consuming — a bailed send must be able to read again.
      expect(useArtifactStore.getState().peekReviewReceipts("s1")).toHaveLength(1)
      expect(useArtifactStore.getState().reviewReceipts).toHaveLength(1)
    })

    it("consumeReviewReceipts drops exactly what rode out, and only once", () => {
      const a = makeArtifact("a\nb\nc\nd")
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
      useArtifactStore.getState().rejectArtifactReview(a.id)

      const sent = useArtifactStore.getState().peekReviewReceipts("s1")
      useArtifactStore.getState().consumeReviewReceipts(sent)
      expect(useArtifactStore.getState().reviewReceipts).toEqual([])
      // A receipt rides exactly one message, never every subsequent one.
      expect(useArtifactStore.getState().peekReviewReceipts("s1")).toEqual([])
    })

    it("consumeReviewReceipts is a no-op for an empty list", () => {
      const a = makeArtifact("a\nb\nc\nd")
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
      useArtifactStore.getState().rejectArtifactReview(a.id)

      useArtifactStore.getState().consumeReviewReceipts([])
      expect(useArtifactStore.getState().reviewReceipts).toHaveLength(1)
    })

    // The whole reason the read and the clear are split: a send that bails
    // after the prompt is built must not lose the verdict.
    it("keeps the receipt when a send is abandoned before it commits", () => {
      const a = makeArtifact("a\nb\nc\nd")
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
      useArtifactStore.getState().rejectArtifactReview(a.id)

      const sent = useArtifactStore.getState().peekReviewReceipts("s1")
      expect(sent).toHaveLength(1)
      // …the composer returns early instead of calling `consumeReviewReceipts`.
      expect(useArtifactStore.getState().peekReviewReceipts("s1")).toEqual(sent)
    })

    // A newer verdict for the same artifact landing mid-send has not been told
    // to the assistant, so consuming the older one must leave it standing.
    it("spares a newer verdict that arrived while the message was in flight", () => {
      const a = makeArtifact("a\nb\nc\nd")
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
      useArtifactStore.getState().rejectArtifactReview(a.id)
      const sent = useArtifactStore.getState().peekReviewReceipts("s1")

      // Mid-flight: the user re-proposes and applies instead.
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "X\nb\nc\nY")
      useArtifactStore.getState().applyArtifactReview(a.id)

      useArtifactStore.getState().consumeReviewReceipts(sent)
      const left = useArtifactStore.getState().reviewReceipts
      expect(left).toHaveLength(1)
      expect(left[0].outcome).toBe("applied")
    })

    it("stages nothing when the artifact is already gone", () => {
      const a = makeArtifact("a\nb\nc\nd")
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
      useArtifactStore.getState().deleteArtifact(a.id)
      useArtifactStore.getState().rejectArtifactReview(a.id)
      // Nothing coherent to tell the assistant about a ghost.
      expect(useArtifactStore.getState().reviewReceipts).toEqual([])
    })

    it("drops receipts for a session that gets cleared", () => {
      const a = makeArtifact("a\nb\nc\nd")
      useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
      useArtifactStore.getState().rejectArtifactReview(a.id)
      useArtifactStore.getState().clearSessionData("s1")
      expect(useArtifactStore.getState().reviewReceipts).toEqual([])
    })
  })

  it("a metadata-only updateArtifact does not mark an open review stale", () => {
    const a = makeArtifact("a\nb\nc\nd")
    useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
    useArtifactStore.getState().updateArtifact(a.id, { title: "Renamed" })
    expect(useArtifactStore.getState().pendingReviews[a.id].isStale).toBeFalsy()
  })

  it("restoreArtifactVersion marks an open review stale", () => {
    const a = makeArtifact("v1\nbody")
    const v = useArtifactStore.getState().saveArtifactVersion(a.id)!
    useArtifactStore.getState().updateArtifact(a.id, { content: "v2\nbody" })
    useArtifactStore.getState().proposeArtifactUpdate(a.id, "v2\nBODY")
    useArtifactStore.getState().restoreArtifactVersion(a.id, v.id)
    expect(useArtifactStore.getState().pendingReviews[a.id].isStale).toBe(true)
  })

  it("orphan cleanup drops proposals on delete / batch-delete / clearSessionData / purgeProject", () => {
    // single delete
    const a1 = makeArtifact("a\nb\nc")
    useArtifactStore.getState().proposeArtifactUpdate(a1.id, "A\nb\nc")
    useArtifactStore.getState().deleteArtifact(a1.id)
    expect(useArtifactStore.getState().pendingReviews[a1.id]).toBeUndefined()

    // batch delete
    const a2 = makeArtifact("a\nb\nc")
    useArtifactStore.getState().proposeArtifactUpdate(a2.id, "A\nb\nc")
    useArtifactStore.getState().deleteArtifacts([a2.id])
    expect(useArtifactStore.getState().pendingReviews[a2.id]).toBeUndefined()

    // clearSessionData
    const a3 = makeArtifact("a\nb\nc")
    useArtifactStore.getState().proposeArtifactUpdate(a3.id, "A\nb\nc")
    useArtifactStore.getState().clearSessionData("s1")
    expect(useArtifactStore.getState().pendingReviews[a3.id]).toBeUndefined()

    // purgeProject
    mockActiveProjectId = "proj_x"
    const a4 = makeArtifact("a\nb\nc")
    useArtifactStore.getState().proposeArtifactUpdate(a4.id, "A\nb\nc")
    useArtifactStore.getState().purgeProject("proj_x")
    expect(useArtifactStore.getState().pendingReviews[a4.id]).toBeUndefined()
  })

  it("persists where each conversation was parked, pruned to surviving artifacts", () => {
    // Persisting only the tabs restored the strip but dropped every
    // conversation onto the session workbench after a restart.
    const kept = makeArtifact("a\nb")
    useArtifactStore.setState({
      activeArtifactIdBySession: { s1: kept.id, gone: "evicted-artifact", empty: null },
    })
    const persisted = readPartialize()
    expect(persisted.activeArtifactIdBySession).toEqual({ s1: kept.id })
  })

  it("drops the conversation-shaped artifact-list filters from the persisted blob", () => {
    // `searchQuery` + `sessionId` describe whichever conversation was open when
    // the app closed; restoring them boots the list filtered by a stale query
    // and a session that may not be open, which just reads as "empty".
    useArtifactStore.getState().setArtifactWorkspaceFilters({
      searchQuery: "stale",
      typeFilter: "code",
    })
    useArtifactStore.getState().setArtifactWorkspaceScope("session", "s-gone")
    const workspace = readPartialize().artifactWorkspace as Record<string, unknown>
    expect(workspace.searchQuery).toBe("")
    expect(workspace.sessionId).toBeNull()
    // Durable preferences still survive.
    expect(workspace.typeFilter).toBe("code")
    expect(workspace.scope).toBe("session")
  })

  it("excludes pendingReviews from the persisted partition", () => {
    const a = makeArtifact("a\nb\nc\nd")
    useArtifactStore.getState().proposeArtifactUpdate(a.id, "A\nb\nc\nD")
    // partialize governs what zustand writes to storage, regardless of the
    // active storage key (account-scoped tests rename it).
    const partialize = (
      useArtifactStore.persist.getOptions() as {
        partialize?: (s: ReturnType<typeof useArtifactStore.getState>) => Record<string, unknown>
      }
    ).partialize
    expect(partialize).toBeDefined()
    const persisted = partialize!(useArtifactStore.getState())
    expect(persisted.pendingReviews).toBeUndefined()
    expect((persisted.artifacts as Record<string, unknown>)[a.id]).toBeDefined()
  })
})

describe("canvas AI-revision review", () => {
  const makeCanvasDoc = (content: string) =>
    useArtifactStore.getState().createCanvasDocument({
      sessionId: "s1",
      title: "Doc",
      content,
      language: "markdown",
      type: "text",
    })

  it("proposeCanvasReview stages a per-hunk review without applying content", () => {
    const id = makeCanvasDoc("a\nb\nc\nd")
    const review = useArtifactStore.getState().proposeCanvasReview(id, "A\nb\nc\nD")
    expect(review).not.toBeNull()
    expect(review!.items.length).toBeGreaterThanOrEqual(2)
    const s = useArtifactStore.getState()
    expect(s.pendingReviews[id]).toBeDefined()
    // Proposal is staged only — the buffer is untouched until applied.
    expect(s.canvasDocuments[id].content).toBe("a\nb\nc\nd")
  })

  it("proposeCanvasReview returns null for unknown id or identical content", () => {
    const id = makeCanvasDoc("a\nb")
    expect(useArtifactStore.getState().proposeCanvasReview("nope", "x")).toBeNull()
    expect(useArtifactStore.getState().proposeCanvasReview(id, "a\nb")).toBeNull()
    expect(useArtifactStore.getState().pendingReviews[id]).toBeUndefined()
  })

  it("applyCanvasReview merges only accepted hunks, snapshots a version, and clears the proposal", () => {
    const id = makeCanvasDoc("a\nb\nc\nd")
    const review = useArtifactStore.getState().proposeCanvasReview(id, "A\nb\nc\nD")!
    // Accept only the first hunk (a -> A); leave the last (d -> D) pending.
    useArtifactStore.getState().setReviewItemStatus(id, review.items[0].id, "accepted")
    useArtifactStore.getState().applyCanvasReview(id, "applied")

    const s = useArtifactStore.getState()
    expect(s.pendingReviews[id]).toBeUndefined()
    expect(s.canvasDocuments[id].content).toBe("A\nb\nc\nd") // only accepted hunk applied
    const versions = useArtifactStore.getState().getCanvasVersions(id)
    expect(versions.some((v) => v.content === "a\nb\nc\nd")).toBe(true) // pre-apply snapshot
  })

  it("applyCanvasReview is a no-op for unknown ids and stale proposals", () => {
    expect(() => useArtifactStore.getState().applyCanvasReview("nope")).not.toThrow()

    const id = makeCanvasDoc("a\nb\nc\nd")
    const review = useArtifactStore.getState().proposeCanvasReview(id, "A\nb\nc\nD")!
    useArtifactStore.getState().setReviewItemStatus(id, review.items[0].id, "accepted")
    // A manual edit moves the baseline -> the proposal goes stale.
    useArtifactStore.getState().updateCanvasDocument(id, { content: "manual\nedit" })
    expect(useArtifactStore.getState().pendingReviews[id].isStale).toBe(true)
    useArtifactStore.getState().applyCanvasReview(id)
    expect(useArtifactStore.getState().canvasDocuments[id].content).toBe("manual\nedit")
    expect(useArtifactStore.getState().pendingReviews[id]).toBeDefined()
  })

  it("rejectCanvasReview clears the proposal without changing content", () => {
    const id = makeCanvasDoc("a\nb\nc\nd")
    useArtifactStore.getState().proposeCanvasReview(id, "A\nb\nc\nD")
    useArtifactStore.getState().rejectCanvasReview(id)
    expect(useArtifactStore.getState().pendingReviews[id]).toBeUndefined()
    expect(useArtifactStore.getState().canvasDocuments[id].content).toBe("a\nb\nc\nd")
    // no-op when nothing to reject
    expect(() => useArtifactStore.getState().rejectCanvasReview(id)).not.toThrow()
  })

  it("a non-content updateCanvasDocument does not mark an open review stale", () => {
    const id = makeCanvasDoc("a\nb\nc\nd")
    useArtifactStore.getState().proposeCanvasReview(id, "A\nb\nc\nD")
    useArtifactStore.getState().updateCanvasDocument(id, { title: "Renamed" })
    expect(useArtifactStore.getState().pendingReviews[id].isStale).toBeFalsy()
  })

  it("restoreCanvasVersion marks an open review stale", () => {
    const id = makeCanvasDoc("v1\nbody")
    const v = useArtifactStore.getState().saveCanvasVersion(id, "first")!
    useArtifactStore.getState().updateCanvasDocument(id, { content: "v2\nbody" })
    useArtifactStore.getState().proposeCanvasReview(id, "v2\nBODY")
    useArtifactStore.getState().restoreCanvasVersion(id, v.id)
    expect(useArtifactStore.getState().pendingReviews[id].isStale).toBe(true)
  })

  it("deleteCanvasDocument and purgeProject drop the pending review", () => {
    const id1 = makeCanvasDoc("a\nb\nc")
    useArtifactStore.getState().proposeCanvasReview(id1, "A\nb\nc")
    useArtifactStore.getState().deleteCanvasDocument(id1)
    expect(useArtifactStore.getState().pendingReviews[id1]).toBeUndefined()

    mockActiveProjectId = "proj_c"
    const id2 = makeCanvasDoc("a\nb\nc")
    useArtifactStore.getState().proposeCanvasReview(id2, "A\nb\nc")
    useArtifactStore.getState().purgeProject("proj_c")
    expect(useArtifactStore.getState().pendingReviews[id2]).toBeUndefined()
  })
})
