/**
 * @jest-environment jsdom
 */

import { render, screen } from "@testing-library/react"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"
import type { WorkflowRow } from "@/types/workflow/visual"

jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 5) }, (_, i) => ({
        index: i,
        start: i * 64,
        size: 64,
        end: (i + 1) * 64,
        key: i,
        lane: 0,
      })),
    getTotalSize: () => count * 64,
    measureElement: jest.fn(),
  }),
}))

jest.mock("./workflow-row", () => ({
  WorkflowRow: ({ workflow }: { workflow: WorkflowRow }) => (
    <div data-testid={`row-${workflow.id}`}>{workflow.name}</div>
  ),
}))
jest.mock("./workflow-folder-row", () => ({
  WorkflowFolderRow: ({ folder }: { folder: WorkflowFolder }) => (
    <div data-testid={`folderrow-${folder.id}`}>{folder.name}</div>
  ),
}))

import { WorkflowLibraryList } from "./workflow-library-list"

function folder(id: string): WorkflowFolder {
  return { id, name: `Folder ${id}`, parentFolderId: ROOT_FOLDER_ID, createdAt: 0, updatedAt: 0 }
}
function wf(id: string): WorkflowRow {
  return { id, name: `WF ${id}`, nodes: [] } as unknown as WorkflowRow
}

describe("WorkflowLibraryList", () => {
  it("renders folder rows and virtualized workflow rows", () => {
    render(<WorkflowLibraryList folders={[folder("a")]} workflows={[wf("1"), wf("2"), wf("3")]} />)
    expect(screen.getByTestId("folderrow-a")).toBeInTheDocument()
    expect(screen.getByTestId("row-1")).toBeInTheDocument()
    expect(screen.getByTestId("row-3")).toBeInTheDocument()
  })

  it("omits the folders section when there are none", () => {
    render(<WorkflowLibraryList folders={[]} workflows={[wf("1")]} />)
    expect(screen.queryByTestId("folderrow-a")).not.toBeInTheDocument()
    expect(screen.getByTestId("row-1")).toBeInTheDocument()
  })
})
