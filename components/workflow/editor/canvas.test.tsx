/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react"
import { TooltipProvider } from "@/components/ui/tooltip"
import { WorkflowEditorCanvas } from "./canvas"
import { runWorkflow } from "@/lib/workflow/runtime/orchestrator"
import { toast } from "sonner"
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

// Stub the workflow-editor chat tab so this canvas-focused suite doesn't
// pay the cost of pulling the chat-ui dependency graph (ai-elements →
// use-stick-to-bottom is ESM-only). The full chat-tab is covered by its
// own tests under `hooks/chat/` + `plugins/workflow-ai/`.
jest.mock("./right-sidebar/chat-tab", () => ({
  __esModule: true,
  WorkflowEditorChatTab: () => null,
}))

// Mock the runtime so the run gate can be asserted without executing a real
// workflow. Other tests in this suite never trigger a run, so the no-op
// stand-ins are inert for them.
jest.mock("@/lib/workflow/runtime/orchestrator", () => ({
  runWorkflow: jest.fn(async () => ({ status: "succeeded" })),
}))
jest.mock("@/lib/workflow/runtime/run-single-node", () => ({
  runSingleNode: jest.fn(async () => ({ status: "succeeded" })),
}))
jest.mock("sonner", () => ({
  toast: Object.assign(jest.fn(), {
    error: jest.fn(),
    success: jest.fn(),
    warning: jest.fn(),
    loading: jest.fn(() => "toast-id"),
  }),
}))

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
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    }),
    // ViewportBreadcrumb subscribes here for live pan/zoom updates. The
    // canvas suite only asserts on the React Flow surface, so a no-op stub
    // is fine — the dedicated viewport-breadcrumb.test.tsx exercises the
    // subscription path directly.
    useOnViewportChange: (_args: unknown) => undefined,
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

  it("wires selection-drag through the same begin/commit drag lifecycle", async () => {
    const wf = await createWorkflow({ name: "x" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    const props = reactFlowPropsRef.current
    // Multi-selection drags route through these events, so they must be wired
    // or the drag-coalescing fix would miss them.
    expect(typeof props?.onSelectionDragStart).toBe("function")
    expect(typeof props?.onSelectionDragStop).toBe("function")

    const { act } = jest.requireActual("@testing-library/react")
    act(() => {
      ;(props!.onSelectionDragStart as () => void)()
    })
    expect(screen.getByTestId("minimap-mock").getAttribute("data-pannable")).toBe("false")
    act(() => {
      ;(props!.onSelectionDragStop as () => void)()
    })
    expect(screen.getByTestId("minimap-mock").getAttribute("data-pannable")).toBe("true")
  })

  it("flips minimap to degraded mode while the viewport is panning/zooming", async () => {
    const wf = await createWorkflow({ name: "x" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    const props = reactFlowPropsRef.current
    expect(typeof props?.onMoveStart).toBe("function")
    expect(typeof props?.onMoveEnd).toBe("function")
    // After this change `onMove` no longer fires React state updates on the
    // canvas parent — only the breadcrumb owns the per-frame viewport.
    expect(props?.onMove).toBeUndefined()

    const { act } = jest.requireActual("@testing-library/react")
    act(() => {
      ;(props!.onMoveStart as (...args: unknown[]) => void)({}, { x: 0, y: 0, zoom: 1 })
    })
    expect(screen.getByTestId("minimap-mock").getAttribute("data-pannable")).toBe("false")
    act(() => {
      ;(props!.onMoveEnd as (...args: unknown[]) => void)({}, { x: 0, y: 0, zoom: 1 })
    })
    expect(screen.getByTestId("minimap-mock").getAttribute("data-pannable")).toBe("true")
  })

  it("passes stable onConnectStart / onConnectEnd identities across renders", async () => {
    const wf = await createWorkflow({ name: "x" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    const { rerender } = renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    const first = reactFlowPropsRef.current
    expect(typeof first?.onConnectStart).toBe("function")
    expect(typeof first?.onConnectEnd).toBe("function")
    const firstStart = first!.onConnectStart
    const firstEnd = first!.onConnectEnd

    // Trigger a re-render with the same workflow object — identities should
    // be reused thanks to `useCallback`. (No inline arrows on ReactFlow.)
    rerender(
      <TooltipProvider>
        <WorkflowEditorCanvas workflow={sample} />
      </TooltipProvider>
    )
    const second = reactFlowPropsRef.current
    expect(second?.onConnectStart).toBe(firstStart)
    expect(second?.onConnectEnd).toBe(firstEnd)
  })
})

describe("WorkflowEditorCanvas — run gate", () => {
  beforeEach(() => {
    ;(runWorkflow as jest.Mock).mockClear()
    ;(toast.error as jest.Mock).mockClear()
  })

  it("blocks the run and surfaces an error toast when the workflow has error diagnostics", async () => {
    const wf = await createWorkflow({ name: "blocked" })
    // n_b (ai.prompt) has empty params → missing userPrompt → nodeParam error.
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    fireEvent.click(screen.getByTestId("workflow-run"))
    expect(runWorkflow).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
  })

  it("runs when there are no error diagnostics (warnings don't block)", async () => {
    const wf = await createWorkflow({ name: "clean" })
    const sample: VisualWorkflow = {
      ...buildSample(),
      id: wf.id,
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
          data: { label: "Prompt", params: { userPrompt: "hello" } },
        },
      ],
    }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    fireEvent.click(screen.getByTestId("workflow-run"))
    await waitFor(() => expect(runWorkflow).toHaveBeenCalled())
  })
})

describe("WorkflowEditorCanvas — keyboard create+connect (C3)", () => {
  it("Tab with one node selected stages a pendingConnectFrom from its output handle", async () => {
    const { getEditorStore } = await import("@/lib/workflow/editor/store-registry")
    const wf = await createWorkflow({ name: "kbd" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    const store = getEditorStore(wf.id)!
    expect(store).toBeTruthy()
    act(() => store.getState().setSelectedNodes(["n_a"]))
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }))
    })
    const pending = store.getState().pendingConnectFrom
    expect(pending?.sourceId).toBe("n_a")
    // Positioned to the right of the source node.
    expect(pending?.dropPos.x).toBeGreaterThan(0)
  })
})
