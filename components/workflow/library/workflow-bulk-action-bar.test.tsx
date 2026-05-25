/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { WorkflowBulkActionBar } from "./workflow-bulk-action-bar"
import { useWorkflowLibraryStore } from "@/stores/workflow"

beforeEach(() => {
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
})
