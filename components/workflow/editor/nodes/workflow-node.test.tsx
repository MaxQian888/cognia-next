/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import { EditorStoreProvider } from "@/lib/workflow/editor/store-context"
import type { VisualWorkflow, WorkflowNodeKind } from "@/types/workflow/visual"
import { WorkflowNodeComponent } from "./workflow-node"

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
}

function renderNode({
  id = "n_a",
  kind = "ai.prompt",
  selected = false,
  label = "Prompt",
  store,
  withProvider = true,
}: RenderArgs = {}) {
  const ui = (
    <TooltipProvider>
      <WorkflowNodeComponent
        id={id}
        type="workflowNode"
        selected={selected}
        data={{
          label,
          params: {},
          kind,
          typeVersion: 1,
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

  it("does not render the floating toolbar without a store provider", () => {
    renderNode({ withProvider: false })
    expect(screen.queryByTestId("wf-node-toolbar-n_a")).toBeNull()
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
})
