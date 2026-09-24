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
    searchResetKey: 0,
    currentFolderId: ROOT_FOLDER_ID,
    createFolderParentId: null,
    filters: { ...DEFAULT_WORKFLOW_FILTERS },
    sort: "updated",
    viewMode: "grid",
  })
})

describe("WorkflowLibraryToolbar", () => {
  it("renders search and secondary actions", () => {
    render(<WorkflowLibraryToolbar onImportFiles={jest.fn()} />)
    expect(screen.getByTestId("workflow-library-search")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-new-folder")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-import")).toBeInTheDocument()
  })

  it("forwards picked files to onImportFiles", () => {
    const onImportFiles = jest.fn()
    render(<WorkflowLibraryToolbar onImportFiles={onImportFiles} />)
    const file = new File(['{"nodes":[],"edges":[]}'], "wf.json", { type: "application/json" })
    fireEvent.change(screen.getByTestId("workflow-import-input"), { target: { files: [file] } })
    expect(onImportFiles).toHaveBeenCalledTimes(1)
  })

  it("debounces the search text into the store query", () => {
    jest.useFakeTimers()
    try {
      render(<WorkflowLibraryToolbar onImportFiles={jest.fn()} />)
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

  it("empties the search box when the search and filters are cleared", () => {
    jest.useFakeTimers()
    try {
      render(<WorkflowLibraryToolbar onImportFiles={jest.fn()} />)
      const search = () => screen.getByTestId<HTMLInputElement>("workflow-library-search")
      fireEvent.change(search(), { target: { value: "digest" } })
      act(() => {
        jest.advanceTimersByTime(250)
      })
      expect(useWorkflowLibraryStore.getState().query).toBe("digest")

      act(() => {
        useWorkflowLibraryStore.getState().clearSearchAndFilters()
      })
      expect(search().value).toBe("")
      expect(useWorkflowLibraryStore.getState().query).toBe("")
    } finally {
      jest.useRealTimers()
    }
  })

  it("drops a keystroke still inside the debounce window when the search is cleared", () => {
    jest.useFakeTimers()
    try {
      render(<WorkflowLibraryToolbar onImportFiles={jest.fn()} />)
      fireEvent.change(screen.getByTestId("workflow-library-search"), {
        target: { value: "digest" },
      })
      // Cleared before the 200ms write lands.
      act(() => {
        useWorkflowLibraryStore.getState().clearSearchAndFilters()
      })
      act(() => {
        jest.advanceTimersByTime(500)
      })
      // The pending write must not resurrect the query the user just cleared.
      expect(useWorkflowLibraryStore.getState().query).toBe("")
      expect(screen.getByTestId<HTMLInputElement>("workflow-library-search").value).toBe("")
    } finally {
      jest.useRealTimers()
    }
  })

  it("opens the create-folder dialog under the current folder", () => {
    useWorkflowLibraryStore.setState({ currentFolderId: "wff_x" })
    render(<WorkflowLibraryToolbar onImportFiles={jest.fn()} />)
    fireEvent.click(screen.getByTestId("workflow-new-folder"))
    expect(useWorkflowLibraryStore.getState().createFolderParentId).toBe("wff_x")
  })
})
