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
jest.mock("@xyflow/react", () => ({
  ReactFlow: ({
    children,
    onNodeClick,
    onPaneClick,
    nodesDraggable,
    elementsSelectable,
    nodesConnectable,
    panOnScroll,
    selectionOnDrag,
  }: Record<string, unknown> & { children?: React.ReactNode }) => (
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
        onClick={(e) => (onNodeClick as (e: unknown, n: { id: string }) => void)?.(e, { id: "n1" })}
      >
        node
      </button>
      <button data-testid="rf-pane" onClick={() => (onPaneClick as () => void)?.()}>
        pane
      </button>
      {children}
    </div>
  ),
  Background: () => <div data-testid="rf-bg" />,
  BackgroundVariant: { Dots: "dots", Lines: "lines" },
  applyNodeChanges: (_c: unknown, n: unknown) => n,
  applyEdgeChanges: (_c: unknown, e: unknown) => e,
}))

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

function renderCanvas(mode: "read" | "edit", connectActive = false) {
  const store = createEditorStore(buildWorkflow())
  const onNodeTap = jest.fn()
  const onPaneTap = jest.fn()
  render(
    <MobileCanvas
      store={store}
      mode={mode}
      connectActive={connectActive}
      onNodeTap={onNodeTap}
      onPaneTap={onPaneTap}
      onInit={() => {}}
    />
  )
  return { onNodeTap, onPaneTap }
}

describe("<MobileCanvas />", () => {
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

  it("shows the connect-target banner while connecting", () => {
    renderCanvas("edit", true)
    expect(screen.getByTestId("mobile-connect-banner")).toBeInTheDocument()
  })

  it("hides the connect-target banner when not connecting", () => {
    renderCanvas("edit", false)
    expect(screen.queryByTestId("mobile-connect-banner")).toBeNull()
  })
})
