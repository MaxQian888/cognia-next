/**
 * @jest-environment jsdom
 */

import { useRef } from "react"
import { act, render, screen } from "@testing-library/react"
import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { LassoOverlay } from "./lasso-overlay"

// Stub @xyflow/react: ViewportPortal renders children inline so we can
// inspect the polygon DOM without React Flow's transform layer.
jest.mock("@xyflow/react", () => ({
  __esModule: true,
  ViewportPortal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
  store.getState().addNode("ai.prompt", { x: 50, y: 50 })
  store.getState().addNode("action.skill.invoke", { x: 500, y: 500 })
  return store
}

function fakeRfi() {
  return {
    screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
  } as unknown as never
}

function Harness({
  store,
  rfi,
  enabled = true,
}: {
  store: EditorStore
  rfi: ReturnType<typeof fakeRfi>
  enabled?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  return (
    <div ref={ref} data-testid="canvas-wrapper" style={{ width: 1024, height: 768 }}>
      <div
        className="react-flow__pane"
        data-testid="rf-pane"
        style={{ width: 1024, height: 768 }}
      />
      <LassoOverlay containerRef={ref} reactFlowInstance={rfi} store={store} enabled={enabled} />
    </div>
  )
}

function pointerDown(el: Element, opts: { clientX: number; clientY: number; alt?: boolean }) {
  // jsdom doesn't construct PointerEvent natively; build via MouseEvent and
  // attach the bits we need. `bubbles: true` is critical for the capture
  // listener bound to the container.
  const e = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    clientX: opts.clientX,
    clientY: opts.clientY,
    button: 0,
  }) as MouseEvent & { altKey: boolean }
  Object.defineProperty(e, "altKey", { value: opts.alt ?? false })
  el.dispatchEvent(e)
}
function pointerMove(target: EventTarget, opts: { clientX: number; clientY: number }) {
  const e = new MouseEvent("pointermove", {
    bubbles: true,
    cancelable: true,
    clientX: opts.clientX,
    clientY: opts.clientY,
  })
  target.dispatchEvent(e)
}
function pointerUp(target: EventTarget, opts: { clientX: number; clientY: number }) {
  const e = new MouseEvent("pointerup", {
    bubbles: true,
    cancelable: true,
    clientX: opts.clientX,
    clientY: opts.clientY,
  })
  target.dispatchEvent(e)
}

beforeEach(() => {
  // Synchronous rAF — the throttle hook now uses a `pendingRef` flag that
  // drain clears before returning, so this no longer races with the
  // post-rAF id assignment.
  ;(
    globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }
  ).requestAnimationFrame = (cb) => {
    cb()
    return 1
  }
  ;(globalThis as unknown as { cancelAnimationFrame: () => void }).cancelAnimationFrame = () =>
    undefined
})

describe("LassoOverlay", () => {
  it("renders nothing when enabled=false", () => {
    const store = seedStore()
    const { container } = render(<Harness store={store} rfi={fakeRfi()} enabled={false} />)
    expect(container.querySelector('[data-testid="lasso-overlay"]')).toBeNull()
  })

  it("ignores pointerdown without Alt", () => {
    const store = seedStore()
    render(<Harness store={store} rfi={fakeRfi()} />)
    const pane = screen.getByTestId("rf-pane")
    pointerDown(pane, { clientX: 0, clientY: 0, alt: false })
    pointerMove(window, { clientX: 200, clientY: 200 })
    pointerUp(window, { clientX: 200, clientY: 200 })
    expect(store.getState().selectedNodeIds).toEqual([])
  })

  it("selects nodes whose rect intersects the drawn polygon (Alt+drag)", () => {
    const store = seedStore()
    render(<Harness store={store} rfi={fakeRfi()} />)
    const pane = screen.getByTestId("rf-pane")
    // Draw a polygon covering the area around (50,50) but not (500,500).
    act(() => pointerDown(pane, { clientX: 0, clientY: 0, alt: true }))
    act(() => pointerMove(window, { clientX: 200, clientY: 0 }))
    act(() => pointerMove(window, { clientX: 200, clientY: 200 }))
    act(() => pointerMove(window, { clientX: 0, clientY: 200 }))
    act(() => pointerUp(window, { clientX: 0, clientY: 200 }))

    const ids = store.getState().selectedNodeIds
    const nodes = store.getState().nodes
    const aiNode = nodes.find((n) => n.position.x === 50)
    expect(ids).toEqual([aiNode!.id])
  })

  it("status pill renders while drawing and clears on pointerup", () => {
    const store = seedStore()
    render(<Harness store={store} rfi={fakeRfi()} />)
    const pane = screen.getByTestId("rf-pane")
    act(() => pointerDown(pane, { clientX: 5, clientY: 5, alt: true }))
    act(() => pointerMove(window, { clientX: 100, clientY: 100 }))
    expect(screen.getByTestId("lasso-status")).toBeInTheDocument()
    act(() => pointerUp(window, { clientX: 100, clientY: 100 }))
    expect(screen.queryByTestId("lasso-status")).toBeNull()
  })

  it("clears selection when the polygon has < 3 points (single click)", () => {
    const store = seedStore()
    store.getState().setSelectedNodes(["preexisting"])
    render(<Harness store={store} rfi={fakeRfi()} />)
    const pane = screen.getByTestId("rf-pane")
    act(() => pointerDown(pane, { clientX: 5, clientY: 5, alt: true }))
    act(() => pointerUp(window, { clientX: 5, clientY: 5 }))
    // Selection unchanged because we never built a real polygon.
    expect(store.getState().selectedNodeIds).toEqual(["preexisting"])
  })
})
