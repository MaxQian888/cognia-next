/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { WorkflowLibraryViewToggle } from "./workflow-library-view-toggle"
import { useWorkflowLibraryStore } from "@/stores/workflow"

beforeEach(() => {
  useWorkflowLibraryStore.setState({ viewMode: "grid" })
})

describe("WorkflowLibraryViewToggle", () => {
  it("renders both layout options", () => {
    render(<WorkflowLibraryViewToggle />)
    expect(screen.getByTestId("workflow-view-grid")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-view-list")).toBeInTheDocument()
  })

  it("switches the store view mode on click", () => {
    render(<WorkflowLibraryViewToggle />)
    fireEvent.click(screen.getByTestId("workflow-view-list"))
    expect(useWorkflowLibraryStore.getState().viewMode).toBe("list")
    fireEvent.click(screen.getByTestId("workflow-view-grid"))
    expect(useWorkflowLibraryStore.getState().viewMode).toBe("grid")
  })
})
