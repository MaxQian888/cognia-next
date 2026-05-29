/**
 * @jest-environment jsdom
 */

import { act, render } from "@testing-library/react"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { ConnectionLineGhostFactory, ConnectionPointerListener } from "./connection-overlay"

const mockedRfi = {
  screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
  getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
  getNodes: () => [],
}

jest.mock("@xyflow/react", () => ({
  __esModule: true,
  useReactFlow: () => mockedRfi,
}))

beforeEach(() => {
  ;(
    globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }
  ).requestAnimationFrame = (cb) => {
    cb()
    return 1
  }
  ;(globalThis as unknown as { cancelAnimationFrame: () => void }).cancelAnimationFrame = () =>
    undefined
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

function buildStore(): { store: EditorStore; trigger: string; ai: string } {
  const store = createEditorStore(makeWorkflow())
  const trigger = store.getState().addNode("trigger.manual", { x: 0, y: 0 })
  const ai = store.getState().addNode("ai.prompt", { x: 100, y: 100 })
  return { store, trigger, ai }
}

function dispatchPointerMove(clientX: number, clientY: number) {
  const e = new MouseEvent("pointermove", {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
  })
  window.dispatchEvent(e)
}

describe("ConnectionPointerListener", () => {
  it("does nothing when no connection is in flight", () => {
    const { store } = buildStore()
    render(<ConnectionPointerListener store={store} />)
    dispatchPointerMove(50, 50)
    expect(store.getState().connectionState).toBeNull()
  })

  it("populates `candidate` when the pointer is within snap distance of a compatible handle", () => {
    const { store, trigger, ai } = buildStore()
    store.getState().beginConnection({ sourceId: trigger, sourceHandle: null })
    render(<ConnectionPointerListener store={store} />)
    // AI input handle sits at flow x=100, y=140 (position.y + height/2 = 100+40).
    // Dispatch a pointermove right on it.
    act(() => dispatchPointerMove(100, 140))
    const cs = store.getState().connectionState!
    expect(cs.candidate?.nodeId).toBe(ai)
  })

  it("leaves candidate=null when the pointer is too far from any handle", () => {
    const { store, trigger } = buildStore()
    store.getState().beginConnection({ sourceId: trigger, sourceHandle: null })
    render(<ConnectionPointerListener store={store} />)
    act(() => dispatchPointerMove(900, 900))
    expect(store.getState().connectionState?.candidate).toBeNull()
  })

  it("skips incompatible target nodes (trigger as target invalidated by validator)", () => {
    const { store, trigger } = buildStore()
    // Try to drag from the AI node to the trigger; trigger can't be a target.
    const aiId = store.getState().nodes.find((n) => n.data.kind === "ai.prompt")!.id
    store.getState().beginConnection({ sourceId: aiId, sourceHandle: null })
    render(<ConnectionPointerListener store={store} />)
    // Pointer is right on the trigger's "input" position (it has no input
    // handle because it's a trigger; collectTargetHandles excludes it).
    act(() => dispatchPointerMove(0, 40))
    expect(store.getState().connectionState?.candidate).toBeNull()
    // The trigger node id is also unused via `_unused`; reference to silence
    // the lint.
    void trigger
  })

  it("recomputes valid candidates when a new connection starts from a different source", () => {
    const { store, trigger, ai } = buildStore()
    // First connection: drag from the trigger — the AI node is a valid target.
    store.getState().beginConnection({ sourceId: trigger, sourceHandle: null })
    const { rerender } = render(<ConnectionPointerListener store={store} />)
    act(() => dispatchPointerMove(100, 140))
    expect(store.getState().connectionState?.candidate?.nodeId).toBe(ai)

    // End it and start a NEW connection from the AI node. The candidate set is
    // memoized per connection (keyed on sourceId), so this must recompute:
    // the trigger is not a valid target, so dragging onto it yields no
    // candidate even though the previous connection had one.
    act(() => store.getState().endConnection())
    act(() => store.getState().beginConnection({ sourceId: ai, sourceHandle: null }))
    rerender(<ConnectionPointerListener store={store} />)
    act(() => dispatchPointerMove(0, 40))
    expect(store.getState().connectionState?.candidate).toBeNull()
  })
})

describe("ConnectionLineGhostFactory", () => {
  it("renders a SVG path tipped at the pointer when no candidate", () => {
    const { store } = buildStore()
    const Ghost = ConnectionLineGhostFactory(store)
    const { container } = render(
      <svg>
        <Ghost
          fromX={0}
          fromY={0}
          toX={50}
          toY={50}
          fromNode={null as never}
          fromHandle={null as never}
          fromPosition={"right" as never}
          toNode={null as never}
          toHandle={null as never}
          toPosition={"left" as never}
          pointer={{ x: 50, y: 50 } as never}
          connectionLineType={"default" as never}
          connectionLineStyle={undefined}
          connectionStatus={null as never}
        />
      </svg>
    )
    const g = container.querySelector('[data-testid="connection-line-ghost"]')
    expect(g).not.toBeNull()
    expect(g!.getAttribute("data-candidate")).toBe("")
  })

  it("snaps the path tip to the candidate node's handle position", () => {
    const { store, trigger, ai } = buildStore()
    store.getState().beginConnection({ sourceId: trigger, sourceHandle: null })
    store
      .getState()
      .updateConnectionPointer({ x: 100, y: 140 }, { nodeId: ai, handleId: null, distance: 0 })
    const Ghost = ConnectionLineGhostFactory(store)
    const { container } = render(
      <svg>
        <Ghost
          fromX={0}
          fromY={0}
          toX={50}
          toY={50}
          fromNode={null as never}
          fromHandle={null as never}
          fromPosition={"right" as never}
          toNode={null as never}
          toHandle={null as never}
          toPosition={"left" as never}
          pointer={{ x: 50, y: 50 } as never}
          connectionLineType={"default" as never}
          connectionLineStyle={undefined}
          connectionStatus={null as never}
        />
      </svg>
    )
    const g = container.querySelector('[data-testid="connection-line-ghost"]')!
    expect(g.getAttribute("data-candidate")).toBe(ai)
    const path = g.querySelector("path")!
    // The path should end at the AI input handle (x=100, y=140) — not toX/toY.
    expect(path.getAttribute("d")).toContain("L 100 140")
  })

  it("strips strokeDasharray when tier is reduced", () => {
    const { store } = buildStore()
    store.getState().setPerformanceTier("reduced")
    const Ghost = ConnectionLineGhostFactory(store)
    const { container } = render(
      <svg>
        <Ghost
          fromX={0}
          fromY={0}
          toX={50}
          toY={50}
          fromNode={null as never}
          fromHandle={null as never}
          fromPosition={"right" as never}
          toNode={null as never}
          toHandle={null as never}
          toPosition={"left" as never}
          pointer={{ x: 50, y: 50 } as never}
          connectionLineType={"default" as never}
          connectionLineStyle={undefined}
          connectionStatus={null as never}
        />
      </svg>
    )
    const path = container.querySelector('[data-testid="connection-line-ghost"] path')!
    expect(path.getAttribute("stroke-dasharray")).toBeNull()
  })
})
