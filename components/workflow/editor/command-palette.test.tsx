/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CommandPalette } from "./command-palette"
import type { WorkflowRow } from "@/types/workflow/visual"

// next/navigation isn't available in jsdom; provide a Jest mock.
const pushSpy = jest.fn()
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: (...args: unknown[]) => pushSpy(...args) }),
}))

// Live-queried recent workflows — a Jest spy lets us drive different
// scenarios per test without touching the real Dexie database.
let liveQueryResult: WorkflowRow[] | undefined = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveQueryResult,
}))

jest.mock("@/lib/db/workflows", () => ({
  listWorkflows: jest.fn().mockResolvedValue([]),
}))

beforeEach(() => {
  pushSpy.mockClear()
  liveQueryResult = []
})

interface RenderOpts {
  open?: boolean
  onOpenChange?: jest.Mock
  onSave?: jest.Mock
  onAddNode?: jest.Mock
  onRun?: jest.Mock
  onUndo?: jest.Mock
  onRedo?: jest.Mock
  onAutoLayout?: jest.Mock
  onExportJson?: jest.Mock
  onImportJsonRequest?: jest.Mock
}

function renderPalette(opts: RenderOpts = {}) {
  const onOpenChange = opts.onOpenChange ?? jest.fn()
  const onSave = opts.onSave ?? jest.fn()
  const onAddNode = opts.onAddNode ?? jest.fn()
  render(
    <CommandPalette
      open={opts.open ?? true}
      onOpenChange={onOpenChange}
      currentWorkflowId="wf_current"
      onAddNode={onAddNode}
      onSave={onSave}
      onRun={opts.onRun}
      onUndo={opts.onUndo}
      onRedo={opts.onRedo}
      onAutoLayout={opts.onAutoLayout}
      onExportJson={opts.onExportJson}
      onImportJsonRequest={opts.onImportJsonRequest}
    />
  )
  return { onOpenChange, onSave, onAddNode }
}

describe("CommandPalette", () => {
  it("does not render the dialog when open=false", () => {
    renderPalette({ open: false })
    // The dialog uses `role=dialog`; it shouldn't be in the document.
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("always renders Save / Library actions when open", () => {
    renderPalette({ open: true })
    expect(screen.getByText("Save workflow")).toBeInTheDocument()
    expect(screen.getByText("Back to library")).toBeInTheDocument()
  })

  it("only renders optional actions when their handler is provided", () => {
    renderPalette({
      open: true,
      onRun: jest.fn(),
      onUndo: jest.fn(),
      onRedo: jest.fn(),
      onAutoLayout: jest.fn(),
      onExportJson: jest.fn(),
      onImportJsonRequest: jest.fn(),
    })
    expect(screen.getByText("Run workflow")).toBeInTheDocument()
    expect(screen.getByText("Undo")).toBeInTheDocument()
    expect(screen.getByText("Redo")).toBeInTheDocument()
    expect(screen.getByText("Auto-layout")).toBeInTheDocument()
    expect(screen.getByText("Export workflow JSON")).toBeInTheDocument()
    expect(screen.getByText("Import workflow JSON")).toBeInTheDocument()
  })

  it("hides optional actions when no handler is supplied", () => {
    renderPalette({ open: true })
    expect(screen.queryByText("Run workflow")).toBeNull()
    expect(screen.queryByText("Undo")).toBeNull()
    expect(screen.queryByText("Redo")).toBeNull()
    expect(screen.queryByText("Auto-layout")).toBeNull()
    expect(screen.queryByText("Export workflow JSON")).toBeNull()
    expect(screen.queryByText("Import workflow JSON")).toBeNull()
  })

  it("calls onSave + closes the dialog when Save is selected", async () => {
    const user = userEvent.setup()
    const { onSave, onOpenChange } = renderPalette({ open: true })
    await user.click(screen.getByText("Save workflow"))
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("routes 'Back to library' to /workflows", async () => {
    const user = userEvent.setup()
    renderPalette({ open: true })
    await user.click(screen.getByText("Back to library"))
    expect(pushSpy).toHaveBeenCalledWith("/workflows")
  })

  it("excludes the current workflow from recents and limits to 5", () => {
    liveQueryResult = [
      { id: "wf_current", name: "Current", updatedAt: 100 } as WorkflowRow,
      { id: "wf_b", name: "Beta", updatedAt: 90 } as WorkflowRow,
      { id: "wf_a", name: "Alpha", updatedAt: 80 } as WorkflowRow,
      { id: "wf_c", name: "Charlie", updatedAt: 70 } as WorkflowRow,
      { id: "wf_d", name: "Delta", updatedAt: 60 } as WorkflowRow,
      { id: "wf_e", name: "Echo", updatedAt: 50 } as WorkflowRow,
      { id: "wf_f", name: "Foxtrot", updatedAt: 40 } as WorkflowRow,
    ]
    renderPalette({ open: true })
    expect(screen.queryByText("Current")).toBeNull()
    expect(screen.getByText("Beta")).toBeInTheDocument()
    expect(screen.getByText("Echo")).toBeInTheDocument()
    expect(screen.queryByText("Foxtrot")).toBeNull()
  })

  it("hides the recents section entirely when no eligible workflows exist", () => {
    liveQueryResult = [{ id: "wf_current", name: "Current", updatedAt: 100 } as WorkflowRow]
    renderPalette({ open: true })
    expect(screen.queryByText("Switch to recent workflow")).toBeNull()
  })

  it("treats undefined live-query result as 'still loading'", () => {
    liveQueryResult = undefined
    renderPalette({ open: true })
    expect(screen.queryByText("Switch to recent workflow")).toBeNull()
  })

  it("navigates to a recent workflow when its row is selected", async () => {
    liveQueryResult = [{ id: "wf_target", name: "Target wf", updatedAt: 50 } as WorkflowRow]
    const user = userEvent.setup()
    const onOpenChange = jest.fn()
    renderPalette({ open: true, onOpenChange })
    await user.click(screen.getByText("Target wf"))
    expect(pushSpy).toHaveBeenCalledWith("/workflows/wf_target")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("renders an Add … node group for the catalog", () => {
    renderPalette({ open: true })
    // Every catalog rendering produces at least the trigger group, regardless
    // of the active query.
    expect(screen.getByText(/Add trigger node/i)).toBeInTheDocument()
  })

  it("calls onAddNode with the picked kind when a catalog item is selected", async () => {
    const user = userEvent.setup()
    const onAddNode = jest.fn()
    renderPalette({ open: true, onAddNode })
    // Pick the first catalog item that's known to exist — `trigger.manual`
    // uses the human-readable label "Run manually".
    const items = screen.queryAllByText(/Run manually/i)
    expect(items.length).toBeGreaterThan(0)
    await user.click(items[0])
    expect(onAddNode).toHaveBeenCalledWith("trigger.manual")
  })
})
