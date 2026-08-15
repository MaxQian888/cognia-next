import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { icons } from "lucide-react"
import {
  resetActiveContextForTesting,
  setActiveContextForHost,
} from "@/lib/context-workbench/active-context"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { createContextPanelAPI } from "./context-panel-api"

describe("plugin context panel API", () => {
  afterEach(() => {
    contextPanelRegistry.unregisterPlugin("plugin-a")
    resetActiveContextForTesting()
  })

  beforeEach(() => {
    useContextWorkbenchStore.setState({ layouts: {} })
  })

  it("requires extension:ui and the resource domain permission", () => {
    const api = createContextPanelAPI("plugin-a", (permission) => permission === "extension:ui")

    expect(() =>
      api.register({
        id: "outline",
        activity: "inspect",
        label: "Outline",
        labelKey: "plugin.outline",
        resourceKinds: ["canvas-document"],
        requiredPermissions: ["canvas:read"],
        renderer: () => null,
      })
    ).toThrow(/canvas:read/)
  })

  it("supports the workflow domain read permission for workflow panels", () => {
    const api = createContextPanelAPI(
      "plugin-a",
      (permission) => permission === "extension:ui" || permission === "workflow:read"
    )
    const dispose = api.register({
      id: "workflow-inspector",
      activity: "inspect",
      label: "Workflow inspector",
      labelKey: "plugin.workflowInspector",
      resourceKinds: ["workflow"],
      requiredPermissions: ["workflow:read"],
      renderer: () => null,
    })

    expect(
      contextPanelRegistry.resolve({
        kind: "workflow",
        workflowId: "wf-1",
        editorRevision: "1",
        capabilities: [],
      })
    ).toEqual([expect.objectContaining({ id: "plugin-a:workflow-inspector" })])
    dispose()
  })

  it("derives session:read for session panels and active context", () => {
    const permissions = new Set(["extension:ui", "session:read"])
    const api = createContextPanelAPI("plugin-a", (permission) => permissions.has(permission))
    const disposePanel = api.register({
      id: "session-inspector",
      activity: "inspect",
      label: "Session inspector",
      labelKey: "plugin.sessionInspector",
      resourceKinds: ["session"],
      renderer: () => null,
    })
    const disposeHost = setActiveContextForHost("window:session::session:s-1", {
      kind: "session",
      sessionId: "s-1",
      capabilities: ["inspect"],
    })

    expect(api.getActiveContext()).toEqual({
      kind: "session",
      sessionId: "s-1",
      capabilities: ["inspect"],
    })
    expect(
      contextPanelRegistry.resolve({ kind: "session", sessionId: "s-1", capabilities: [] })
    ).toEqual([expect.objectContaining({ id: "plugin-a:session-inspector" })])
    disposeHost()
    disposePanel()
  })

  it("registers a metadata-only panel with lazy activation", () => {
    const api = createContextPanelAPI("plugin-a", () => true)
    const dispose = api.register({
      id: "outline",
      activity: "inspect",
      label: "Outline",
      labelKey: "plugin.outline",
      resourceKinds: ["canvas-document"],
      requiredPermissions: ["canvas:read"],
      renderer: () => null,
    })

    const panels = contextPanelRegistry.resolve({
      kind: "canvas-document",
      documentId: "doc-1",
      revision: "1",
      capabilities: [],
    })
    expect(panels).toEqual([
      expect.objectContaining({ id: "plugin-a:outline", pluginId: "plugin-a" }),
    ])
    dispose()
  })

  it("carries the rail icon, badge and chat-scope flag the manifest path already had", () => {
    // Imperative registration used to drop all three, so every builtin plugin
    // panel fell back to the host's generic glyph with no way to opt out.
    const api = createContextPanelAPI("plugin-a", () => true)
    const dispose = api.register({
      id: "outline",
      activity: "inspect",
      label: "Outline",
      labelKey: "plugin.outline",
      resourceKinds: ["canvas-document"],
      icon: "SearchCode",
      getBadge: () => 4,
      requiresChatScope: true,
      renderer: () => null,
    })

    const resource = {
      kind: "canvas-document" as const,
      documentId: "doc-1",
      revision: "1",
      capabilities: [],
    }
    const registered = contextPanelRegistry.get("plugin-a:outline")
    expect(registered?.icon).toBe(icons.SearchCode)
    expect(registered?.requiresChatScope).toBe(true)
    expect(registered?.getBadge?.(resource)).toBe(4)

    // The declared permissions are recorded for diagnostics even though the
    // gate is the closure.
    expect(registered?.requiredPermissions).toEqual(["extension:ui", "canvas:read"])
    dispose()
  })

  it("derives every resource read permission without trusting plugin metadata", () => {
    const api = createContextPanelAPI("plugin-a", (permission) => permission === "extension:ui")

    expect(() =>
      api.register({
        id: "outline",
        activity: "inspect",
        label: "Outline",
        labelKey: "outline.label",
        resourceKinds: ["project-file", "artifact"],
        renderer: () => null,
      })
    ).toThrow(/project:read/)
  })

  it("reveals only the calling plugin's applicable panel and respects pinning", () => {
    const api = createContextPanelAPI("plugin-a", () => true)
    api.register({
      id: "outline",
      activity: "inspect",
      label: "Outline",
      labelKey: "outline.label",
      resourceKinds: ["canvas-document"],
      renderer: () => null,
    })
    const disposeHost = setActiveContextForHost("window:canvas::canvas:doc-1", {
      kind: "canvas-document",
      documentId: "doc-1",
      revision: "2",
      selection: { kind: "canvas", blockIds: ["block-1"] },
      capabilities: ["comments"],
    })
    useContextWorkbenchStore
      .getState()
      .navigatePanel("window:canvas::canvas:doc-1", "native-comments", "narrow")
    useContextWorkbenchStore.getState().setUserPinned("window:canvas::canvas:doc-1", true)

    expect(api.reveal("outline")).toBe(true)
    expect(
      useContextWorkbenchStore.getState().layouts["window:canvas::canvas:doc-1"]
    ).toMatchObject({
      activePanelId: "native-comments",
      pendingPanelIds: ["plugin-a:outline"],
    })
    expect(api.reveal("plugin-b:outline")).toBe(false)
    disposeHost()
  })

  it("publishes sanitized active context changes without resource content", () => {
    const api = createContextPanelAPI("plugin-a", () => true)
    const listener = jest.fn()
    const unsubscribe = api.onDidChangeActiveContext(listener)
    const disposeHost = setActiveContextForHost("window:artifact::artifact:a-1", {
      kind: "artifact",
      artifactId: "a-1",
      version: "4",
      selection: { kind: "text", start: 2, end: 5 },
      capabilities: ["comments"],
    })

    expect(api.getActiveContext()).toEqual({
      kind: "artifact",
      artifactId: "a-1",
      version: "4",
      selection: { kind: "text", start: 2, end: 5 },
      capabilities: ["comments"],
    })
    expect(api.getActiveContext()).not.toHaveProperty("content")
    expect(listener).toHaveBeenCalled()
    unsubscribe()
    disposeHost()
  })

  describe("workbench control", () => {
    const scopeKey = "window:canvas::canvas:doc-1"
    const resource = {
      kind: "canvas-document" as const,
      documentId: "doc-1",
      revision: "2",
      capabilities: [],
    }

    function mountPanel(hasPermission: (permission: string) => boolean = () => true) {
      const api = createContextPanelAPI("plugin-a", hasPermission)
      api.register({
        id: "outline",
        activity: "inspect",
        label: "Outline",
        labelKey: "outline.label",
        resourceKinds: ["canvas-document"],
        renderer: () => null,
      })
      return { api, disposeHost: setActiveContextForHost(scopeKey, resource) }
    }

    it("honours an explicit reveal mode over the panel's preferred one", () => {
      const { api, disposeHost } = mountPanel()

      expect(api.reveal("outline", "wide")).toBe(true)
      expect(useContextWorkbenchStore.getState().layouts[scopeKey]).toMatchObject({
        activePanelId: "plugin-a:outline",
        mode: "wide",
      })
      disposeHost()
    })

    it("pushes and clears a badge on its own panel only", () => {
      const { api, disposeHost } = mountPanel()

      expect(api.setBadge("outline", 3)).toBe(true)
      expect(contextPanelRegistry.get("plugin-a:outline")?.getBadge?.(resource)).toBe(3)
      expect(api.setBadge("outline", 0)).toBe(true)
      expect(contextPanelRegistry.get("plugin-a:outline")?.getBadge?.(resource)).toBe(0)
      expect(api.setBadge("plugin-b:theirs", 1)).toBe(false)
      expect(api.setBadge("never-registered", 1)).toBe(false)
      disposeHost()
    })

    it("reports the workbench layout and gates it on the resource permission", () => {
      const { api, disposeHost } = mountPanel()
      api.reveal("outline")

      expect(api.getWorkbenchState()).toMatchObject({
        mode: "narrow",
        activePanelId: "plugin-a:outline",
        splitPanelId: null,
        splitRatio: 50,
        ownsActivePanel: true,
        userPinned: false,
        panelIds: ["plugin-a:outline"],
      })

      const blind = createContextPanelAPI("plugin-a", (p) => p === "extension:ui")
      expect(blind.getWorkbenchState()).toBeNull()
      disposeHost()
    })

    it("withholds layout control from a plugin that owns only the second pane", () => {
      const { api, disposeHost } = mountPanel()
      api.reveal("outline")
      useContextWorkbenchStore.getState().navigatePanel(scopeKey, "native:review", "wide")
      useContextWorkbenchStore.getState().activateSplit(scopeKey, "plugin-a:outline")

      const state = api.getWorkbenchState()
      expect(state).toMatchObject({
        activePanelId: "native:review",
        splitPanelId: "plugin-a:outline",
      })
      // `setMode` and `setPinned` reshape the whole workbench. Sitting in the
      // lower half is not the same as having been handed the surface.
      expect(state?.ownsActivePanel).toBe(false)
      expect(api.setMode("focus")).toBe(false)
      expect(api.setPinned(true)).toBe(false)
      disposeHost()
    })

    it("notifies on both context and layout changes", () => {
      const { api, disposeHost } = mountPanel()
      const listener = jest.fn()
      const unsubscribe = api.onDidChangeWorkbenchState(listener)

      api.reveal("outline")
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ ownsActivePanel: true }))

      unsubscribe()
      listener.mockClear()
      api.reveal("outline", "wide")
      expect(listener).not.toHaveBeenCalled()
      disposeHost()
    })

    it("only resizes or pins the workbench while its own panel is visible", () => {
      const { api, disposeHost } = mountPanel()
      useContextWorkbenchStore.getState().navigatePanel(scopeKey, "native-comments", "narrow")

      expect(api.setMode("focus")).toBe(false)
      expect(api.setPinned(true)).toBe(false)
      expect(useContextWorkbenchStore.getState().layouts[scopeKey]?.mode).toBe("narrow")

      api.reveal("outline")
      expect(api.setMode("focus")).toBe(true)
      expect(api.setPinned(true)).toBe(true)
      expect(useContextWorkbenchStore.getState().layouts[scopeKey]).toMatchObject({
        mode: "focus",
        userPinned: true,
      })
      disposeHost()
    })

    it("fails closed on every control without extension:ui", () => {
      const { disposeHost } = mountPanel()
      const blind = createContextPanelAPI("plugin-a", () => false)

      expect(blind.setBadge("outline", 2)).toBe(false)
      expect(blind.setMode("wide")).toBe(false)
      expect(blind.setPinned(true)).toBe(false)
      disposeHost()
    })

    it("reports no workbench state until one is mounted", () => {
      const api = createContextPanelAPI("plugin-a", () => true)
      expect(api.getWorkbenchState()).toBeNull()
    })

    it("notifies visibility changes only on transitions", () => {
      const { api, disposeHost } = mountPanel()
      const seen: boolean[] = []
      const unsubscribe = api.onDidChangeVisibility("outline", (visible) => seen.push(visible))

      api.reveal("outline")
      expect(seen).toEqual([true])

      // Another panel takes over — the stateful panel stays mounted but is no
      // longer the one on screen.
      useContextWorkbenchStore.getState().navigatePanel(scopeKey, "native-comments", "narrow")
      expect(seen).toEqual([true, false])

      api.reveal("outline")
      useContextWorkbenchStore.getState().setMode(scopeKey, "collapsed")
      expect(seen).toEqual([true, false, true, false])

      unsubscribe()
      api.reveal("outline")
      expect(seen).toEqual([true, false, true, false])
      disposeHost()
    })

    it("visibility fails closed without extension:ui", () => {
      const { api, disposeHost } = mountPanel()
      api.reveal("outline")

      const blind = createContextPanelAPI("plugin-a", () => false)
      const seen: boolean[] = []
      const unsubscribe = blind.onDidChangeVisibility("outline", (visible) => seen.push(visible))
      useContextWorkbenchStore.getState().setMode(scopeKey, "wide")
      expect(seen).toEqual([])
      unsubscribe()
      disposeHost()
    })
  })

  it("fails closed when reading active context without its resource permission", () => {
    const api = createContextPanelAPI("plugin-a", (permission) => permission === "extension:ui")
    const disposeHost = setActiveContextForHost("window:workflow::workflow:w-1", {
      kind: "workflow",
      workflowId: "w-1",
      editorRevision: "1",
      capabilities: ["inspect"],
    })

    expect(api.getActiveContext()).toBeNull()
    disposeHost()
  })
})
