/**
 * @jest-environment jsdom
 */

import { act, render, screen, fireEvent } from "@testing-library/react"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import { WorkflowLibraryToolbar } from "./workflow-library-toolbar"
import { DEFAULT_WORKFLOW_FILTERS, useWorkflowLibraryStore } from "@/stores/workflow"

beforeEach(() => {
  useWorkflowLibraryStore.setState({
    query: "",
    currentFolderId: ROOT_FOLDER_ID,
    createFolderParentId: null,
    filters: { ...DEFAULT_WORKFLOW_FILTERS },
    sort: "updated",
    viewMode: "grid",
  })
})

describe("WorkflowLibraryToolbar", () => {
  it("renders search and both create actions", () => {
    render(<WorkflowLibraryToolbar onNewWorkflow={jest.fn()} />)
    expect(screen.getByTestId("workflow-library-search")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-new-folder")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-new")).toBeInTheDocument()
  })

  it("debounces the search text into the store query", () => {
    jest.useFakeTimers()
    try {
      render(<WorkflowLibraryToolbar onNewWorkflow={jest.fn()} />)
      fireEvent.change(screen.getByTestId("workflow-library-search"), {
        target: { value: "digest" },
      })
      // Not written yet — still within the debounce window.
      expect(useWorkflowLibraryStore.getState().query).toBe("")
      act(() => {
        jest.advanceTimersByTime(250)
      })
      expect(useWorkflowLibraryStore.getState().query).toBe("digest")
    } finally {
      jest.useRealTimers()
    }
  })

  it("opens the create-folder dialog under the current folder", () => {
    useWorkflowLibraryStore.setState({ currentFolderId: "wff_x" })
    render(<WorkflowLibraryToolbar onNewWorkflow={jest.fn()} />)
    fireEvent.click(screen.getByTestId("workflow-new-folder"))
    expect(useWorkflowLibraryStore.getState().createFolderParentId).toBe("wff_x")
  })

  it("fires onNewWorkflow", () => {
    const onNewWorkflow = jest.fn()
    render(<WorkflowLibraryToolbar onNewWorkflow={onNewWorkflow} />)
    fireEvent.click(screen.getByTestId("workflow-new"))
    expect(onNewWorkflow).toHaveBeenCalledTimes(1)
  })
})
