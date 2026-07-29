import { contextPanelRegistry } from "./panel-registry"
import {
  getActiveContextResource,
  getActiveContextRevision,
  getActiveWorkbenchPanels,
  isPluginContextPanelVisible,
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
})

describe("published panels", () => {
  const SESSION = {
    kind: "session" as const,
    id: "s-1",
    title: "S",
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
    setActiveContextForHost("dock", { ...SESSION, id: "s-2" })
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
  const SESSION = { kind: "session" as const, id: "s-1", title: "S", capabilities: [] }
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
  const SESSION = { kind: "session" as const, id: "s-1", title: "S", capabilities: [] }

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
