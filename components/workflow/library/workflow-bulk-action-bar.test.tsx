/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { WorkflowBulkActionBar } from "./workflow-bulk-action-bar"
import { useWorkflowLibraryStore } from "@/stores/workflow"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { createWorkflow } from "@/lib/db/workflows"

const downloadWorkflowJsonMock = jest.fn()
const downloadWorkflowsBundleMock = jest.fn()
jest.mock("@/lib/workflow/editor/workflow-json", () => ({
  __esModule: true,
  downloadWorkflowJson: (...a: unknown[]) => downloadWorkflowJsonMock(...a),
  downloadWorkflowsBundle: (...a: unknown[]) => downloadWorkflowsBundleMock(...a),
}))

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
  downloadWorkflowJsonMock.mockClear()
  downloadWorkflowsBundleMock.mockClear()
  useWorkflowLibraryStore.setState({
    selection: new Set<string>(),
    moveDialogTarget: null,
    tagDialogTarget: null,
    deleteDialogTarget: null,
  })
})

describe("WorkflowBulkActionBar", () => {
  it("renders nothing when no workflows are selected", () => {
    const { container } = render(<WorkflowBulkActionBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the count and opens move/tag/delete dialogs from the selection", () => {
    useWorkflowLibraryStore.setState({ selection: new Set(["wf_a", "wf_b"]) })
    render(<WorkflowBulkActionBar />)
    expect(screen.getByTestId("workflow-bulk-count").textContent).toMatch(/2/)

    fireEvent.click(screen.getByTestId("workflow-bulk-move"))
    expect(useWorkflowLibraryStore.getState().moveDialogTarget?.ids.sort()).toEqual([
      "wf_a",
      "wf_b",
    ])

    fireEvent.click(screen.getByTestId("workflow-bulk-tag"))
    expect(useWorkflowLibraryStore.getState().tagDialogTarget?.ids).toHaveLength(2)

    fireEvent.click(screen.getByTestId("workflow-bulk-delete"))
    expect(useWorkflowLibraryStore.getState().deleteDialogTarget?.ids).toHaveLength(2)
  })

  it("clears the selection", () => {
    useWorkflowLibraryStore.setState({ selection: new Set(["wf_a"]) })
    render(<WorkflowBulkActionBar />)
    fireEvent.click(screen.getByTestId("workflow-bulk-clear"))
    expect(useWorkflowLibraryStore.getState().selection.size).toBe(0)
  })

  it("exports a single selected workflow as one JSON file", async () => {
    const wf = await createWorkflow({ name: "Solo" })
    useWorkflowLibraryStore.setState({ selection: new Set([wf.id]) })
    render(<WorkflowBulkActionBar />)
    fireEvent.click(screen.getByTestId("workflow-bulk-export"))
    await waitFor(() => expect(downloadWorkflowJsonMock).toHaveBeenCalledTimes(1))
    expect(downloadWorkflowsBundleMock).not.toHaveBeenCalled()
  })

  it("exports multiple selected workflows as a bundle", async () => {
    const a = await createWorkflow({ name: "A" })
    const b = await createWorkflow({ name: "B" })
    useWorkflowLibraryStore.setState({ selection: new Set([a.id, b.id]) })
    render(<WorkflowBulkActionBar />)
    fireEvent.click(screen.getByTestId("workflow-bulk-export"))
    await waitFor(() => expect(downloadWorkflowsBundleMock).toHaveBeenCalledTimes(1))
    expect(downloadWorkflowsBundleMock.mock.calls[0][0]).toHaveLength(2)
  })
})
