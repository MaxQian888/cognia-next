/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent } from "@testing-library/react"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"
import { WorkflowFolderCard } from "./workflow-folder-card"
import { useWorkflowLibraryStore } from "@/stores/workflow"

const folder: WorkflowFolder = {
  id: "wff_a",
  name: "Reports",
  parentFolderId: ROOT_FOLDER_ID,
  createdAt: 0,
  updatedAt: 0,
}

beforeEach(() => {
  useWorkflowLibraryStore.setState({ currentFolderId: ROOT_FOLDER_ID })
})

describe("WorkflowFolderCard", () => {
  it("shows the folder name and a menu", () => {
    render(<WorkflowFolderCard folder={folder} />)
    expect(screen.getByTestId("workflow-folder-card-wff_a")).toHaveTextContent("Reports")
    expect(screen.getByTestId("workflow-folder-menu-wff_a")).toBeInTheDocument()
  })

  it("enters the folder on click", () => {
    render(<WorkflowFolderCard folder={folder} />)
    fireEvent.click(screen.getByTestId("workflow-folder-card-wff_a"))
    expect(useWorkflowLibraryStore.getState().currentFolderId).toBe("wff_a")
  })

  it("enters the folder on Enter key", () => {
    render(<WorkflowFolderCard folder={folder} />)
    fireEvent.keyDown(screen.getByTestId("workflow-folder-card-wff_a"), { key: "Enter" })
    expect(useWorkflowLibraryStore.getState().currentFolderId).toBe("wff_a")
  })
})
