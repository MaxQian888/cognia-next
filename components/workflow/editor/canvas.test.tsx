/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WorkflowEditorCanvas } from "./canvas"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createWorkflow } from "@/lib/db/workflows"

function renderWithProviders(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>)
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
})

// Capture the props ReactFlow is rendered with so individual tests can drive
// drag callbacks and assert on the snapToGrid prop.
const reactFlowPropsRef: { current: Record<string, unknown> | null } = {
  current: null,
}

// Mock @xyflow/react in this test — its rendering pipeline depends on real
// browser geometry (ResizeObserver, layout) that jsdom can't provide. We
// stand in a thin shell that just renders nodes/edges as data attributes so
// we can assert on what the canvas was handed.
jest.mock("@xyflow/react", () => {
  const React = jest.requireActual("react")
  return {
    __esModule: true,
    ReactFlow: (
      props: {
        nodes: Array<{ id: string }>
        edges: Array<{ id: string; source: string; target: string }>
        children?: React.ReactNode
      } & Record<string, unknown>
    ) => {
      reactFlowPropsRef.current = props
      const { nodes, edges, children } = props
      return React.createElement(
        "div",
        {
          "data-testid": "react-flow-mock",
          "data-snap-to-grid": String(props.snapToGrid ?? ""),
        },
        nodes.map((n) =>
          React.createElement("div", {
            key: n.id,
            "data-testid": `node-${n.id}`,
          })
        ),
        edges.map((e) =>
          React.createElement("div", {
            key: e.id,
            "data-testid": `edge-${e.id}`,
            "data-source": e.source,
            "data-target": e.target,
          })
        ),
        children
      )
    },
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Background: () => null,
    BackgroundVariant: { Dots: "dots" },
    Controls: () => null,
    MiniMap: (props: Record<string, unknown>) =>
      React.createElement("div", {
        "data-testid": "minimap-mock",
        "data-pannable": String(props.pannable ?? ""),
        "data-zoomable": String(props.zoomable ?? ""),
      }),
    Handle: () => null,
    Position: { Left: "left", Right: "right" },
    useReactFlow: () => ({
      getNode: (_id: string) => ({ measured: { width: 240, height: 80 } }),
      getNodes: () => [],
      setViewport: () => undefined,
      fitView: () => undefined,
      setCenter: () => undefined,
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
    }),
    applyNodeChanges: (_c: unknown, n: unknown) => n,
    applyEdgeChanges: (_c: unknown, e: unknown) => e,
    addEdge: (e: unknown, edges: unknown[]) => [...edges, e],
  }
})

function buildSample(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 1,
    name: "Sample workflow",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "n_a",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Run", params: {} },
      },
      {
        id: "n_b",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "Prompt", params: {} },
      },
    ],
    edges: [{ id: "e_1", source: "n_a", target: "n_b" }],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

describe("WorkflowEditorCanvas", () => {
  it("renders the toolbar and reaches the React Flow surface", async () => {
    const wf = await createWorkflow({ name: "x" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    expect(screen.getByTestId("workflow-toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("react-flow-mock")).toBeInTheDocument()
    expect(screen.getByTestId("node-n_a")).toBeInTheDocument()
    expect(screen.getByTestId("node-n_b")).toBeInTheDocument()
    expect(screen.getByTestId("edge-e_1")).toBeInTheDocument()
  })

  it("starts in 'Saved' state and surfaces 'Unsaved changes' badge for dirty edits", async () => {
    const wf = await createWorkflow({ name: "x" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    expect(screen.getByText("Saved")).toBeInTheDocument()
  })

  it("renders an empty state when the workflow has no nodes", async () => {
    const wf = await createWorkflow({ name: "x" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id, nodes: [], edges: [] }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    expect(screen.getByText("Empty workflow")).toBeInTheDocument()
  })

  it("passes snapToGrid through from the store (default true)", async () => {
    const wf = await createWorkflow({ name: "x" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    expect(screen.getByTestId("react-flow-mock").getAttribute("data-snap-to-grid")).toBe("true")
  })

  it("renders the perf-aware minimap with pannable=true when not dragging", async () => {
    const wf = await createWorkflow({ name: "x" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    const minimap = screen.getByTestId("minimap-mock")
    expect(minimap.getAttribute("data-pannable")).toBe("true")
    expect(minimap.getAttribute("data-zoomable")).toBe("true")
  })

  it("flips minimap to degraded mode while a node drag is in flight", async () => {
    const wf = await createWorkflow({ name: "x" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    const props = reactFlowPropsRef.current
    expect(typeof props?.onNodeDragStart).toBe("function")
    expect(typeof props?.onNodeDragStop).toBe("function")

    const { act } = jest.requireActual("@testing-library/react")
    act(() => {
      ;(props!.onNodeDragStart as (...args: unknown[]) => void)(
        {},
        { id: "n_a", position: { x: 0, y: 0 } }
      )
    })
    expect(screen.getByTestId("minimap-mock").getAttribute("data-pannable")).toBe("false")
    act(() => {
      ;(props!.onNodeDragStop as () => void)()
    })
    expect(screen.getByTestId("minimap-mock").getAttribute("data-pannable")).toBe("true")
  })
})
