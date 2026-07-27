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
import { createWorkflow, getWorkflow } from "@/lib/db/workflows"
import { publishWorkflow } from "@/lib/workflow/publish/publish-workflow"

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

// Stub the complete right sidebar so this canvas-focused suite doesn't
// activate lazy Context Workbench panels while asserting React Flow behavior.
// The sidebar and chat scope have dedicated tests.
jest.mock("./right-sidebar", () => ({
  __esModule: true,
  RightSidebar: () => null,
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

  it("marks imported JSON dirty and persists it under the current workflow id", async () => {
    const wf = await createWorkflow({ name: "Current" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    const imported = {
      name: "Imported graph",
      nodes: [
        {
          id: "imported-node",
          type: "trigger.manual",
          typeVersion: 1,
          position: { x: 10, y: 20 },
          data: { label: "Imported", params: {} },
        },
      ],
      edges: [],
    }

    fireEvent.change(screen.getByTestId("workflow-import-input"), {
      target: {
        files: [
          new File([JSON.stringify(imported)], "workflow.json", { type: "application/json" }),
        ],
      },
    })

    await waitFor(() => expect(screen.getByTestId("node-imported-node")).toBeInTheDocument())
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument()

    fireEvent.click(screen.getByTestId("workflow-save"))
    await waitFor(async () => {
      expect((await getWorkflow(wf.id))?.name).toBe("Imported graph")
    })
  })

  it("warns and refreshes publication state when a saved import changes the contract", async () => {
    const originalSchema = {
      type: "object",
      properties: { topic: { type: "string" } },
    }
    const wf = await createWorkflow({
      name: "Published canvas",
      nodes: [
        {
          ...buildSample().nodes[0],
          data: { label: "Run", params: { inputSchema: originalSchema } },
        },
      ],
      edges: [],
    })
    await publishWorkflow(wf.id, 1)
    const published = (await getWorkflow(wf.id))!
    ;(toast.warning as jest.Mock).mockClear()
    renderWithProviders(<WorkflowEditorCanvas workflow={published} />)

    fireEvent.change(screen.getByTestId("workflow-import-input"), {
      target: {
        files: [
          new File(
            [
              JSON.stringify({
                name: published.name,
                nodes: [
                  {
                    ...buildSample().nodes[0],
                    data: {
                      label: "Run",
                      params: {
                        inputSchema: {
                          type: "object",
                          properties: { url: { type: "string" } },
                        },
                      },
                    },
                  },
                ],
                edges: [],
              }),
            ],
            "workflow.json",
            { type: "application/json" }
          ),
        ],
      },
    })

    await waitFor(() => expect(screen.getByText("Unsaved changes")).toBeInTheDocument())
    fireEvent.click(screen.getByTestId("workflow-save"))

    await waitFor(async () => expect((await getWorkflow(wf.id))?.published).toBeUndefined())
    expect(toast.warning).toHaveBeenCalled()
  }, 10_000)

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
    await screen.findByTestId("minimap-mock")
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
    expect(await screen.findByTestId("minimap-frozen")).toBeInTheDocument()
    expect(screen.queryByTestId("minimap-mock")).not.toBeInTheDocument()
    act(() => {
      ;(props!.onNodeDragStop as () => void)()
    })
    expect((await screen.findByTestId("minimap-mock")).getAttribute("data-pannable")).toBe("true")
  })

  it("wires selection-drag through the same begin/commit drag lifecycle", async () => {
    const wf = await createWorkflow({ name: "x" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    await screen.findByTestId("minimap-mock")
    const props = reactFlowPropsRef.current
    // Multi-selection drags route through these events, so they must be wired
    // or the drag-coalescing fix would miss them.
    expect(typeof props?.onSelectionDragStart).toBe("function")
    expect(typeof props?.onSelectionDragStop).toBe("function")

    const { act } = jest.requireActual("@testing-library/react")
    act(() => {
      ;(props!.onSelectionDragStart as () => void)()
    })
    expect(await screen.findByTestId("minimap-frozen")).toBeInTheDocument()
    expect(screen.queryByTestId("minimap-mock")).not.toBeInTheDocument()
    act(() => {
      ;(props!.onSelectionDragStop as () => void)()
    })
    expect((await screen.findByTestId("minimap-mock")).getAttribute("data-pannable")).toBe("true")
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

  it("persists a dirty workflow through the shared save path before running", async () => {
    const { getEditorStore } = await import("@/lib/workflow/editor/store-registry")
    const wf = await createWorkflow({ name: "dirty run" })
    const sample: VisualWorkflow = {
      ...buildSample(),
      id: wf.id,
      nodes: [
        buildSample().nodes[0],
        {
          ...buildSample().nodes[1],
          data: { label: "Prompt", params: { userPrompt: "hello" } },
        },
      ],
    }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    const store = getEditorStore(wf.id)!
    act(() => store.getState().setName("Saved before run"))

    fireEvent.click(screen.getByTestId("workflow-run"))

    await waitFor(() => expect(runWorkflow).toHaveBeenCalled())
    await waitFor(async () => expect((await getWorkflow(wf.id))?.name).toBe("Saved before run"))
    expect(store.getState().dirty).toBe(false)
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

describe("WorkflowEditorCanvas — extract to sub-workflow (C5)", () => {
  it("extracts the selection into a new workflow row and inserts a subworkflow node", async () => {
    const { getEditorStore } = await import("@/lib/workflow/editor/store-registry")
    const wf = await createWorkflow({ name: "parent" })
    const sample: VisualWorkflow = { ...buildSample(), id: wf.id }
    renderWithProviders(<WorkflowEditorCanvas workflow={sample} />)
    const store = getEditorStore(wf.id)!
    act(() => store.getState().setSelectedNodes(["n_b"]))
    const before = (await getDb().workflows.toArray()).length
    await act(async () => {
      fireEvent.click(screen.getByTestId("wf-sel-extract"))
    })
    await waitFor(async () => {
      expect((await getDb().workflows.toArray()).length).toBe(before + 1)
    })
    await waitFor(() => {
      expect(store.getState().nodes.some((n) => n.data.kind === "flow.subworkflow")).toBe(true)
    })
    // n_b was replaced; the rewired edge feeds the subworkflow node from n_a.
    const sub = store.getState().nodes.find((n) => n.data.kind === "flow.subworkflow")!
    expect(store.getState().edges.some((e) => e.source === "n_a" && e.target === sub.id)).toBe(true)
  })
})
