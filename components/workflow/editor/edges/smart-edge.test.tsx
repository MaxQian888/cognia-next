/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import { EditorStoreProvider } from "@/lib/workflow/editor/store-context"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { SmartEdge } from "./smart-edge"

// Capture props passed to BaseEdge so tests can assert on stroke and path.
const baseEdgeProps: { current: Record<string, unknown> | null } = { current: null }
// Count BaseEdge invocations == SmartEdge renders, so a test can prove the
// edge does NOT re-render when an unrelated node moves.
const baseEdgeRenders = { count: 0 }

jest.mock("@xyflow/react", () => ({
  __esModule: true,
  BaseEdge: (props: Record<string, unknown>) => {
    baseEdgeProps.current = props
    baseEdgeRenders.count++
    return (
      <div
        data-testid="base-edge"
        data-stroke={(props.style as React.CSSProperties | undefined)?.stroke ?? ""}
        data-dash={(props.style as React.CSSProperties | undefined)?.strokeDasharray ?? ""}
        onMouseEnter={props.onMouseEnter as React.MouseEventHandler}
        onMouseLeave={props.onMouseLeave as React.MouseEventHandler}
      />
    )
  },
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useReactFlow: () => ({
    getNodes: () => [],
  }),
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

function seedStore(): EditorStore {
  const store = createEditorStore(makeWorkflow())
  const a = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
  const b = store.getState().addNode("ai.prompt", { x: 200, y: 0 })
  store.getState().connect({ source: a, target: b })
  return store
}

function renderEdge(
  props: Partial<React.ComponentProps<typeof SmartEdge>> = {},
  store?: EditorStore
) {
  baseEdgeProps.current = null
  baseEdgeRenders.count = 0
  const defaults = {
    id: "e_1",
    source: "n_a",
    target: "n_b",
    sourceX: 0,
    sourceY: 0,
    targetX: 200,
    targetY: 100,
    sourcePosition: "right",
    targetPosition: "left",
    selected: false,
    animated: false,
  }
  const full = { ...defaults, ...props } as unknown as React.ComponentProps<typeof SmartEdge>
  const ui = (
    <div>
      <SmartEdge {...full} />
    </div>
  )
  return render(store ? <EditorStoreProvider store={store}>{ui}</EditorStoreProvider> : ui)
}

describe("SmartEdge", () => {
  it("renders a path via BaseEdge", () => {
    renderEdge()
    expect(screen.getByTestId("base-edge")).toBeInTheDocument()
  })

  it("renders an edge-kind chip when data.kind = 'then'", () => {
    renderEdge({ data: { kind: "then" } as Record<string, unknown> })
    const chip = screen.getByTestId("smart-edge-kind-e_1")
    expect(chip.getAttribute("data-kind")).toBe("then")
    expect(chip.className).toContain("bg-emerald-500/15")
  })

  it("ignores unknown data.kind values", () => {
    renderEdge({ data: { kind: "weird" } as Record<string, unknown> })
    expect(screen.queryByTestId("smart-edge-kind-e_1")).toBeNull()
  })

  it("strokeDasharray is omitted when animated=true but tier=reduced", () => {
    const store = seedStore()
    store.getState().setPerformanceTier("reduced")
    renderEdge({ animated: true }, store)
    const edge = screen.getByTestId("base-edge")
    expect(edge.getAttribute("data-dash")).toBe("")
  })

  it("emits dashed stroke when animated=true and tier allows edge animations", () => {
    const store = seedStore()
    store.getState().setPerformanceTier("high")
    renderEdge({ animated: true }, store)
    const edge = screen.getByTestId("base-edge")
    expect(edge.getAttribute("data-dash")).toBe("5 5")
  })

  it("mouseEnter / leave drives hoveredEdgeId", () => {
    const store = seedStore()
    renderEdge({}, store)
    fireEvent.mouseEnter(screen.getByTestId("base-edge"))
    expect(store.getState().hoveredEdgeId).toBe("e_1")
    fireEvent.mouseLeave(screen.getByTestId("base-edge"))
    expect(store.getState().hoveredEdgeId).toBeNull()
  })

  it("renders a label button when data.label is set; double-click switches to an Input", () => {
    const store = seedStore()
    renderEdge({ data: { label: "click me" } as Record<string, unknown> }, store)
    const btn = screen.getByTestId("smart-edge-label-button-e_1")
    expect(btn.textContent).toBe("click me")
    fireEvent.doubleClick(btn)
    expect(store.getState().editingEdgeIdInline).toBe("e_1")
  })

  it("Enter inside the inline input commits via updateEdgeData", () => {
    const store = seedStore()
    // Mark the edge as being edited up-front.
    store.getState().setEditingEdgeIdInline("e_1")
    renderEdge({ data: { label: "old" } as Record<string, unknown> }, store)
    const input = screen.getByTestId("smart-edge-label-input-e_1") as HTMLInputElement
    fireEvent.change(input, { target: { value: "new" } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(store.getState().editingEdgeIdInline).toBeNull()
  })

  it("Escape inside the inline input cancels without updating", () => {
    const store = seedStore()
    store.getState().setEditingEdgeIdInline("e_1")
    renderEdge({ data: { label: "old" } as Record<string, unknown> }, store)
    const input = screen.getByTestId("smart-edge-label-input-e_1") as HTMLInputElement
    fireEvent.change(input, { target: { value: "discarded" } })
    fireEvent.keyDown(input, { key: "Escape" })
    expect(store.getState().editingEdgeIdInline).toBeNull()
  })

  it("renders true/false chips from a v2 handle id without data.kind", () => {
    renderEdge({ sourceHandleId: "true" } as Partial<React.ComponentProps<typeof SmartEdge>>)
    expect(screen.getByTestId("smart-edge-kind-e_1").getAttribute("data-kind")).toBe("true")
  })

  it("renders the default chip for the switch fall-through handle", () => {
    renderEdge({ sourceHandleId: "default" } as Partial<React.ComponentProps<typeof SmartEdge>>)
    expect(screen.getByTestId("smart-edge-kind-e_1").getAttribute("data-kind")).toBe("default")
  })

  it("renders a switch case label chip resolved from the source node", () => {
    const store = createEditorStore(makeWorkflow())
    const sw = store.getState().addNode(
      "flow.switch",
      { x: 0, y: 0 },
      {
        params: {
          cases: [{ id: "c_vip", label: "VIP", when: { combinator: "all", conditions: [] } }],
        },
      }
    )
    const b = store.getState().addNode("ai.prompt", { x: 200, y: 0 })
    renderEdge(
      { source: sw, target: b, sourceHandleId: "c_vip" } as Partial<
        React.ComponentProps<typeof SmartEdge>
      >,
      store
    )
    const chip = screen.getByTestId("smart-edge-case-e_1")
    expect(chip.textContent).toBe("VIP")
  })

  it("does not re-render when a node moves but the node count is unchanged", () => {
    const store = seedStore()
    renderEdge({}, store)
    const before = baseEdgeRenders.count
    const { act } = jest.requireActual("@testing-library/react")
    act(() => {
      // Simulate a drag frame: a fresh `nodes` array of the same length with
      // one node moved. The edge subscribes to `nodes.length` (a primitive),
      // not the array, so this must NOT re-render it.
      store
        .getState()
        .setNodes(
          store
            .getState()
            .nodes.map((n) => ({ ...n, position: { x: n.position.x + 10, y: n.position.y } }))
        )
    })
    expect(baseEdgeRenders.count).toBe(before)
  })
})
