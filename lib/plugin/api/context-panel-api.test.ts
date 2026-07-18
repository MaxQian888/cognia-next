import { contextPanelRegistry } from "@/lib/context-workbench/panel-registry"
import { setActiveContextForHost } from "@/lib/context-workbench/active-context"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { createContextPanelAPI } from "./context-panel-api"

describe("plugin context panel API", () => {
  afterEach(() => contextPanelRegistry.unregisterPlugin("plugin-a"))

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
      contextPanelRegistry.resolve(
        {
          kind: "workflow",
          workflowId: "wf-1",
          editorRevision: "1",
          capabilities: [],
        },
        new Set(["extension:ui", "workflow:read"])
      )
    ).toEqual([expect.objectContaining({ id: "plugin-a:workflow-inspector" })])
    dispose()
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

    const panels = contextPanelRegistry.resolve(
      {
        kind: "canvas-document",
        documentId: "doc-1",
        revision: "1",
        capabilities: [],
      },
      new Set(["extension:ui", "canvas:read"])
    )
    expect(panels).toEqual([
      expect.objectContaining({ id: "plugin-a:outline", pluginId: "plugin-a" }),
    ])
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
})
