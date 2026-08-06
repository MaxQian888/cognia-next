/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TooltipProvider } from "@/components/ui/tooltip"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { CanvasToolbar, type CanvasToolbarProps } from "./canvas-toolbar"

const mockRf = {
  zoomIn: jest.fn(),
  zoomOut: jest.fn(),
  zoomTo: jest.fn(),
  fitView: jest.fn(),
  getViewport: jest.fn(() => ({ x: 0, y: 0, zoom: 1.5 })),
}

jest.mock("@xyflow/react", () => ({
  __esModule: true,
  Controls: ({ children, ...props }: React.ComponentProps<"div">) => (
    <div {...props}>{children}</div>
  ),
  useReactFlow: () => mockRf,
  useOnViewportChange: () => undefined,
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  jest.clearAllMocks()
})

function makeProps(overrides: Partial<CanvasToolbarProps> = {}): CanvasToolbarProps {
  return {
    onAddNode: jest.fn(),
    onOpenSearch: jest.fn(),
    onAddSticky: jest.fn(),
    onAddGroup: jest.fn(),
    onUndo: jest.fn(),
    onRedo: jest.fn(),
    canUndo: true,
    canRedo: true,
    onAutoLayout: jest.fn(),
    interactive: true,
    onToggleInteractive: jest.fn(),
    snapToGrid: true,
    onToggleSnap: jest.fn(),
    minimapVisible: true,
    minimapAvailable: true,
    onToggleMinimap: jest.fn(),
    backgroundVariant: "dots",
    onBackgroundChange: jest.fn(),
    motionEnabled: true,
    performanceTier: "auto",
    effectivePerformanceTier: "high",
    onPerformanceTierChange: jest.fn(),
    workflowId: "wf_a",
    currentViewport: { x: 0, y: 0, zoom: 1.5 },
    onRestoreViewport: jest.fn(),
    ...overrides,
  }
}

function renderToolbar(overrides: Partial<CanvasToolbarProps> = {}) {
  const props = makeProps(overrides)
  const utils = render(
    <TooltipProvider>
      <CanvasToolbar {...props} />
    </TooltipProvider>
  )
  return { ...utils, props }
}

describe("CanvasToolbar", () => {
  it("renders the capsule with every core control", () => {
    renderToolbar()
    expect(screen.getByTestId("wf-canvas-toolbar")).toBeInTheDocument()
    for (const id of [
      "wf-add-node",
      "workflow-undo",
      "workflow-redo",
      "wf-zoom-out",
      "wf-zoom-reset",
      "wf-zoom-in",
      "wf-fit-view",
      "wf-lock",
      "workflow-auto-layout",
      "wf-view-options",
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument()
    }
  })

  it("seeds the zoom readout from the current viewport", () => {
    renderToolbar()
    expect(screen.getByTestId("wf-zoom-reset").textContent).toBe("150%")
  })

  it("drives zoom in / out / fit through the React Flow instance", () => {
    renderToolbar()
    fireEvent.click(screen.getByTestId("wf-zoom-in"))
    fireEvent.click(screen.getByTestId("wf-zoom-out"))
    fireEvent.click(screen.getByTestId("wf-fit-view"))
    expect(mockRf.zoomIn).toHaveBeenCalledTimes(1)
    expect(mockRf.zoomOut).toHaveBeenCalledTimes(1)
    expect(mockRf.fitView).toHaveBeenCalledTimes(1)
  })

  it("resets zoom to 100% when the readout is clicked", () => {
    renderToolbar()
    fireEvent.click(screen.getByTestId("wf-zoom-reset"))
    expect(mockRf.zoomTo).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 200 }))
  })

  it("uses a zero transition duration when motion is disabled", () => {
    renderToolbar({ motionEnabled: false })
    fireEvent.click(screen.getByTestId("wf-zoom-reset"))
    expect(mockRf.zoomTo).toHaveBeenCalledWith(1, expect.objectContaining({ duration: 0 }))
  })

  it("fires add-node, auto-layout, and interactivity callbacks", () => {
    const { props } = renderToolbar()
    fireEvent.click(screen.getByTestId("wf-add-node"))
    fireEvent.click(screen.getByTestId("workflow-auto-layout"))
    fireEvent.click(screen.getByTestId("wf-lock"))
    expect(props.onAddNode).toHaveBeenCalledTimes(1)
    expect(props.onAutoLayout).toHaveBeenCalledTimes(1)
    expect(props.onToggleInteractive).toHaveBeenCalledTimes(1)
  })

  it("disables undo / redo according to history availability", () => {
    const { props } = renderToolbar({ canUndo: false, canRedo: true })
    expect(screen.getByTestId("workflow-undo")).toBeDisabled()
    fireEvent.click(screen.getByTestId("workflow-redo"))
    expect(props.onRedo).toHaveBeenCalledTimes(1)
  })

  it("marks the lock button pressed when the canvas is locked", () => {
    renderToolbar({ interactive: false })
    expect(screen.getByTestId("wf-lock")).toHaveAttribute("aria-pressed", "true")
  })

  it("toggles snap and background from the View popover", () => {
    const { props } = renderToolbar()
    fireEvent.click(screen.getByTestId("wf-view-options"))
    fireEvent.click(screen.getByTestId("wf-snap-toggle"))
    expect(props.onToggleSnap).toHaveBeenCalledWith(false)
    fireEvent.click(screen.getByTestId("wf-bg-lines"))
    expect(props.onBackgroundChange).toHaveBeenCalledWith("lines")
  })

  it("opens search and adds sticky / group from the annotation menu", async () => {
    const { props } = renderToolbar()
    const user = userEvent.setup()
    fireEvent.click(screen.getByTestId("wf-search"))
    expect(props.onOpenSearch).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId("wf-annotation"))
    fireEvent.click(await screen.findByTestId("wf-add-sticky"))
    expect(props.onAddSticky).toHaveBeenCalledTimes(1)
    await user.click(screen.getByTestId("wf-annotation"))
    fireEvent.click(await screen.findByTestId("wf-add-group"))
    expect(props.onAddGroup).toHaveBeenCalledTimes(1)
  })

  it("disables the minimap toggle when the performance tier hides the minimap", () => {
    renderToolbar({ minimapAvailable: false })
    fireEvent.click(screen.getByTestId("wf-view-options"))
    expect(screen.getByTestId("wf-minimap-toggle")).toBeDisabled()
  })
})
