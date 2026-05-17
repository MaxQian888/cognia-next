/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { CanvasContextMenu, type ContextTarget } from "./canvas-context-menu"

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

function buildSeeded(): { store: EditorStore; triggerId: string; aiId: string; edgeId: string } {
  const store = createEditorStore(makeWorkflow())
  const triggerId = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
  const aiId = store.getState().addNode("ai.prompt", { x: 200, y: 0 })
  const edgeId = store.getState().connect({ source: triggerId, target: aiId })
  return { store, triggerId, aiId, edgeId }
}

function renderMenu(
  target: ContextTarget,
  store: EditorStore,
  overrides: Partial<React.ComponentProps<typeof CanvasContextMenu>> = {}
) {
  const noop = () => undefined
  const props: React.ComponentProps<typeof CanvasContextMenu> = {
    open: true,
    position: { x: 10, y: 20 },
    target,
    store,
    onClose: noop,
    onAddNodeAtPosition: noop,
    onResetView: noop,
    onConfigureNode: noop,
    onRunFromNode: noop,
    onCopyNode: noop,
    onEditEdgeLabel: noop,
    onPaste: noop,
    ...overrides,
  }
  return render(
    <TooltipProvider>
      <CanvasContextMenu {...props} />
    </TooltipProvider>
  )
}

describe("CanvasContextMenu — pane", () => {
  it("renders the six pane actions", () => {
    const { store } = buildSeeded()
    renderMenu({ kind: "pane", flowPos: { x: 50, y: 50 } }, store)
    expect(screen.getByTestId("ctx-pane-paste")).toBeInTheDocument()
    expect(screen.getByTestId("ctx-pane-add-node")).toBeInTheDocument()
    expect(screen.getByTestId("ctx-pane-add-sticky")).toBeInTheDocument()
    expect(screen.getByTestId("ctx-pane-add-group")).toBeInTheDocument()
    expect(screen.getByTestId("ctx-pane-reset-view")).toBeInTheDocument()
    expect(screen.getByTestId("ctx-pane-toggle-snap")).toBeInTheDocument()
  })

  it("paste fires the onPaste callback", () => {
    const { store } = buildSeeded()
    const onPaste = jest.fn()
    const onClose = jest.fn()
    renderMenu({ kind: "pane", flowPos: { x: 0, y: 0 } }, store, { onPaste, onClose })
    screen.getByTestId("ctx-pane-paste").click()
    expect(onPaste).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("add-node passes the flow-space position through", () => {
    const { store } = buildSeeded()
    const onAddNodeAtPosition = jest.fn()
    renderMenu({ kind: "pane", flowPos: { x: 42, y: 99 } }, store, { onAddNodeAtPosition })
    screen.getByTestId("ctx-pane-add-node").click()
    expect(onAddNodeAtPosition).toHaveBeenCalledWith({ x: 42, y: 99 })
  })

  it("toggle-snap inverts the store's snapToGrid flag", () => {
    const { store } = buildSeeded()
    expect(store.getState().snapToGrid).toBe(true)
    renderMenu({ kind: "pane", flowPos: { x: 0, y: 0 } }, store)
    screen.getByTestId("ctx-pane-toggle-snap").click()
    expect(store.getState().snapToGrid).toBe(false)
  })

  it("add-sticky inserts an annotation.note at the click position", () => {
    const { store } = buildSeeded()
    const before = store.getState().nodes.length
    renderMenu({ kind: "pane", flowPos: { x: 11, y: 22 } }, store)
    screen.getByTestId("ctx-pane-add-sticky").click()
    expect(store.getState().nodes).toHaveLength(before + 1)
    const last = store.getState().nodes[store.getState().nodes.length - 1]
    expect(last.data.kind).toBe("annotation.note")
    expect(last.position).toEqual({ x: 11, y: 22 })
  })
})

describe("CanvasContextMenu — node", () => {
  it("greys 'Run from here' for triggers", () => {
    const { store, triggerId } = buildSeeded()
    renderMenu({ kind: "node", nodeId: triggerId }, store)
    expect(screen.getByTestId("ctx-node-run-from")).toHaveAttribute("data-disabled")
  })

  it("enables 'Run from here' for action nodes", () => {
    const { store, aiId } = buildSeeded()
    renderMenu({ kind: "node", nodeId: aiId }, store)
    expect(screen.getByTestId("ctx-node-run-from")).not.toHaveAttribute("data-disabled")
  })

  it("Disable toggles data.disabled", () => {
    const { store, aiId } = buildSeeded()
    renderMenu({ kind: "node", nodeId: aiId }, store)
    expect(store.getState().nodes.find((n) => n.id === aiId)?.data.disabled).toBeFalsy()
    screen.getByTestId("ctx-node-toggle-disabled").click()
    expect(store.getState().nodes.find((n) => n.id === aiId)?.data.disabled).toBe(true)
  })

  it("Rename sets editingNodeIdInline in the store", () => {
    const { store, aiId } = buildSeeded()
    renderMenu({ kind: "node", nodeId: aiId }, store)
    screen.getByTestId("ctx-node-rename").click()
    expect(store.getState().editingNodeIdInline).toBe(aiId)
  })

  it("Delete drops the node from the store", () => {
    const { store, aiId } = buildSeeded()
    const before = store.getState().nodes.length
    renderMenu({ kind: "node", nodeId: aiId }, store)
    screen.getByTestId("ctx-node-delete").click()
    expect(store.getState().nodes).toHaveLength(before - 1)
  })
})

describe("CanvasContextMenu — edge", () => {
  it("greys 'Reverse direction' when the reverse would target a trigger", () => {
    const { store, edgeId } = buildSeeded()
    renderMenu({ kind: "edge", edgeId }, store)
    // The original edge is trigger → ai. Reversing would create ai → trigger,
    // which validateConnection rejects (triggers can't be targets).
    expect(screen.getByTestId("ctx-edge-reverse")).toHaveAttribute("data-disabled")
  })

  it("'Convert to conditional' tags the edge with data.kind = 'then'", () => {
    const { store, edgeId } = buildSeeded()
    renderMenu({ kind: "edge", edgeId }, store)
    screen.getByTestId("ctx-edge-to-conditional").click()
    const edge = store.getState().edges.find((e) => e.id === edgeId)
    expect((edge?.data as { kind?: string } | undefined)?.kind).toBe("then")
  })

  it("Delete removes the edge", () => {
    const { store, edgeId } = buildSeeded()
    renderMenu({ kind: "edge", edgeId }, store)
    screen.getByTestId("ctx-edge-delete").click()
    expect(store.getState().edges.find((e) => e.id === edgeId)).toBeUndefined()
  })

  it("Edit label fires onEditEdgeLabel with the edge id", () => {
    const { store, edgeId } = buildSeeded()
    const onEditEdgeLabel = jest.fn()
    renderMenu({ kind: "edge", edgeId }, store, { onEditEdgeLabel })
    screen.getByTestId("ctx-edge-edit-label").click()
    expect(onEditEdgeLabel).toHaveBeenCalledWith(edgeId)
  })
})

describe("CanvasContextMenu — rendering gates", () => {
  it("renders nothing when open=false", () => {
    const { store } = buildSeeded()
    const { container } = renderMenu({ kind: "pane", flowPos: { x: 0, y: 0 } }, store, {
      open: false,
    })
    expect(container).toBeEmptyDOMElement()
  })

  it("renders nothing when target=null", () => {
    const { store } = buildSeeded()
    const noop = () => undefined
    const { container } = render(
      <TooltipProvider>
        <CanvasContextMenu
          open
          position={{ x: 0, y: 0 }}
          target={null}
          store={store}
          onClose={noop}
          onAddNodeAtPosition={noop}
          onResetView={noop}
          onConfigureNode={noop}
          onRunFromNode={noop}
          onCopyNode={noop}
          onEditEdgeLabel={noop}
          onPaste={noop}
        />
      </TooltipProvider>
    )
    expect(container).toBeEmptyDOMElement()
  })
})
