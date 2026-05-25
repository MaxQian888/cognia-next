/**
 * @jest-environment jsdom
 */

import { render, screen, fireEvent } from "@testing-library/react"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"
import { WorkflowFolderBreadcrumb } from "./workflow-folder-breadcrumb"
import { useWorkflowLibraryStore } from "@/stores/workflow"

function folder(id: string, name: string, parent: string = ROOT_FOLDER_ID): WorkflowFolder {
  return { id, name, parentFolderId: parent, createdAt: 0, updatedAt: 0 }
}

beforeEach(() => {
  useWorkflowLibraryStore.setState({ currentFolderId: "wff_b" })
})

describe("WorkflowFolderBreadcrumb", () => {
  it("renders the root crumb plus every path segment", () => {
    render(
      <WorkflowFolderBreadcrumb
        path={[folder("wff_a", "Reports"), folder("wff_b", "2026", "wff_a")]}
      />
    )
    expect(screen.getByTestId("workflow-breadcrumb-root")).toBeInTheDocument()
    expect(screen.getByTestId("workflow-breadcrumb-wff_a")).toHaveTextContent("Reports")
    expect(screen.getByTestId("workflow-breadcrumb-wff_b")).toHaveTextContent("2026")
  })

  it("navigates to root and into a segment", () => {
    render(<WorkflowFolderBreadcrumb path={[folder("wff_a", "Reports")]} />)
    fireEvent.click(screen.getByTestId("workflow-breadcrumb-wff_a"))
    expect(useWorkflowLibraryStore.getState().currentFolderId).toBe("wff_a")
    fireEvent.click(screen.getByTestId("workflow-breadcrumb-root"))
    expect(useWorkflowLibraryStore.getState().currentFolderId).toBe(ROOT_FOLDER_ID)
  })
})
