import { contextPanelRegistry } from "./panel-registry"
import {
  getActiveContextResource,
  isPluginContextPanelVisible,
  resetActiveContextForTesting,
  revealPluginContextPanel,
  setActiveContextForHost,
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
