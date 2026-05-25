/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent } from "@testing-library/react"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"
import { WorkflowFolderRow } from "./workflow-folder-row"
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

describe("WorkflowFolderRow", () => {
  it("shows the folder name and enters on click", () => {
    render(<WorkflowFolderRow folder={folder} />)
    expect(screen.getByTestId("workflow-folder-row-wff_a")).toHaveTextContent("Reports")
    fireEvent.click(screen.getByTestId("workflow-folder-row-wff_a"))
    expect(useWorkflowLibraryStore.getState().currentFolderId).toBe("wff_a")
  })
})
