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
    const onPaneTap = props.onPaneTap as () => void
    const onInit = props.onInit as (rf: unknown) => void
    return (
      <div data-testid="canvas" data-mode={String(props.mode)} data-connect={String(props.connectActive)}>
        <button data-testid="tap-n1" onClick={() => onNodeTap("n1")}>n1</button>
        <button data-testid="tap-n2" onClick={() => onNodeTap("n2")}>n2</button>
        <button data-testid="tap-pane" onClick={() => onPaneTap()}>pane</button>
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

describe("<MobileWorkflowEditor />", () => {
  it("defaults to read mode with the FAB hidden", () => {
    render(<MobileWorkflowEditor workflow={buildWorkflow()} />)
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-mode", "read")
    expect(screen.queryByTestId("mobile-editor-fab")).toBeNull()
  })

  it("reveals the add-node FAB after switching to edit mode", () => {
    render(<MobileWorkflowEditor workflow={buildWorkflow()} />)
    fireEvent.click(screen.getByTestId("toggle-mode"))
    expect(screen.getByTestId("canvas")).toHaveAttribute("data-mode", "edit")
    expect(screen.getByTestId("mobile-editor-fab")).toBeInTheDocument()
  })

  it("opens the inspector drawer when a node is tapped", () => {
    render(<MobileWorkflowEditor workflow={buildWorkflow()} />)
    fireEvent.click(screen.getByTestId("tap-n1"))
    expect(screen.getByTestId("drawer")).toBeInTheDocument()
    expect(capturedStore?.getState().selectedNodeIds).toEqual(["n1"])
  })

  it("creates an edge through the tap-to-connect flow", () => {
    render(<MobileWorkflowEditor workflow={buildWorkflow()} />)
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
    render(<MobileWorkflowEditor workflow={buildWorkflow()} />)
    fireEvent.click(screen.getByTestId("do-init")) // provide a React Flow instance
    fireEvent.click(screen.getByTestId("toggle-mode")) // edit → FAB
    fireEvent.click(screen.getByTestId("mobile-editor-fab")) // open palette
    fireEvent.click(screen.getByTestId("add-ai"))
    expect(capturedStore?.getState().nodes).toHaveLength(3)
    expect(screen.getByTestId("drawer")).toBeInTheDocument()
  })

  it("recenters the canvas via the fit-view button (available in read mode)", () => {
    render(<MobileWorkflowEditor workflow={buildWorkflow()} />)
    // Recenter is available without entering edit mode.
    expect(screen.getByTestId("mobile-editor-recenter")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("do-init"))
    fireEvent.click(screen.getByTestId("mobile-editor-recenter"))
    expect(fitViewMock).toHaveBeenCalled()
  })

  it("clears selection and closes the inspector on a pane tap", () => {
    render(<MobileWorkflowEditor workflow={buildWorkflow()} />)
    fireEvent.click(screen.getByTestId("tap-n1"))
    expect(screen.getByTestId("drawer")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("tap-pane"))
    expect(screen.queryByTestId("drawer")).toBeNull()
    expect(capturedStore?.getState().selectedNodeIds).toEqual([])
  })
})
