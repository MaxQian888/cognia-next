/**
 * @jest-environment jsdom
 */

import { act, render, screen, fireEvent } from "@testing-library/react"

// `useOnViewportChange` from @xyflow/react requires a `<ReactFlowProvider>`
// at runtime. The breadcrumb is rendered standalone in these tests (we only
// want to assert on its DOM), so stub the hook out and expose the registered
// callback through a test-scoped ref so individual tests can simulate a live
// viewport change when needed.
const lastViewportChangeRef: {
  current: ((vp: { x: number; y: number; zoom: number }) => void) | null
} = { current: null }
jest.mock("@xyflow/react", () => ({
  __esModule: true,
  useOnViewportChange: ({
    onChange,
  }: {
    onChange: (vp: { x: number; y: number; zoom: number }) => void
  }) => {
    lastViewportChangeRef.current = onChange
  },
}))

import { createEditorStore, type EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"
import { ViewportBreadcrumb } from "./viewport-breadcrumb"

function makeWorkflow(): VisualWorkflow {
  return {
    id: "wf_test",
    schemaVersion: 1,
    name: "My workflow",
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

function flushRaf() {
  // The breadcrumb uses our rAF throttle. Drive any pending frame manually.
  const cb = (globalThis as unknown as { __nextRaf?: () => void }).__nextRaf
  if (cb) {
    ;(globalThis as unknown as { __nextRaf?: () => void }).__nextRaf = undefined
    cb()
  }
}

function installRafShim() {
  ;(
    globalThis as unknown as { requestAnimationFrame: (cb: () => void) => number }
  ).requestAnimationFrame = (cb) => {
    ;(globalThis as unknown as { __nextRaf?: () => void }).__nextRaf = cb
    return 1
  }
  ;(globalThis as unknown as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame =
    () => {
      ;(globalThis as unknown as { __nextRaf?: () => void }).__nextRaf = undefined
    }
}

function buildStoreWithGroup(): EditorStore {
  const store = createEditorStore(makeWorkflow())
  // Place a group around screen-centre flow coords. window.innerWidth/Height in
  // jsdom default to 1024×768 → centre flow-space at (512, 384) with the
  // default viewport (x=0,y=0,zoom=1). Use a group rect that includes that
  // point.
  store.getState().addNode(
    "annotation.group",
    { x: 400, y: 300 },
    {
      label: "Group A",
      params: { title: "Group A", width: 240, height: 160 },
    }
  )
  return store
}

describe("ViewportBreadcrumb", () => {
  beforeEach(() => {
    installRafShim()
    lastViewportChangeRef.current = null
    // jsdom defaults: 1024 × 768.
    Object.defineProperty(window, "innerWidth", { value: 1024, configurable: true })
    Object.defineProperty(window, "innerHeight", { value: 768, configurable: true })
  })

  it("renders the workflow name as the root segment", () => {
    const store = createEditorStore(makeWorkflow())
    render(<ViewportBreadcrumb store={store} reactFlowInstance={null} />)
    expect(screen.getByTestId("viewport-breadcrumb-root").textContent).toBe("My workflow")
  })

  it("shows the active group when the viewport centre is inside a group rect", () => {
    const store = buildStoreWithGroup()
    render(<ViewportBreadcrumb store={store} reactFlowInstance={null} />)
    act(() => flushRaf())
    const group = screen.getByTestId("viewport-breadcrumb-group")
    expect(group.textContent).toBe("Group A")
  })

  it("hides the group segment when no group contains the viewport centre", () => {
    const store = createEditorStore(makeWorkflow())
    render(<ViewportBreadcrumb store={store} reactFlowInstance={null} />)
    act(() => flushRaf())
    expect(screen.queryByTestId("viewport-breadcrumb-group")).toBeNull()
  })

  it("clicking the root invokes fitView on the React Flow instance", () => {
    const store = createEditorStore(makeWorkflow())
    const fitView = jest.fn()
    const setCenter = jest.fn()
    render(
      <ViewportBreadcrumb
        store={store}
        reactFlowInstance={{ fitView, setCenter } as unknown as never}
      />
    )
    fireEvent.click(screen.getByTestId("viewport-breadcrumb-root"))
    expect(fitView).toHaveBeenCalled()
    expect(fitView.mock.calls[0][0]).toMatchObject({ duration: 240, padding: 0.2 })
  })

  it("updates the active group when useOnViewportChange fires (live pan/zoom)", () => {
    const store = buildStoreWithGroup()
    render(<ViewportBreadcrumb store={store} reactFlowInstance={null} />)
    act(() => flushRaf())
    expect(screen.getByTestId("viewport-breadcrumb-group").textContent).toBe("Group A")

    // Pan the viewport so the screen-centre flow point lands outside the
    // group rect. With window 1024×768 and zoom=1, shifting viewport.x by
    // 800 moves the flow-space centre from x=512 → x=-288 (well left of the
    // group at x=[400,640]).
    expect(typeof lastViewportChangeRef.current).toBe("function")
    act(() => {
      lastViewportChangeRef.current?.({ x: 800, y: 0, zoom: 1 })
    })
    act(() => flushRaf())
    expect(screen.queryByTestId("viewport-breadcrumb-group")).toBeNull()
  })

  it("clicking the group segment focuses the group via setCenter", () => {
    const store = buildStoreWithGroup()
    const fitView = jest.fn()
    const setCenter = jest.fn()
    render(
      <ViewportBreadcrumb
        store={store}
        reactFlowInstance={{ fitView, setCenter } as unknown as never}
      />
    )
    act(() => flushRaf())
    fireEvent.click(screen.getByTestId("viewport-breadcrumb-group"))
    expect(setCenter).toHaveBeenCalled()
    const [cx, cy] = setCenter.mock.calls[0]
    expect(cx).toBe(520) // 400 + 240/2
    expect(cy).toBe(380) // 300 + 160/2
  })
})
