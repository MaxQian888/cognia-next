/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"
import type { WorkflowRow } from "@/types/workflow/visual"

jest.mock("./workflow-card", () => ({
  WorkflowCard: ({ workflow }: { workflow: WorkflowRow }) => (
    <div data-testid={`card-${workflow.id}`}>{workflow.name}</div>
  ),
}))
jest.mock("./workflow-folder-card", () => ({
  WorkflowFolderCard: ({ folder }: { folder: WorkflowFolder }) => (
    <div data-testid={`foldercard-${folder.id}`}>{folder.name}</div>
  ),
}))

import { WorkflowLibraryGrid } from "./workflow-library-grid"

function folder(id: string): WorkflowFolder {
  return { id, name: `Folder ${id}`, parentFolderId: ROOT_FOLDER_ID, createdAt: 0, updatedAt: 0 }
}
function wf(id: string): WorkflowRow {
  return { id, name: `WF ${id}`, nodes: [] } as unknown as WorkflowRow
}

describe("WorkflowLibraryGrid", () => {
  it("renders a folders section and workflow cards", () => {
    render(
      <WorkflowLibraryGrid
        folders={[folder("a"), folder("b")]}
        workflows={[wf("1"), wf("2"), wf("3"), wf("4")]}
      />
    )
    expect(screen.getByTestId("foldercard-a")).toBeInTheDocument()
    expect(screen.getByTestId("foldercard-b")).toBeInTheDocument()
    expect(screen.getByTestId("card-1")).toBeInTheDocument()
    expect(screen.getByTestId("card-4")).toBeInTheDocument()
  })

  it("omits the folders section when there are none", () => {
    render(<WorkflowLibraryGrid folders={[]} workflows={[wf("1")]} />)
    expect(screen.queryByTestId("foldercard-a")).not.toBeInTheDocument()
    expect(screen.getByTestId("card-1")).toBeInTheDocument()
  })
})
