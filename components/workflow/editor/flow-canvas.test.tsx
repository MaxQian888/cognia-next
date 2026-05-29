/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { render, screen } from "@testing-library/react"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import { EditorStoreProvider } from "@/lib/workflow/editor/store-context"
import { flagsForTier, resolveEffectiveTier } from "@/lib/workflow/editor/performance-tier"
import type { EffectivePerfTier } from "@/hooks/workflow/use-effective-perf-tier"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { FlowCanvas } from "./flow-canvas"

// Capture the props ReactFlow is handed so tests can drive its callbacks and
// assert the canvas wired them to the store. Mirrors canvas.test.tsx.
const reactFlowPropsRef: { current: Record<string, unknown> | null } = { current: null }

jest.mock("@xyflow/react", () => {
  const React = jest.requireActual("react")
  return {
    __esModule: true,
    ReactFlow: (
      props: {
        nodes: Array<{ id: string }>
        edges: Array<{ id: string }>
        children?: React.ReactNode
      } & Record<string, unknown>
    ) => {
      reactFlowPropsRef.current = props
      return React.createElement(
        "div",
        {
          "data-testid": "react-flow-mock",
          "data-snap-to-grid": String(props.snapToGrid ?? ""),
          "data-only-visible": String(props.onlyRenderVisibleElements ?? ""),
        },
        props.nodes.map((n) =>
          React.createElement("div", { key: n.id, "data-testid": `node-${n.id}` })
        ),
        props.children
      )
    },
    Background: () => null,
    BackgroundVariant: { Dots: "dots", Lines: "lines" },
    ViewportPortal: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    MiniMap: (props: Record<string, unknown>) =>
      React.createElement("div", {
        "data-testid": "minimap-mock",
        "data-pannable": String(props.pannable ?? ""),
      }),
    Handle: () => null,
    Position: { Left: "left", Right: "right" },
    useReactFlow: () => ({
      getNode: () => ({ measured: { width: 240, height: 80 } }),
      getNodes: () => [],
      setViewport: () => undefined,
      fitView: () => undefined,
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    }),
    useOnViewportChange: () => undefined,
    applyNodeChanges: (_c: unknown, n: unknown) => n,
    applyEdgeChanges: (_c: unknown, e: unknown) => e,
    addEdge: (e: unknown, edges: unknown[]) => [...edges, e],
  }
})

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

function seedStore(): { store: EditorStore; trigger: string; ai: string } {
  const store = createEditorStore(makeWorkflow())
  const trigger = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
  const ai = store.getState().addNode("ai.prompt", { x: 200, y: 0 })
  // Reset dirty so tests can assert the *first* mutation flips it.
  store.getState().markSaved()
  return { store, trigger, ai }
}

function perfTier(): EffectivePerfTier {
  const effective = resolveEffectiveTier("high", { nodeCount: 2, prefersReducedMotion: false })
  return {
    effective,
    flags: flagsForTier(effective),
    userChoice: "high",
    setUserChoice: () => undefined,
  }
}

function renderCanvas(store: EditorStore) {
  reactFlowPropsRef.current = null
  const wrapperRef = { current: null as HTMLDivElement | null }
  return render(
    <EditorStoreProvider store={store}>
      <FlowCanvas
        store={store}
        perfTier={perfTier()}
        reactFlowInstance={null}
        setReactFlowInstance={() => undefined}
        canvasWrapperRef={wrapperRef}
        interactive={true}
        minimapVisible={true}
        backgroundVariant="dots"
        minimapNodeColor={() => "#000"}
        connectionLineGhost={() => null}
        onDrop={() => undefined}
        onDragOver={() => undefined}
        onPaneContextMenu={() => undefined}
        onNodeContextMenu={() => undefined}
        onEdgeContextMenu={() => undefined}
        overlays={<div data-testid="overlays-slot" />}
      />
    </EditorStoreProvider>
  )
}

describe("FlowCanvas", () => {
  it("renders the wrapper, React Flow surface, nodes and the overlays slot", () => {
    const { store, trigger, ai } = seedStore()
    renderCanvas(store)
    expect(screen.getByTestId("workflow-canvas")).toBeInTheDocument()
    expect(screen.getByTestId("react-flow-mock")).toBeInTheDocument()
    expect(screen.getByTestId(`node-${trigger}`)).toBeInTheDocument()
    expect(screen.getByTestId(`node-${ai}`)).toBeInTheDocument()
    expect(screen.getByTestId("overlays-slot")).toBeInTheDocument()
  })

  it("passes snapToGrid through from the store", () => {
    const { store } = seedStore()
    renderCanvas(store)
    expect(screen.getByTestId("react-flow-mock").getAttribute("data-snap-to-grid")).toBe("true")
  })

  it("onNodesChange syncs a selection change into the store", () => {
    const { store, trigger } = seedStore()
    renderCanvas(store)
    const onNodesChange = reactFlowPropsRef.current!.onNodesChange as (c: unknown[]) => void
    const { act } = jest.requireActual("@testing-library/react")
    act(() => onNodesChange([{ type: "select", id: trigger, selected: true }]))
    expect(store.getState().selectedNodeIds).toContain(trigger)
  })

  it("onConnect validates and appends a valid edge", () => {
    const { store, trigger, ai } = seedStore()
    renderCanvas(store)
    const onConnect = reactFlowPropsRef.current!.onConnect as (c: unknown) => void
    const before = store.getState().edges.length
    const { act } = jest.requireActual("@testing-library/react")
    act(() => onConnect({ source: trigger, target: ai, sourceHandle: null, targetHandle: null }))
    expect(store.getState().edges.length).toBe(before + 1)
  })

  it("node-drag lifecycle flips isDraggingAny and coalesces one undo entry", () => {
    const { store, trigger } = seedStore()
    renderCanvas(store)
    const props = reactFlowPropsRef.current!
    const { act } = jest.requireActual("@testing-library/react")
    act(() => {
      ;(props.onNodeDragStart as (...a: unknown[]) => void)(
        {},
        { id: trigger, position: { x: 0, y: 0 } }
      )
    })
    expect(store.getState().isDraggingAny).toBe(true)
    act(() => (props.onNodeDragStop as () => void)())
    expect(store.getState().isDraggingAny).toBe(false)
  })

  it("onMoveEnd writes the viewport back to the store", () => {
    const { store } = seedStore()
    renderCanvas(store)
    const onMoveEnd = reactFlowPropsRef.current!.onMoveEnd as (e: unknown, v: unknown) => void
    const { act } = jest.requireActual("@testing-library/react")
    act(() => onMoveEnd({}, { x: 10, y: 20, zoom: 1.5 }))
    expect(store.getState().viewport).toEqual({ x: 10, y: 20, zoom: 1.5 })
  })
})
