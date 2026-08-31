/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { fireEvent, render, screen } from "@testing-library/react"

import { createEditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

// Stub React Flow — we only verify the mobile-canvas wires touch props +
// tap handlers; the real surface needs a layout engine jsdom doesn't provide.
jest.mock("@xyflow/react", () => {
  const React = jest.requireActual("react") as typeof import("react")
  // Fake instance handed to onInit so the uncontrolled-camera sync effect has
  // something to read/write; exposed to tests as `__mockRf`.
  const mockRf = {
    setViewport: jest.fn(),
    getViewport: jest.fn(() => ({ x: 0, y: 0, zoom: 1 })),
  }
  const propsRef: { current: Record<string, unknown> | null } = { current: null }
  function ReactFlow({
    children,
    onInit,
    onNodeClick,
    onEdgeClick,
    onPaneClick,
    nodesDraggable,
    elementsSelectable,
    nodesConnectable,
    panOnScroll,
    selectionOnDrag,
    ...rest
  }: Record<string, unknown> & { children?: React.ReactNode }) {
    propsRef.current = { nodesDraggable, panOnScroll, selectionOnDrag, ...rest }
    React.useEffect(() => {
      ;(onInit as ((rf: unknown) => void) | undefined)?.(mockRf)
    }, [onInit])
    return (
      <div
        data-testid="rf"
        data-draggable={String(nodesDraggable)}
        data-selectable={String(elementsSelectable)}
        data-connectable={String(nodesConnectable)}
        data-panonscroll={String(panOnScroll)}
        data-selectiondrag={String(selectionOnDrag)}
      >
        <button
          data-testid="rf-node"
          onClick={(e) =>
            (onNodeClick as (e: unknown, n: { id: string }) => void)?.(e, { id: "n1" })
          }
        >
          node
        </button>
        <button
          data-testid="rf-edge"
          onClick={(e) =>
            (onEdgeClick as (e: unknown, ed: { id: string }) => void)?.(e, { id: "e1" })
          }
        >
          edge
        </button>
        <button data-testid="rf-pane" onClick={() => (onPaneClick as () => void)?.()}>
          pane
        </button>
        {children}
      </div>
    )
  }
  return {
    __mockRf: mockRf,
    __propsRef: propsRef,
    ReactFlow,
    Background: () => <div data-testid="rf-bg" />,
    BackgroundVariant: { Dots: "dots", Lines: "lines" },
    applyNodeChanges: (_c: unknown, n: unknown) => n,
    applyEdgeChanges: (_c: unknown, e: unknown) => e,
  }
})

jest.mock("@/lib/workflow/runtime/run-status-bridge", () => ({ useRunStatusBridge: () => {} }))
jest.mock("@/lib/workflow/runtime/last-run-summary", () => ({ useLastRunSummaryByStep: () => ({}) }))
jest.mock("@/hooks/workflow/use-effective-perf-tier", () => ({
  useEffectivePerfTier: () => ({ flags: { cullingThreshold: 100 }, effective: "high" }),
}))
jest.mock("@/components/workflow/editor/nodes/workflow-node", () => ({
  WorkflowNodeComponent: () => null,
}))
jest.mock("@/components/workflow/editor/edges/smart-edge", () => ({ SmartEdge: () => null }))
jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))

const lockMock = jest.fn(async (..._a: unknown[]) => ({ kind: "ok" as const }))
const unlockMock = jest.fn(async (..._a: unknown[]) => ({ kind: "ok" as const }))
jest.mock("@/lib/capacitor/screen-orientation", () => ({
  lock: (...a: unknown[]) => lockMock(...a),
  unlock: (...a: unknown[]) => unlockMock(...a),
}))

import { MobileCanvas } from "./mobile-canvas"

function buildWorkflow(): VisualWorkflow {
  return {
    id: "wf_c",
    schemaVersion: 1,
    name: "Canvas",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "n1",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "N1", params: {} },
      },
    ],
    edges: [],
    settings: {
      errorPolicy: "stop",
      timeoutMs: 60_000,
      concurrency: 1,
      retryDefaults: { attempts: 3, backoff: "exponential", baseMs: 1000 },
    },
  }
}

function renderCanvas(mode: "read" | "edit", connectActive = false, orientationLocked = true) {
  const store = createEditorStore(buildWorkflow())
  const onNodeTap = jest.fn()
  const onEdgeTap = jest.fn()
  const onPaneTap = jest.fn()
  const onLongPress = jest.fn()
  const onInit = jest.fn()
  render(
    <MobileCanvas
      store={store}
      mode={mode}
      connectActive={connectActive}
      onNodeTap={onNodeTap}
      onEdgeTap={onEdgeTap}
      onPaneTap={onPaneTap}
      onLongPress={onLongPress}
      orientationLocked={orientationLocked}
      onInit={onInit}
    />
  )
  return { store, onNodeTap, onEdgeTap, onPaneTap, onLongPress, onInit }
}

function getMockRf() {
  return (
    jest.requireMock("@xyflow/react") as {
      __mockRf: { setViewport: jest.Mock; getViewport: jest.Mock }
    }
  ).__mockRf
}

describe("<MobileCanvas />", () => {
  beforeEach(() => {
    const rf = getMockRf()
    rf.getViewport.mockImplementation(() => ({ x: 0, y: 0, zoom: 1 }))
    rf.setViewport.mockClear()
  })

  it("locks landscape on mount and restores orientation on unmount", () => {
    lockMock.mockClear()
    unlockMock.mockClear()
    const store = createEditorStore(buildWorkflow())
    const { unmount } = render(
      <MobileCanvas
        store={store}
        mode="read"
        connectActive={false}
        onNodeTap={jest.fn()}
        onEdgeTap={jest.fn()}
        onPaneTap={jest.fn()}
        onLongPress={jest.fn()}
        orientationLocked={true}
        onInit={jest.fn()}
      />
    )
    expect(lockMock).toHaveBeenCalledWith("landscape")
    unmount()
    expect(unlockMock).toHaveBeenCalled()
  })

  it("locks structural interaction in read mode", () => {
    renderCanvas("read")
    const rf = screen.getByTestId("rf")
    expect(rf).toHaveAttribute("data-draggable", "false")
    expect(rf).toHaveAttribute("data-selectable", "false")
  })

  it("enables node dragging in edit mode but keeps handle-connect off", () => {
    renderCanvas("edit")
    const rf = screen.getByTestId("rf")
    expect(rf).toHaveAttribute("data-draggable", "true")
    expect(rf).toHaveAttribute("data-selectable", "true")
    expect(rf).toHaveAttribute("data-connectable", "false")
  })

  it("uses touch-first viewport props (no scroll-pan, no marquee select)", () => {
    renderCanvas("read")
    const rf = screen.getByTestId("rf")
    expect(rf).toHaveAttribute("data-panonscroll", "false")
    expect(rf).toHaveAttribute("data-selectiondrag", "false")
  })

  it("routes a node tap to onNodeTap", () => {
    const { onNodeTap } = renderCanvas("read")
    fireEvent.click(screen.getByTestId("rf-node"))
    expect(onNodeTap).toHaveBeenCalledWith("n1")
  })

  it("routes a pane tap to onPaneTap", () => {
    const { onPaneTap } = renderCanvas("read")
    fireEvent.click(screen.getByTestId("rf-pane"))
    expect(onPaneTap).toHaveBeenCalledTimes(1)
  })

  it("routes an edge tap to onEdgeTap", () => {
    const { onEdgeTap } = renderCanvas("edit")
    fireEvent.click(screen.getByTestId("rf-edge"))
    expect(onEdgeTap).toHaveBeenCalledWith("e1")
  })

  it("scopes the touch handle-enlarge CSS via the wf-touch-canvas class", () => {
    renderCanvas("edit")
    expect(screen.getByTestId("mobile-canvas")).toHaveClass("wf-touch-canvas")
  })

  it("names the rooted output in the connect banner (error path)", () => {
    const store = createEditorStore(buildWorkflow())
    store.getState().beginConnection({ sourceId: "n1", sourceHandle: "error" })
    render(
      <MobileCanvas
        store={store}
        mode="edit"
        connectActive
        onNodeTap={jest.fn()}
        onEdgeTap={jest.fn()}
        onPaneTap={jest.fn()}
        onLongPress={jest.fn()}
        orientationLocked={true}
        onInit={jest.fn()}
      />
    )
    // The mock t() echoes the key, so the named-source branch shows "connectFrom"
    // while the generic prompt would show "connectTarget".
    expect(screen.getByTestId("mobile-connect-banner")).toHaveTextContent("connectFrom")
  })

  it("resolves a decision output label for the connect banner", () => {
    const wf = buildWorkflow()
    wf.nodes.push({
      id: "b1",
      type: "flow.branch",
      typeVersion: 2,
      position: { x: 300, y: 0 },
      data: { label: "Branch", params: {} },
    })
    const store = createEditorStore(wf)
    store.getState().beginConnection({ sourceId: "b1", sourceHandle: "true" })
    render(
      <MobileCanvas
        store={store}
        mode="edit"
        connectActive
        onNodeTap={jest.fn()}
        onEdgeTap={jest.fn()}
        onPaneTap={jest.fn()}
        onLongPress={jest.fn()}
        orientationLocked={true}
        onInit={jest.fn()}
      />
    )
    expect(screen.getByTestId("mobile-connect-banner")).toHaveTextContent("connectFrom")
  })

  it("falls back to the generic prompt for an unresolved source handle", () => {
    const store = createEditorStore(buildWorkflow())
    // n1 is a single-output node — no decision handle named "ghost".
    store.getState().beginConnection({ sourceId: "n1", sourceHandle: "ghost" })
    render(
      <MobileCanvas
        store={store}
        mode="edit"
        connectActive
        onNodeTap={jest.fn()}
        onEdgeTap={jest.fn()}
        onPaneTap={jest.fn()}
        onLongPress={jest.fn()}
        orientationLocked={true}
        onInit={jest.fn()}
      />
    )
    expect(screen.getByTestId("mobile-connect-banner")).toHaveTextContent("connectTarget")
  })

  it("shows the connect-target banner while connecting", () => {
    renderCanvas("edit", true)
    expect(screen.getByTestId("mobile-connect-banner")).toBeInTheDocument()
  })

  it("hides the connect-target banner when not connecting", () => {
    renderCanvas("edit", false)
    expect(screen.queryByTestId("mobile-connect-banner")).toBeNull()
  })

  // ── Uncontrolled camera (regression: canvas must follow pan/pinch) ────────
  // Passing the store viewport as the controlled `viewport` prop without an
  // onViewportChange round-trip froze the camera during gestures.

  it("seeds the camera via defaultViewport and never passes the controlled viewport prop", () => {
    renderCanvas("read")
    const { __propsRef } = jest.requireMock("@xyflow/react") as {
      __propsRef: { current: Record<string, unknown> | null }
    }
    expect(__propsRef.current?.defaultViewport).toEqual({ x: 0, y: 0, zoom: 1 })
    expect(__propsRef.current?.viewport).toBeUndefined()
  })

  it("forwards the instance to onInit and pushes wholesale viewport replaces imperatively", () => {
    const { store, onInit } = renderCanvas("edit")
    const rf = getMockRf()
    expect(onInit).toHaveBeenCalledWith(rf)
    rf.setViewport.mockClear()
    const { act } = jest.requireActual("@testing-library/react") as typeof import("@testing-library/react")
    act(() => store.getState().setViewport({ x: 12, y: 34, zoom: 1.25 }))
    expect(rf.setViewport).toHaveBeenCalledWith({ x: 12, y: 34, zoom: 1.25 })
  })

  it("skips the camera write when the store value already matches the live camera", () => {
    const { store } = renderCanvas("edit")
    const rf = getMockRf()
    rf.getViewport.mockReturnValue({ x: 5, y: 6, zoom: 1 })
    rf.setViewport.mockClear()
    const { act } = jest.requireActual("@testing-library/react") as typeof import("@testing-library/react")
    act(() => store.getState().setViewport({ x: 5, y: 6, zoom: 1 }))
    expect(rf.setViewport).not.toHaveBeenCalled()
  })

  it("registers the container renderers, not just the plain card", () => {
    // `react-flow-converter` assigns `loopContainer` / `groupContainer` to
    // `flow.loop@2` and `annotation.group@2`, so registering only
    // `workflowNode` meant a desktop-authored graph opened on a phone with its
    // loop bodies and group frames falling through to React Flow's default.
    renderCanvas("read")
    const { __propsRef } = jest.requireMock("@xyflow/react") as {
      __propsRef: { current: Record<string, unknown> | null }
    }
    const types = Object.keys((__propsRef.current?.nodeTypes as Record<string, unknown>) ?? {})
    expect(types).toEqual(expect.arrayContaining(["workflowNode", "loopContainer", "groupContainer"]))
  })

  it("leaves the orientation alone once the user opts out of the lock", () => {
    lockMock.mockClear()
    unlockMock.mockClear()
    renderCanvas("read", false, false)
    expect(lockMock).not.toHaveBeenCalled()
    expect(unlockMock).toHaveBeenCalled()
  })
})
