/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { SelectionToolbar } from "./selection-toolbar"

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

function seed(positions: Array<{ x: number; y: number }>): { store: EditorStore; ids: string[] } {
  const store = createEditorStore(makeWorkflow())
  const ids = positions.map((p) => store.getState().addNode("ai.prompt", p))
  store.getState().setSelectedNodes(ids)
  return { store, ids }
}

const mockRf = {
  getNode: () => ({ measured: { width: 100, height: 40 } }),
  fitView: jest.fn(),
} as unknown as Parameters<typeof SelectionToolbar>[0]["reactFlowInstance"]

function renderToolbar(store: EditorStore) {
  return render(
    <TooltipProvider>
      <SelectionToolbar store={store} reactFlowInstance={mockRf} motionEnabled />
    </TooltipProvider>
  )
}

beforeEach(() => jest.clearAllMocks())

describe("SelectionToolbar", () => {
  it("renders nothing when no node is selected", () => {
    const store = createEditorStore(makeWorkflow())
    renderToolbar(store)
    expect(screen.queryByTestId("wf-selection-toolbar")).toBeNull()
  })

  it("shows the selection count and core actions when nodes are selected", () => {
    const { store } = seed([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ])
    renderToolbar(store)
    expect(screen.getByTestId("wf-selection-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("wf-selection-count").textContent).toContain("2")
    expect(screen.getByTestId("wf-sel-duplicate")).toBeInTheDocument()
    expect(screen.getByTestId("wf-sel-fit")).toBeInTheDocument()
    expect(screen.getByTestId("wf-sel-delete")).toBeInTheDocument()
  })

  it("disables group and align with a single node selected", () => {
    const { store } = seed([{ x: 0, y: 0 }])
    renderToolbar(store)
    expect(screen.getByTestId("wf-sel-group")).toBeDisabled()
    expect(screen.getByTestId("wf-sel-align")).toBeDisabled()
  })

  it("duplicates the selection", () => {
    const { store } = seed([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ])
    renderToolbar(store)
    fireEvent.click(screen.getByTestId("wf-sel-duplicate"))
    expect(store.getState().nodes.length).toBe(4)
  })

  it("deletes the selection", () => {
    const { store } = seed([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ])
    renderToolbar(store)
    fireEvent.click(screen.getByTestId("wf-sel-delete"))
    expect(store.getState().nodes.length).toBe(0)
  })

  it("groups the selection into a frame", () => {
    const { store } = seed([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ])
    renderToolbar(store)
    fireEvent.click(screen.getByTestId("wf-sel-group"))
    expect(store.getState().nodes.length).toBe(3) // 2 nodes + 1 group frame
  })

  it("aligns selected nodes to the left edge", () => {
    const { store, ids } = seed([
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: 300, y: 80 },
    ])
    renderToolbar(store)
    fireEvent.click(screen.getByTestId("wf-sel-align"))
    fireEvent.click(screen.getByTestId("wf-sel-align-left"))
    const xs = ids.map((id) => store.getState().nodes.find((n) => n.id === id)!.position.x)
    expect(xs).toEqual([0, 0, 0])
  })

  it("distributes is disabled with only two nodes", () => {
    const { store } = seed([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ])
    renderToolbar(store)
    fireEvent.click(screen.getByTestId("wf-sel-align"))
    expect(screen.getByTestId("wf-sel-distribute-h")).toBeDisabled()
  })

  it("distributes three nodes horizontally with equal gaps", () => {
    const { store, ids } = seed([
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 300, y: 0 },
    ])
    renderToolbar(store)
    fireEvent.click(screen.getByTestId("wf-sel-align"))
    fireEvent.click(screen.getByTestId("wf-sel-distribute-h"))
    // widths 100 each (mock), span 0..400 → gap (400-300)/2 = 50. Middle → 0+100+50=150.
    const midX = store.getState().nodes.find((n) => n.id === ids[1])!.position.x
    expect(midX).toBe(150)
  })

  it("fits the viewport to the selection", () => {
    const { store } = seed([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ])
    renderToolbar(store)
    fireEvent.click(screen.getByTestId("wf-sel-fit"))
    expect(mockRf!.fitView).toHaveBeenCalledTimes(1)
  })

  it("invokes every align op and vertical distribute without throwing", () => {
    const { store } = seed([
      { x: 0, y: 0 },
      { x: 100, y: 50 },
      { x: 300, y: 80 },
    ])
    renderToolbar(store)
    fireEvent.click(screen.getByTestId("wf-sel-align"))
    for (const id of [
      "wf-sel-align-left",
      "wf-sel-align-centerH",
      "wf-sel-align-right",
      "wf-sel-align-top",
      "wf-sel-align-centerV",
      "wf-sel-align-bottom",
      "wf-sel-distribute-v",
    ]) {
      fireEvent.click(screen.getByTestId(id))
    }
    // All three nodes still present after the chain of operations.
    expect(store.getState().nodes.length).toBe(3)
  })

  it("falls back to default sizes with no React Flow instance and no motion", () => {
    const { store, ids } = seed([
      { x: 10, y: 0 },
      { x: 200, y: 0 },
    ])
    render(
      <TooltipProvider>
        <SelectionToolbar store={store} reactFlowInstance={null} motionEnabled={false} />
      </TooltipProvider>
    )
    fireEvent.click(screen.getByTestId("wf-sel-align"))
    fireEvent.click(screen.getByTestId("wf-sel-align-left"))
    const xs = ids.map((id) => store.getState().nodes.find((n) => n.id === id)!.position.x)
    expect(xs).toEqual([10, 10])
    // fit-to-selection is a no-op (null instance) but must not throw.
    fireEvent.click(screen.getByTestId("wf-sel-fit"))
  })

  it("no-ops alignment when the selection references a missing node", () => {
    const { store, ids } = seed([{ x: 5, y: 5 }])
    // Stale selection: a real id + a ghost id keeps the toolbar enabled (count 2)
    // but gatherRects yields a single rect, so computeAlign returns nothing.
    store.getState().setSelectedNodes([ids[0]!, "ghost"])
    renderToolbar(store)
    fireEvent.click(screen.getByTestId("wf-sel-align"))
    fireEvent.click(screen.getByTestId("wf-sel-align-right"))
    expect(store.getState().nodes.find((n) => n.id === ids[0])!.position.x).toBe(5)
  })
})
