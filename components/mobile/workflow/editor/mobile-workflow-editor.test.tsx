/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import "@testing-library/jest-dom"
import { fireEvent, render, screen } from "@testing-library/react"

import type { EditorStore } from "@/lib/workflow/editor/store"
import type { VisualWorkflow } from "@/types/workflow/visual"

// Capture the store the editor builds internally so tests can assert on
// store mutations driven through the orchestration.
let capturedStore: EditorStore | null = null
const fitViewMock = jest.fn()

type ChildProps = Record<string, unknown>

jest.mock("./mobile-canvas", () => ({
  MobileCanvas: (props: ChildProps) => {
    capturedStore = props.store as EditorStore
    const onNodeTap = props.onNodeTap as (id: string) => void
    const onEdgeTap = props.onEdgeTap as (id: string) => void
    const onPaneTap = props.onPaneTap as () => void
    const onLongPress = props.onLongPress as (t: { kind: string; id?: string }) => void
    const onInit = props.onInit as (rf: unknown) => void
    return (
      <div data-testid="canvas" data-mode={String(props.mode)} data-connect={String(props.connectActive)}>
        <button data-testid="tap-n1" onClick={() => onNodeTap("n1")}>n1</button>
        <button data-testid="tap-n2" onClick={() => onNodeTap("n2")}>n2</button>
        <button
          data-testid="tap-edge"
          onClick={() => onEdgeTap(capturedStore?.getState().edges[0]?.id ?? "missing")}
        >
          edge
        </button>
        <button data-testid="tap-pane" onClick={() => onPaneTap()}>pane</button>
        <button data-testid="hold-n1" onClick={() => onLongPress({ kind: "node", id: "n1" })}>
          hold n1
        </button>
        <button data-testid="hold-pane" onClick={() => onLongPress({ kind: "pane" })}>
          hold pane
        </button>
        <button
          data-testid="do-init"
          onClick={() => onInit({ screenToFlowPosition: (p: unknown) => p, fitView: fitViewMock })}
        >
          init
        </button>
      </div>
    )
  },
}))

jest.mock("./mobile-editor-topbar", () => ({
  MobileEditorTopbar: (props: ChildProps) => (
    <div data-testid="topbar" data-mode={String(props.mode)}>
      <button data-testid="toggle-mode" onClick={props.onToggleMode as () => void}>
        toggle
      </button>
      <button data-testid="open-copilot" onClick={props.onOpenCopilot as () => void}>
        copilot
      </button>
      <button data-testid="open-workbench" onClick={props.onOpenWorkbench as () => void}>
        workbench
      </button>
      {props.mode !== "read" ? (
        <button
          data-testid="mobile-editor-select-mode"
          onClick={props.onToggleSelectMode as () => void}
        >
          select
        </button>
      ) : null}
    </div>
  ),
}))

jest.mock("@/components/workflow/editor/right-sidebar", () => ({
  RightSidebar: (props: ChildProps) => {
    const drawer = props.drawer as { open: boolean; onOpenChange: (o: boolean) => void }
    return (
      <div
        data-testid="workbench-sidebar"
        data-drawer-open={String(drawer.open)}
        data-placement={String(props.placement)}
      >
        <button data-testid="collapse-workbench" onClick={() => drawer.onOpenChange(false)}>
          collapse
        </button>
      </div>
    )
  },
}))

jest.mock("./mobile-workflow-copilot-sheet", () => ({
  MobileWorkflowCopilotSheet: (props: ChildProps) => (
    <div
      data-testid="copilot-sheet"
      data-open={String(props.open)}
      data-workflow-id={String(props.workflowId)}
    >
      <button
        data-testid="close-copilot"
        onClick={() => (props.onOpenChange as (o: boolean) => void)(false)}
      >
        close
      </button>
    </div>
  ),
}))

jest.mock("./mobile-node-palette-sheet", () => ({
  MobileNodePaletteSheet: (props: ChildProps) =>
    props.open ? (
      <div data-testid="palette">
        <button
          data-testid="add-ai"
          onClick={() => (props.onAdd as (e: { kind: string }) => void)({ kind: "ai.prompt" })}
        >
          add
        </button>
      </div>
    ) : null,
}))

jest.mock("./mobile-node-inspector-drawer", () => ({
  MobileNodeInspectorDrawer: (props: ChildProps) =>
    props.open ? (
      <div data-testid="drawer" data-canconnect={String(props.canConnect)}>
        <button data-testid="start-connect" onClick={props.onStartConnect as () => void}>
          connect
        </button>
        <button
          data-testid="dismiss-drawer"
          onClick={() => (props.onOpenChange as (o: boolean) => void)(false)}
        >
          x
        </button>
      </div>
    ) : null,
}))

jest.mock("next-intl", () => ({ useTranslations: () => (k: string) => k }))

import { TooltipProvider } from "@/components/ui/tooltip"
import { MobileWorkflowEditor } from "./mobile-workflow-editor"

function buildWorkflow(): VisualWorkflow {
  return {
    id: "wf_edit",
    schemaVersion: 1,
    name: "Editor",
    createdAt: 1,
    updatedAt: 1,
    nodes: [
      {
        id: "n1",
        type: "trigger.manual",
        typeVersion: 1,
        position: { x: 0, y: 0 },
        data: { label: "Trigger", params: {} },
      },
      {
        id: "n2",
        type: "ai.prompt",
        typeVersion: 1,
        position: { x: 200, y: 0 },
        data: { label: "AI", params: {} },
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

beforeEach(() => {
  capturedStore = null
  fitViewMock.mockReset()
})

/**
 * `TooltipProvider` is mounted once in `app/layout.tsx`, so every surface gets
 * it for free in production. The selection toolbar the select sub-mode shows
 * uses `Tooltip`, so a bare render here would throw where the app does not.
 */
function renderEditor() {
  return render(
    <TooltipProvider>
      <MobileWorkflowEditor workflow={buildWorkflow()} />
    </TooltipProvider>
  )
}

describe("<MobileWorkflowEditor />", () => {
  it("defaults to read mode with the FAB hidden", () => {
    renderEditor()
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-mode", "read")
    expect(screen.queryByTestId("mobile-editor-fab")).toBeNull()
  })

  it("reveals the add-node FAB after switching to edit mode", () => {
    renderEditor()
    fireEvent.click(screen.getByTestId("toggle-mode"))
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-mode", "edit")
    expect(screen.getByTestId("mobile-editor-fab")).toBeInTheDocument()
  })

  it("opens the copilot sheet from the topbar and passes the workflow id", () => {
    renderEditor()
    expect(screen.getByTestId("copilot-sheet")).toHaveAttribute("data-open", "false")
    expect(screen.getByTestId("copilot-sheet")).toHaveAttribute("data-workflow-id", "wf_edit")
    fireEvent.click(screen.getByTestId("open-copilot"))
    expect(screen.getByTestId("copilot-sheet")).toHaveAttribute("data-open", "true")
    fireEvent.click(screen.getByTestId("close-copilot"))
    expect(screen.getByTestId("copilot-sheet")).toHaveAttribute("data-open", "false")
  })

  it("opens the workbench through the shared Context Workbench drawer", () => {
    // The editor used to wrap the column form of `RightSidebar` in its own
    // right-edge `<Sheet>`, which is how it became the one Context Workbench
    // host without the drawer's snap points, back-dismiss and keyboard inset.
    // The host now hands the drawer its open state and owns nothing else.
    renderEditor()
    const sidebar = screen.getByTestId("workbench-sidebar")
    expect(sidebar).toHaveAttribute("data-drawer-open", "false")
    fireEvent.click(screen.getByTestId("open-workbench"))
    expect(screen.getByTestId("workbench-sidebar")).toHaveAttribute("data-drawer-open", "true")
    fireEvent.click(screen.getByTestId("collapse-workbench"))
    expect(screen.getByTestId("workbench-sidebar")).toHaveAttribute("data-drawer-open", "false")
  })

  it("opens the inspector drawer when a node is tapped", () => {
    renderEditor()
    fireEvent.click(screen.getByTestId("tap-n1"))
    expect(screen.getByTestId("drawer")).toBeInTheDocument()
    expect(capturedStore?.getState().selectedNodeIds).toEqual(["n1"])
  })

  it("creates an edge through the tap-to-connect flow", () => {
    renderEditor()
    fireEvent.click(screen.getByTestId("toggle-mode")) // edit
    fireEvent.click(screen.getByTestId("tap-n1")) // select + open drawer
    expect(screen.getByTestId("drawer")).toHaveAttribute("data-canconnect", "true")
    fireEvent.click(screen.getByTestId("start-connect")) // enter connect mode, close drawer
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-connect", "true")
    fireEvent.click(screen.getByTestId("tap-n2")) // complete connection
    const edges = capturedStore?.getState().edges ?? []
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ source: "n1", target: "n2" })
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-connect", "false")
  })

  it("adds a node from the palette at the viewport center", () => {
    renderEditor()
    fireEvent.click(screen.getByTestId("do-init")) // provide a React Flow instance
    fireEvent.click(screen.getByTestId("toggle-mode")) // edit → FAB
    fireEvent.click(screen.getByTestId("mobile-editor-fab")) // open palette
    fireEvent.click(screen.getByTestId("add-ai"))
    expect(capturedStore?.getState().nodes).toHaveLength(3)
    expect(screen.getByTestId("drawer")).toBeInTheDocument()
  })

  it("recenters the canvas via the fit-view button (available in read mode)", () => {
    renderEditor()
    // Recenter is available without entering edit mode.
    expect(screen.getByTestId("mobile-editor-recenter")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("do-init"))
    fireEvent.click(screen.getByTestId("mobile-editor-recenter"))
    expect(fitViewMock).toHaveBeenCalled()
  })

  it("clears selection and closes the inspector on a pane tap", () => {
    renderEditor()
    fireEvent.click(screen.getByTestId("tap-n1"))
    expect(screen.getByTestId("drawer")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("tap-pane"))
    expect(screen.queryByTestId("drawer")).toBeNull()
    expect(capturedStore?.getState().selectedNodeIds).toEqual([])
  })

  it("arms the shared renderer's tap-to-connect only in edit mode", () => {
    renderEditor()
    // Read mode (default) leaves the handle-tap entry disabled.
    expect(capturedStore?.getState().touchConnect).toBe(false)
    fireEvent.click(screen.getByTestId("toggle-mode")) // → edit
    expect(capturedStore?.getState().touchConnect).toBe(true)
    fireEvent.click(screen.getByTestId("toggle-mode")) // → read
    expect(capturedStore?.getState().touchConnect).toBe(false)
  })

  it("selects an edge on tap and deletes it via the floating bar", () => {
    renderEditor()
    fireEvent.click(screen.getByTestId("toggle-mode")) // edit
    // Build an edge to act on.
    fireEvent.click(screen.getByTestId("tap-n1"))
    fireEvent.click(screen.getByTestId("start-connect"))
    fireEvent.click(screen.getByTestId("tap-n2"))
    expect(capturedStore?.getState().edges).toHaveLength(1)
    const edgeId = capturedStore!.getState().edges[0].id
    // No delete bar until an edge is selected.
    expect(screen.queryByTestId("mobile-edge-delete")).toBeNull()
    fireEvent.click(screen.getByTestId("tap-edge"))
    expect(capturedStore?.getState().selectedEdgeIds).toEqual([edgeId])
    fireEvent.click(screen.getByTestId("mobile-edge-delete"))
    expect(capturedStore?.getState().edges).toHaveLength(0)
  })

  it("does not select edges in read mode", () => {
    renderEditor()
    // Seed an edge directly, then tap it in read mode.
    capturedStore!.getState().connect({ source: "n1", target: "n2" })
    fireEvent.click(screen.getByTestId("tap-edge"))
    expect(capturedStore?.getState().selectedEdgeIds).toEqual([])
    expect(screen.queryByTestId("mobile-edge-delete")).toBeNull()
  })

  it("opens the action sheet on a long press and deletes the held node", () => {
    // A phone could only delete a node by opening its inspector and finding
    // the button. Every other destructive gesture in this app is a long press.
    renderEditor()
    fireEvent.click(screen.getByTestId("toggle-mode"))
    fireEvent.click(screen.getByTestId("hold-n1"))
    expect(screen.getByTestId("mobile-canvas-actions")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("mobile-canvas-action-delete"))
    expect(capturedStore?.getState().nodes.some((n) => n.id === "n1")).toBe(false)
  })

  it("duplicates the held node and selects the copy", () => {
    renderEditor()
    fireEvent.click(screen.getByTestId("toggle-mode"))
    const before = capturedStore!.getState().nodes.length
    fireEvent.click(screen.getByTestId("hold-n1"))
    fireEvent.click(screen.getByTestId("mobile-canvas-action-duplicate"))
    const after = capturedStore!.getState()
    expect(after.nodes.length).toBe(before + 1)
    expect(after.selectedNodeIds).toHaveLength(1)
    expect(after.selectedNodeIds[0]).not.toBe("n1")
  })

  it("offers the canvas actions when the press landed on empty space", () => {
    renderEditor()
    fireEvent.click(screen.getByTestId("toggle-mode"))
    fireEvent.click(screen.getByTestId("hold-pane"))
    expect(screen.getByTestId("mobile-canvas-action-addNode")).toBeInTheDocument()
    expect(screen.queryByTestId("mobile-canvas-action-delete")).toBeNull()
  })

  it("adds to the selection instead of opening the inspector while selecting", () => {
    // Make's touchscreen mode is the only formally-specified one in this class
    // of product, and marquee select was the part this canvas lacked.
    renderEditor()
    fireEvent.click(screen.getByTestId("toggle-mode"))
    fireEvent.click(screen.getByTestId("mobile-editor-select-mode"))
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-mode", "select")

    fireEvent.click(screen.getByTestId("tap-n1"))
    fireEvent.click(screen.getByTestId("tap-n2"))
    expect(capturedStore?.getState().selectedNodeIds).toEqual(["n1", "n2"])
    expect(screen.queryByTestId("drawer")).toBeNull()
    // Tapping an already-selected node takes it back out.
    fireEvent.click(screen.getByTestId("tap-n1"))
    expect(capturedStore?.getState().selectedNodeIds).toEqual(["n2"])
  })

  it("offers the select sub-mode only once editing", () => {
    renderEditor()
    expect(screen.queryByTestId("mobile-editor-select-mode")).toBeNull()
    fireEvent.click(screen.getByTestId("toggle-mode"))
    expect(screen.getByTestId("mobile-editor-select-mode")).toBeInTheDocument()
  })

  it("drops the selection when leaving edit mode entirely", () => {
    renderEditor()
    fireEvent.click(screen.getByTestId("toggle-mode"))
    fireEvent.click(screen.getByTestId("mobile-editor-select-mode"))
    fireEvent.click(screen.getByTestId("tap-n1"))
    expect(capturedStore?.getState().selectedNodeIds).toEqual(["n1"])
    fireEvent.click(screen.getByTestId("mobile-editor-select-mode"))
    fireEvent.click(screen.getByTestId("toggle-mode"))
    expect(capturedStore?.getState().selectedNodeIds).toEqual([])
  })
})
