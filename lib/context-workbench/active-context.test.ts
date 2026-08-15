import { contextPanelRegistry } from "./panel-registry"
import {
  getActiveContextResource,
  getActiveContextRevision,
  getActiveWorkbench,
  getActiveWorkbenchPanels,
  isPluginContextPanelVisible,
  notifyActiveContextHostVisibility,
  publishActiveContextPanels,
  resetActiveContextForTesting,
  revealActiveWorkbenchActivity,
  revealActiveWorkbenchPanel,
  revealPluginContextPanel,
  setActiveContextForHost,
  setActiveWorkbenchMode,
  setActiveWorkbenchPinned,
  setPluginContextPanelBadge,
  subscribeActiveContext,
  subscribeActiveWorkbench,
} from "./active-context"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"

afterEach(() => {
  resetActiveContextForTesting()
  useContextWorkbenchStore.setState({ layouts: {} })
})

it("falls back to the newest remaining host and returns defensive copies", () => {
  const disposeCanvas = setActiveContextForHost("canvas", {
    kind: "canvas-document",
    documentId: "doc-1",
    revision: "1",
    selection: { kind: "canvas", blockIds: ["a"] },
    capabilities: ["comments"],
  })
  const disposeWorkflow = setActiveContextForHost("workflow", {
    kind: "workflow",
    workflowId: "wf-1",
    editorRevision: "2",
    selection: { kind: "workflow", nodeIds: ["n1"], edgeIds: [] },
    capabilities: ["inspect"],
  })

  expect(getActiveContextResource()?.kind).toBe("workflow")
  disposeWorkflow()
  const resource = getActiveContextResource()
  expect(resource?.kind).toBe("canvas-document")
  if (resource?.kind === "canvas-document" && resource.selection) {
    resource.selection.blockIds.push("mutated")
  }
  expect(getActiveContextResource()).toMatchObject({
    selection: { blockIds: ["a"] },
  })
  disposeCanvas()
})

it("returns defensive copies for session resources without inventing a selection", () => {
  const dispose = setActiveContextForHost("session", {
    kind: "session",
    sessionId: "session-1",
    capabilities: ["inspect"],
  })

  const resource = getActiveContextResource()
  expect(resource).toEqual({
    kind: "session",
    sessionId: "session-1",
    capabilities: ["inspect"],
  })
  resource?.capabilities.push("preview")
  expect(getActiveContextResource()?.capabilities).toEqual(["inspect"])
  expect(getActiveContextResource()).not.toHaveProperty("selection")
  dispose()
})

describe("revealPluginContextPanel", () => {
  const resource = {
    kind: "session" as const,
    sessionId: "session-1",
    capabilities: [],
  }

  function registerPanel() {
    return contextPanelRegistry.register({
      id: "plugin-a:inbox",
      pluginId: "plugin-a",
      activity: "inspect",
      labelKey: "plugin.inbox",
      appliesTo: (candidate) => candidate.kind === "session",
      renderer: () => null,
    })
  }

  it("opens the host container before switching panels", () => {
    // The dock stays mounted at zero width while collapsed, so the host is
    // registered and the reveal "succeeds" — without this callback the panel
    // changed behind a surface the user could not see.
    const ensureVisible = jest.fn()
    const disposePanel = registerPanel()
    const disposeHost = setActiveContextForHost("dock", resource, { ensureVisible })

    expect(revealPluginContextPanel("plugin-a", "inbox")).toBe(true)
    expect(ensureVisible).toHaveBeenCalledTimes(1)
    expect(useContextWorkbenchStore.getState().layouts["dock"]?.activePanelId).toBe(
      "plugin-a:inbox"
    )

    disposeHost()
    disposePanel()
  })

  it("leaves the container alone when the panel is not revealable", () => {
    const ensureVisible = jest.fn()
    const disposeHost = setActiveContextForHost("dock", resource, { ensureVisible })

    expect(revealPluginContextPanel("plugin-a", "inbox")).toBe(false)
    expect(ensureVisible).not.toHaveBeenCalled()

    disposeHost()
  })

  it("still reveals for hosts that are always visible", () => {
    const disposePanel = registerPanel()
    const disposeHost = setActiveContextForHost("editor", resource)

    expect(revealPluginContextPanel("plugin-a", "inbox")).toBe(true)

    disposeHost()
    disposePanel()
  })
})

describe("isPluginContextPanelVisible", () => {
  const resource = {
    kind: "session" as const,
    sessionId: "session-1",
    capabilities: [],
  }

  it("is true only while the plugin's panel is in front of a non-collapsed workbench", () => {
    const disposeHost = setActiveContextForHost("dock", resource)
    expect(isPluginContextPanelVisible("plugin-a", "inbox")).toBe(false)

    useContextWorkbenchStore.getState().navigatePanel("dock", "plugin-a:inbox", "narrow")
    expect(isPluginContextPanelVisible("plugin-a", "inbox")).toBe(true)
    // Accepts the qualified spelling too — same normalisation as reveal.
    expect(isPluginContextPanelVisible("plugin-a", "plugin-a:inbox")).toBe(true)
    expect(isPluginContextPanelVisible("plugin-b", "inbox")).toBe(false)

    useContextWorkbenchStore.getState().setMode("dock", "collapsed")
    expect(isPluginContextPanelVisible("plugin-a", "inbox")).toBe(false)

    disposeHost()
    expect(isPluginContextPanelVisible("plugin-a", "inbox")).toBe(false)
  })

  it("reports a plugin panel visible while it sits in the second pane", () => {
    const disposeHost = setActiveContextForHost("dock", resource)
    useContextWorkbenchStore.getState().navigatePanel("dock", "native:review", "wide")
    useContextWorkbenchStore.getState().activateSplit("dock", "plugin-a:inbox")

    // A split shows two panels at once, so "visible" cannot mean "in front".
    expect(isPluginContextPanelVisible("plugin-a", "inbox")).toBe(true)

    disposeHost()
  })

  it("defers to a host that is projecting the split away", () => {
    // The mobile drawer and any body too narrow for two panes draw a single
    // pane while deliberately leaving the stored layout alone, so reading
    // `splitPanelId` would report a pane the device is not drawing.
    const disposeHost = setActiveContextForHost("dock", resource, {
      visiblePanelIds: () => ["native:review"],
    })
    useContextWorkbenchStore.getState().navigatePanel("dock", "native:review", "wide")
    useContextWorkbenchStore.getState().activateSplit("dock", "plugin-a:inbox")

    expect(isPluginContextPanelVisible("plugin-a", "inbox")).toBe(false)
    expect(useContextWorkbenchStore.getState().layouts.dock?.splitPanelId).toBe("plugin-a:inbox")

    disposeHost()
  })

  it("is false while the host's own container is shut, whatever the mode says", () => {
    // The chat dock, Canvas and the workflow editor all shrink a container they
    // own and never write `collapsed` to the per-scope mode. Reading the mode
    // alone therefore reported a plugin's panel as visible while the entire
    // right column sat at the activity rail — or at zero width.
    let bodyHidden = false
    const disposeHost = setActiveContextForHost("dock", resource, {
      isVisible: () => !bodyHidden,
    })
    useContextWorkbenchStore.getState().navigatePanel("dock", "plugin-a:inbox", "narrow")
    expect(isPluginContextPanelVisible("plugin-a", "inbox")).toBe(true)

    bodyHidden = true
    expect(useContextWorkbenchStore.getState().layouts["dock"]?.mode).not.toBe("collapsed")
    expect(isPluginContextPanelVisible("plugin-a", "inbox")).toBe(false)

    disposeHost()
  })
})

describe("setActiveWorkbenchMode — collapse reaches the host", () => {
  const resource = {
    kind: "session" as const,
    sessionId: "session-1",
    capabilities: [],
  }

  function ownPanel() {
    useContextWorkbenchStore.getState().navigatePanel("dock", "plugin-a:inbox", "narrow")
  }

  it("routes a collapse to the container's owner instead of the per-scope mode", () => {
    const collapse = jest.fn()
    const disposeHost = setActiveContextForHost("dock", resource, { collapse })
    ownPanel()

    expect(setActiveWorkbenchMode("plugin-a", "collapsed")).toBe(true)
    expect(collapse).toHaveBeenCalledTimes(1)
    // The per-scope mode is left alone: it is per-*resource*, and writing it
    // would make the dock re-open and re-close as the user changes artifact.
    expect(useContextWorkbenchStore.getState().layouts["dock"]?.mode).toBe("narrow")

    disposeHost()
  })

  it("still writes the mode for hosts with no container of their own", () => {
    const disposeHost = setActiveContextForHost("dock", resource)
    ownPanel()

    expect(setActiveWorkbenchMode("plugin-a", "collapsed")).toBe(true)
    expect(useContextWorkbenchStore.getState().layouts["dock"]?.mode).toBe("collapsed")

    disposeHost()
  })

  it("leaves widths to the store even when the host owns a container", () => {
    const collapse = jest.fn()
    const disposeHost = setActiveContextForHost("dock", resource, { collapse })
    ownPanel()

    expect(setActiveWorkbenchMode("plugin-a", "wide")).toBe(true)
    expect(collapse).not.toHaveBeenCalled()
    expect(useContextWorkbenchStore.getState().layouts["dock"]?.mode).toBe("wide")

    disposeHost()
  })
})

describe("notifyActiveContextHostVisibility", () => {
  const resource = {
    kind: "session" as const,
    sessionId: "session-1",
    capabilities: [],
  }

  it("re-broadcasts without stealing 'in front' from another host", () => {
    const listener = jest.fn()
    const disposeBackground = setActiveContextForHost("dock", resource)
    const disposeForeground = setActiveContextForHost("editor", resource)
    // `getActiveWorkbench` reports nothing for a scope with no stored layout,
    // so give the foreground host one to be identified by.
    useContextWorkbenchStore.getState().navigatePanel("editor", "preview", "narrow")
    const unsubscribe = subscribeActiveContext(listener)

    notifyActiveContextHostVisibility("dock")

    expect(listener).toHaveBeenCalledTimes(1)
    // Still the editor's: collapsing a background surface is the opposite of
    // claiming focus, so it must not re-stamp the active scope.
    expect(getActiveWorkbench()?.scopeKey).toBe("editor")

    unsubscribe()
    disposeForeground()
    disposeBackground()
  })

  it("drops a notify for a scope that has no host", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeActiveContext(listener)

    notifyActiveContextHostVisibility("nobody")

    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})

describe("published panels", () => {
  const SESSION = {
    kind: "session" as const,
    sessionId: "s-1",
    capabilities: [],
  }
  const PANELS = [
    { id: "preview", activity: "preview-run", labelKey: "p" },
    { id: "workspace", activity: "workspace", labelKey: "w" },
  ]

  it("reports nothing until a host publishes", () => {
    expect(getActiveWorkbenchPanels()).toEqual([])
    setActiveContextForHost("dock", SESSION)
    expect(getActiveWorkbenchPanels()).toEqual([])
  })

  it("drops a publish for a scope that has no host", () => {
    // The host republishes on its next render, so queueing would only risk
    // resurrecting a panel list for a workbench that has unmounted.
    publishActiveContextPanels("ghost", PANELS)
    expect(getActiveWorkbenchPanels()).toEqual([])
  })

  it("returns defensive copies", () => {
    setActiveContextForHost("dock", SESSION)
    publishActiveContextPanels("dock", PANELS)
    const first = getActiveWorkbenchPanels()
    first[0].id = "mutated"
    expect(getActiveWorkbenchPanels()[0].id).toBe("preview")
  })

  it("survives the host re-registering on a resource change", () => {
    // `setActiveContextForHost` and the panel publish run in separate effects
    // and can fire in either order; a re-register must not blank the list.
    setActiveContextForHost("dock", SESSION)
    publishActiveContextPanels("dock", PANELS)
    setActiveContextForHost("dock", { ...SESSION, sessionId: "s-2" })
    expect(getActiveWorkbenchPanels().map((p) => p.id)).toEqual(["preview", "workspace"])
  })

  it("bumps the revision on every mutation", () => {
    const before = getActiveContextRevision()
    setActiveContextForHost("dock", SESSION)
    publishActiveContextPanels("dock", PANELS)
    expect(getActiveContextRevision()).toBeGreaterThan(before)
  })
})

describe("revealing a panel by id or activity", () => {
  const SESSION = { kind: "session" as const, sessionId: "s-1", capabilities: [] }
  const PANELS = [
    { id: "preview", activity: "preview-run", labelKey: "p" },
    { id: "workspace", activity: "workspace", labelKey: "w", preferredMode: "wide" as const },
  ]

  it("returns false with no workbench mounted", () => {
    expect(revealActiveWorkbenchPanel("preview")).toBe(false)
    expect(revealActiveWorkbenchActivity("preview-run")).toBe(false)
  })

  it("returns false for a panel the workbench does not offer", () => {
    setActiveContextForHost("dock", SESSION)
    publishActiveContextPanels("dock", PANELS)
    expect(revealActiveWorkbenchPanel("nope")).toBe(false)
    expect(revealActiveWorkbenchActivity("comments")).toBe(false)
  })

  it("opens the host's container before choosing the panel", () => {
    const ensureVisible = jest.fn()
    setActiveContextForHost("dock", SESSION, { ensureVisible })
    publishActiveContextPanels("dock", PANELS)
    expect(revealActiveWorkbenchPanel("preview")).toBe(true)
    expect(ensureVisible).toHaveBeenCalled()
    expect(useContextWorkbenchStore.getState().layouts.dock?.activePanelId).toBe("preview")
  })

  it("honours the panel's preferred mode, and an explicit override", () => {
    setActiveContextForHost("dock", SESSION)
    publishActiveContextPanels("dock", PANELS)
    revealActiveWorkbenchPanel("workspace")
    expect(useContextWorkbenchStore.getState().layouts.dock?.mode).toBe("wide")
    revealActiveWorkbenchPanel("preview", "wide")
    expect(useContextWorkbenchStore.getState().layouts.dock?.mode).toBe("wide")
  })

  it("resolves an activity to its first panel", () => {
    setActiveContextForHost("dock", SESSION)
    publishActiveContextPanels("dock", [
      ...PANELS,
      { id: "preview-two", activity: "preview-run", labelKey: "p2" },
    ])
    expect(revealActiveWorkbenchActivity("preview-run")).toBe(true)
    expect(useContextWorkbenchStore.getState().layouts.dock?.activePanelId).toBe("preview")
  })
})

describe("subscriber and plugin-owned layout controls", () => {
  const SESSION = { kind: "session" as const, sessionId: "s-1", capabilities: [] }

  it("keeps notifying after one listener throws", () => {
    // A plugin listener must not be able to stop the host's own subscribers.
    const good = jest.fn()
    subscribeActiveContext(() => {
      throw new Error("plugin blew up")
    })
    subscribeActiveContext(good)
    setActiveContextForHost("dock", SESSION)
    expect(good).toHaveBeenCalled()
  })

  it("subscribeActiveWorkbench fires for both context and layout changes", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeActiveWorkbench(listener)
    setActiveContextForHost("dock", SESSION)
    expect(listener).toHaveBeenCalled()

    listener.mockClear()
    useContextWorkbenchStore.getState().setWidth("dock", 400)
    expect(listener).toHaveBeenCalled()

    listener.mockClear()
    unsubscribe()
    setActiveContextForHost("dock", SESSION)
    expect(listener).not.toHaveBeenCalled()
  })

  it("refuses layout control to a plugin whose panel is not in front", () => {
    setActiveContextForHost("dock", SESSION)
    publishActiveContextPanels("dock", [{ id: "preview", activity: "preview-run", labelKey: "p" }])
    revealActiveWorkbenchPanel("preview")
    // A first-party panel is in front, so `acme` may not resize or pin it.
    expect(setActiveWorkbenchMode("acme", "focus")).toBe(false)
    expect(setActiveWorkbenchPinned("acme", true)).toBe(false)
  })

  it("grants layout control to the plugin owning the visible panel", () => {
    setActiveContextForHost("dock", SESSION)
    publishActiveContextPanels("dock", [
      { id: "acme:board", activity: "templates", labelKey: "b", pluginId: "acme" },
    ])
    revealActiveWorkbenchPanel("acme:board")
    expect(setActiveWorkbenchMode("acme", "focus")).toBe(true)
    expect(useContextWorkbenchStore.getState().layouts.dock?.mode).toBe("focus")
    expect(setActiveWorkbenchPinned("acme", true)).toBe(true)
    expect(useContextWorkbenchStore.getState().layouts.dock?.userPinned).toBe(true)
  })

  it("rejects a badge for a panel the plugin does not own", () => {
    expect(setPluginContextPanelBadge("acme", "ghost", 3)).toBe(false)
  })
})

it("clones a workflow resource that carries no selection", () => {
  const dispose = setActiveContextForHost("workflow", {
    kind: "workflow",
    workflowId: "wf-2",
    editorRevision: "1",
    capabilities: [],
  })
  expect(getActiveContextResource()).toMatchObject({
    kind: "workflow",
    workflowId: "wf-2",
    editorRevision: "1",
    capabilities: [],
  })
  // The key is present and undefined — only the `session` branch omits it
  // outright, because a session can never carry a selection at all.
  expect(getActiveContextResource()?.selection).toBeUndefined()
  dispose()
})

it("sets a badge on a panel the plugin owns", () => {
  const dispose = contextPanelRegistry.register({
    id: "plugin-a:inbox",
    pluginId: "plugin-a",
    activity: "inspect",
    labelKey: "plugin.inbox",
    appliesTo: () => true,
    renderer: () => null,
  })
  expect(setPluginContextPanelBadge("plugin-a", "inbox", 3)).toBe(true)
  // Rejected for someone else's panel, whatever spelling they use.
  expect(setPluginContextPanelBadge("plugin-b", "plugin-a:inbox", 3)).toBe(false)
  dispose()
})

it.each([
  ["canvas-document", { kind: "canvas-document" as const, documentId: "d", revision: "1" }],
  ["artifact", { kind: "artifact" as const, artifactId: "a", revision: "1" }],
])("clones a %s resource that carries no selection", (_label, base) => {
  const dispose = setActiveContextForHost("host", { ...base, capabilities: [] } as never)
  expect(getActiveContextResource()?.selection).toBeUndefined()
  expect(getActiveContextResource()).toMatchObject(base)
  dispose()
})
