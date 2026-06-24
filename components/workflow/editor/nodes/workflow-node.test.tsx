/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import { EditorStoreProvider } from "@/lib/workflow/editor/store-context"
import type { VisualWorkflow, WorkflowNodeKind } from "@/types/workflow/visual"
import { WorkflowNodeComponent } from "./workflow-node"
import { addPluginCatalogEntry, __resetPluginCatalogForTesting } from "@/lib/workflow/nodes/catalog"
import { registerPluginI18n, __resetPluginI18nForTesting } from "@/lib/i18n/plugin-i18n-registry"

// React Flow's Handle pulls in DOM measurements that jsdom can't provide.
// Stub the surface used by `WorkflowNodeComponent`. The Handle is rendered
// as a span so the test can read its className + data-* attributes.
jest.mock("@xyflow/react", () => ({
  __esModule: true,
  Handle: ({
    className,
    ...rest
  }: {
    className?: string
    "data-testid"?: string
    "data-connection-ring"?: string
  }) => <span className={className} {...rest} />,
  Position: { Left: "left", Right: "right" },
}))

function makeWorkflow(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 1,
    name: "Test",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
    viewport: { x: 0, y: 0, zoom: 1 },
  }
}

function withStore(): { store: EditorStore; addNode: typeof createEditorStore } {
  const store = createEditorStore(makeWorkflow())
  return { store, addNode: createEditorStore }
}

interface RenderArgs {
  id?: string
  kind?: WorkflowNodeKind
  selected?: boolean
  label?: string
  store?: EditorStore
  withProvider?: boolean
  typeVersion?: number
  params?: Record<string, unknown>
}

function renderNode({
  id = "n_a",
  kind = "ai.prompt",
  selected = false,
  label = "Prompt",
  store,
  withProvider = true,
  typeVersion = 1,
  params = {},
}: RenderArgs = {}) {
  const ui = (
    <TooltipProvider>
      <WorkflowNodeComponent
        id={id}
        type="workflowNode"
        selected={selected}
        data={{
          label,
          params,
          kind,
          typeVersion,
        }}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        dragging={false}
        zIndex={0}
        isConnectable={true}
        deletable={true}
        selectable={true}
        draggable={true}
      />
    </TooltipProvider>
  )
  return render(
    withProvider && store ? <EditorStoreProvider store={store}>{ui}</EditorStoreProvider> : ui
  )
}

describe("WorkflowNodeComponent", () => {
  it("renders the label and kind", () => {
    const { store } = withStore()
    renderNode({ store, label: "AI step", kind: "ai.prompt" })
    expect(screen.getByText("AI step")).toBeInTheDocument()
    expect(screen.getByText("ai.prompt")).toBeInTheDocument()
  })

  it("translates the catalog label for a freshly-dropped (default-labelled) node", () => {
    const { store } = withStore()
    // `addNode` bakes the raw kind into `data.label` for kinds without an
    // entry in `labelByKind`; the renderer must substitute the localized
    // `workflows.nodes.<kind>.label` so the canvas isn't stuck on raw kinds.
    renderNode({ store, label: "action.goal.create", kind: "action.goal.create" })
    expect(screen.getByText("Create goal")).toBeInTheDocument()
    // The raw kind still shows in the lowercase subtitle line.
    expect(screen.getByText("action.goal.create")).toBeInTheDocument()
  })

  it("keeps a user-customized label verbatim (no translation override)", () => {
    const { store } = withStore()
    renderNode({ store, label: "My goal step", kind: "action.goal.create" })
    expect(screen.getByText("My goal step")).toBeInTheDocument()
    expect(screen.queryByText("Create goal")).not.toBeInTheDocument()
  })

  describe("plugin node label localization", () => {
    afterEach(() => {
      __resetPluginCatalogForTesting()
      __resetPluginI18nForTesting()
    })

    function registerDemoNode() {
      addPluginCatalogEntry({
        kind: "demo.action.format" as never,
        category: "plugin",
        label: "Format Rust",
        description: "Run rustfmt on a Rust source string",
        iconName: "Wand",
        keywords: [],
        pluginId: "demo",
      })
    }

    it("falls back to the plugin author's catalog label when untranslated", () => {
      registerDemoNode()
      const { store } = withStore()
      // Instance label equals the raw kind (what `addNode` bakes for plugin
      // kinds), so the renderer substitutes the catalog label.
      renderNode({
        store,
        label: "demo.action.format",
        kind: "demo.action.format" as WorkflowNodeKind,
      })
      expect(screen.getByText("Format Rust")).toBeInTheDocument()
    })

    it("renders the translated label from the plugin overlay namespace", () => {
      registerDemoNode()
      registerPluginI18n({
        pluginId: "demo",
        messages: {
          en: { "plugin.demo.workflow.nodes.action.format.label": "格式化 Rust" },
        },
      })
      const { store } = withStore()
      renderNode({
        store,
        label: "demo.action.format",
        kind: "demo.action.format" as WorkflowNodeKind,
      })
      expect(screen.getByText("格式化 Rust")).toBeInTheDocument()
      expect(screen.queryByText("Format Rust")).not.toBeInTheDocument()
    })
  })

  it("does not render the floating toolbar without a store provider", () => {
    renderNode({ withProvider: false })
    expect(screen.queryByTestId("wf-node-toolbar-n_a")).toBeNull()
  })

  it("shows the pin badge only when the node has pinned data", () => {
    const { store } = withStore()
    const { rerender } = renderNode({ store, id: "n_a" })
    expect(screen.queryByTestId("wf-node-pin-badge")).toBeNull()

    store.getState().pinNodeData("n_a", { value: 1 })
    rerender(
      <EditorStoreProvider store={store}>
        <TooltipProvider>
          <WorkflowNodeComponent
            id="n_a"
            type="workflowNode"
            selected={false}
            data={{ label: "Prompt", params: {}, kind: "ai.prompt", typeVersion: 1 }}
            positionAbsoluteX={0}
            positionAbsoluteY={0}
            dragging={false}
            zIndex={0}
            isConnectable={true}
            deletable={true}
            selectable={true}
            draggable={true}
          />
        </TooltipProvider>
      </EditorStoreProvider>
    )
    expect(screen.getByTestId("wf-node-pin-badge")).toBeInTheDocument()
  })

  it("renders the floating toolbar when wrapped in a store provider", () => {
    const { store } = withStore()
    renderNode({ store })
    expect(screen.getByTestId("wf-node-toolbar-n_a")).toBeInTheDocument()
  })

  it("does not render the floating toolbar for annotation kinds", () => {
    const { store } = withStore()
    renderNode({ store, kind: "annotation.note" })
    expect(screen.queryByTestId("wf-node-toolbar-n_a")).toBeNull()
  })

  it("mouseEnter / mouseLeave drives store.hoveredNodeId", () => {
    const { store } = withStore()
    renderNode({ store })
    const card = screen.getByTestId("wf-node-ai.prompt")
    fireEvent.mouseEnter(card)
    expect(store.getState().hoveredNodeId).toBe("n_a")
    fireEvent.mouseLeave(card)
    expect(store.getState().hoveredNodeId).toBeNull()
  })

  it("applies the spotlight pulse class when store.spotlightedNodeId matches", () => {
    const { store } = withStore()
    store.getState().setSpotlightedNodeId("n_a")
    renderNode({ store })
    const card = screen.getByTestId("wf-node-ai.prompt")
    // motionEnabled defaults to true in this env (no matchMedia mock).
    expect(card.className).toContain("animate-pulse-ring")
  })

  it("uses a static ring (no animation) when reduced-motion is active", () => {
    const { store } = withStore()
    // Force the resolved tier to 'reduced' by setting the user choice.
    store.getState().setPerformanceTier("reduced")
    store.getState().setSpotlightedNodeId("n_a")
    renderNode({ store })
    const card = screen.getByTestId("wf-node-ai.prompt")
    expect(card.className).toContain("ring-4")
    expect(card.className).not.toContain("animate-pulse-ring")
  })

  it("toolbar Delete invokes store.removeNodes for the active id", () => {
    const { store } = withStore()
    store.getState().addNode("ai.prompt", { x: 0, y: 0 })
    const allIds = store.getState().nodes.map((n) => n.id)
    const targetId = allIds[0]
    renderNode({ store, id: targetId })
    fireEvent.click(screen.getByTestId("wf-node-toolbar-delete"))
    expect(store.getState().nodes.find((n) => n.id === targetId)).toBeUndefined()
  })

  it("toolbar Run sets requestedRunFromStepId in the store", () => {
    const { store } = withStore()
    renderNode({ store, id: "n_a" })
    fireEvent.click(screen.getByTestId("wf-node-toolbar-run"))
    expect(store.getState().requestedRunFromStepId).toBe("n_a")
  })

  it("toolbar More populates requestedContextMenu with the button anchor", () => {
    const { store } = withStore()
    renderNode({ store, id: "n_a" })
    fireEvent.click(screen.getByTestId("wf-node-toolbar-more"))
    const req = store.getState().requestedContextMenu
    expect(req?.target).toEqual({ kind: "node", nodeId: "n_a" })
    expect(typeof req?.screenAnchor.x).toBe("number")
    expect(typeof req?.screenAnchor.y).toBe("number")
  })

  it("applies the hovered-endpoint ring when hoveredEdgeId targets this node", () => {
    const { store } = withStore()
    const a = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const b = store.getState().addNode("ai.prompt", { x: 200, y: 0 })
    const eId = store.getState().connect({ source: a, target: b })
    store.getState().setHoveredEdge(eId)
    renderNode({ store, id: b, kind: "ai.prompt" })
    const card = screen.getByTestId("wf-node-ai.prompt")
    expect(card.getAttribute("data-hovered-endpoint")).toBe("true")
    expect(card.className).toContain("ring-primary/40")
  })

  it("applies the compatible handle ring when a connection is in flight from a peer", () => {
    const { store } = withStore()
    const a = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const b = store.getState().addNode("ai.prompt", { x: 200, y: 0 })
    store.getState().beginConnection({ sourceId: a, sourceHandle: null })
    renderNode({ store, id: b, kind: "ai.prompt" })
    const handle = screen.getByTestId(`wf-node-handle-target-${b}`)
    expect(handle.getAttribute("data-connection-ring")).toBe("compatible")
    expect(handle.className).toContain("ring-emerald-500")
  })

  it("marks the active candidate with the thick primary handle ring", () => {
    const { store } = withStore()
    const a = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
    const b = store.getState().addNode("ai.prompt", { x: 200, y: 0 })
    store.getState().beginConnection({ sourceId: a, sourceHandle: null })
    store
      .getState()
      .updateConnectionPointer({ x: 200, y: 0 }, { nodeId: b, handleId: null, distance: 1 })
    renderNode({ store, id: b, kind: "ai.prompt" })
    const card = screen.getByTestId("wf-node-ai.prompt")
    expect(card.getAttribute("data-connection-candidate")).toBe("true")
    const handle = screen.getByTestId(`wf-node-handle-target-${b}`)
    expect(handle.className).toContain("ring-primary")
  })

  it("does NOT highlight the source node's own handle during a connection", () => {
    const { store } = withStore()
    const a = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
    store.getState().addNode("ai.prompt", { x: 200, y: 0 })
    store.getState().beginConnection({ sourceId: a, sourceHandle: null })
    renderNode({ store, id: a, kind: "trigger.manual" })
    // trigger nodes have no input handle so the data-connection-ring attr
    // is absent regardless; the card itself stays unmarked.
    const card = screen.getByTestId("wf-node-trigger.manual")
    expect(card.getAttribute("data-connection-candidate")).toBeNull()
  })

  // ── errorPolicy: "branch" error handle (Workstream E) ───────────────────
  function branchStore(): EditorStore {
    const wf = makeWorkflow()
    return createEditorStore({ ...wf, settings: { ...wf.settings, errorPolicy: "branch" } })
  }

  it("renders the error source handle on an action node when errorPolicy is 'branch'", () => {
    renderNode({ store: branchStore(), id: "n_a", kind: "ai.prompt" })
    expect(screen.getByTestId("wf-node-handle-error-n_a")).toBeInTheDocument()
  })

  it("does NOT render the error handle under the default 'stop' policy", () => {
    const { store } = withStore()
    renderNode({ store, id: "n_a", kind: "ai.prompt" })
    expect(screen.queryByTestId("wf-node-handle-error-n_a")).toBeNull()
  })

  it("does NOT render the error handle on a trigger node even under 'branch'", () => {
    renderNode({ store: branchStore(), id: "n_t", kind: "trigger.manual" })
    expect(screen.queryByTestId("wf-node-handle-error-n_t")).toBeNull()
  })

  // ── labeled multi-output handles (branch/switch v2) ──────────────────────
  it("renders true/false handles with labels for a v2 branch", () => {
    const { store } = withStore()
    renderNode({ store, id: "n_b", kind: "flow.branch", typeVersion: 2 })
    expect(screen.getByTestId("wf-node-handle-out-n_b-true")).toBeInTheDocument()
    expect(screen.getByTestId("wf-node-handle-out-n_b-false")).toBeInTheDocument()
    expect(screen.getByTestId("wf-node-handle-label-n_b-true")).toHaveTextContent(/true/i)
    expect(screen.getByTestId("wf-node-handle-label-n_b-false")).toHaveTextContent(/false/i)
  })

  it("renders one handle per case plus default for a v2 switch", () => {
    const { store } = withStore()
    renderNode({
      store,
      id: "n_s",
      kind: "flow.switch",
      typeVersion: 2,
      params: {
        cases: [
          { id: "c_a", label: "Alpha", when: { combinator: "all", conditions: [] } },
          { id: "c_b", label: "Beta", when: { combinator: "all", conditions: [] } },
        ],
      },
    })
    expect(screen.getByTestId("wf-node-handle-out-n_s-c_a")).toBeInTheDocument()
    expect(screen.getByTestId("wf-node-handle-out-n_s-c_b")).toBeInTheDocument()
    expect(screen.getByTestId("wf-node-handle-out-n_s-default")).toBeInTheDocument()
    expect(screen.getByTestId("wf-node-handle-label-n_s-c_a")).toHaveTextContent("Alpha")
    expect(screen.getByTestId("wf-node-handle-label-n_s-c_b")).toHaveTextContent("Beta")
  })

  it("keeps the error handle alongside v2 decision handles under 'branch' policy", () => {
    renderNode({ store: branchStore(), id: "n_b", kind: "flow.branch", typeVersion: 2 })
    expect(screen.getByTestId("wf-node-handle-out-n_b-true")).toBeInTheDocument()
    expect(screen.getByTestId("wf-node-handle-error-n_b")).toBeInTheDocument()
  })

  it("v1 branch keeps the single unlabeled output handle", () => {
    const { store } = withStore()
    renderNode({ store, id: "n_b", kind: "flow.branch", typeVersion: 1 })
    expect(screen.queryByTestId("wf-node-handle-out-n_b-true")).toBeNull()
  })

  describe("diagnostics badge (A4)", () => {
    function storeWith(
      nodes: VisualWorkflow["nodes"],
      edges: VisualWorkflow["edges"]
    ): EditorStore {
      const wf = makeWorkflow()
      wf.nodes = nodes
      wf.edges = edges
      return createEditorStore(wf)
    }

    it("shows an amber warning badge for a warning-only node (orphan)", () => {
      const store = storeWith(
        [
          {
            id: "t",
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: 0, y: 0 },
            data: { label: "T", params: {} },
          },
          {
            id: "island",
            type: "ai.prompt",
            typeVersion: 1,
            position: { x: 200, y: 0 },
            data: { label: "Island", params: { userPrompt: "hi" } },
          },
        ],
        []
      )
      renderNode({ store, id: "island", kind: "ai.prompt" })
      expect(screen.getByTestId("wf-node-warning-badge")).toBeInTheDocument()
      expect(screen.queryByTestId("wf-node-error-badge")).toBeNull()
    })

    it("shows a red error badge for a node with an error diagnostic (unknown ref)", () => {
      const store = storeWith(
        [
          {
            id: "t",
            type: "trigger.manual",
            typeVersion: 1,
            position: { x: 0, y: 0 },
            data: { label: "T", params: {} },
          },
          {
            id: "p",
            type: "ai.prompt",
            typeVersion: 1,
            position: { x: 200, y: 0 },
            data: { label: "P", params: { userPrompt: "{{ $node['ghost'].out.x }}" } },
          },
        ],
        [{ id: "e1", source: "t", target: "p" }]
      )
      renderNode({ store, id: "p", kind: "ai.prompt" })
      expect(screen.getByTestId("wf-node-error-badge")).toBeInTheDocument()
      expect(screen.queryByTestId("wf-node-warning-badge")).toBeNull()
    })
  })
})
