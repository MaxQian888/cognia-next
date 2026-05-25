/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { WorkflowMoveToFolderDialog, flattenFolderTree } from "./workflow-move-to-folder-dialog"
import { createFolder } from "@/lib/db/workflow-folders"
import { createWorkflow, listWorkflowsInFolder } from "@/lib/db/workflows"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { ROOT_FOLDER_ID, type WorkflowFolder } from "@/types/workflow/folder"
import { useWorkflowLibraryStore } from "@/stores/workflow"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflows.clear()
  await getDb().workflowFolders.clear()
  useWorkflowLibraryStore.setState({
    moveDialogTarget: null,
    selection: new Set<string>(),
  })
})

function folder(id: string, name: string, parent: string = ROOT_FOLDER_ID): WorkflowFolder {
  return { id, name, parentFolderId: parent, createdAt: 0, updatedAt: 0 }
}

describe("flattenFolderTree", () => {
  it("produces a depth-first list with depths", () => {
    const tree = flattenFolderTree([
      folder("a", "A"),
      folder("b", "B", "a"),
      folder("c", "C", "b"),
      folder("z", "Z"),
    ])
    expect(tree.map((n) => [n.folder.id, n.depth])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
      ["z", 0],
    ])
  })
})

describe("WorkflowMoveToFolderDialog", () => {
  it("moves the targeted workflows into the chosen folder", async () => {
    const dest = await createFolder({ name: "Reports" })
    const wf = await createWorkflow({ name: "WF" })
    useWorkflowLibraryStore.setState({ moveDialogTarget: { ids: [wf.id] } })

    render(<WorkflowMoveToFolderDialog />)
    fireEvent.click(await screen.findByTestId(`workflow-move-target-${dest.id}`))
    fireEvent.click(screen.getByTestId("workflow-move-submit"))

    await waitFor(async () => {
      expect((await listWorkflowsInFolder(dest.id)).map((w) => w.id)).toContain(wf.id)
    })
    expect(useWorkflowLibraryStore.getState().moveDialogTarget).toBeNull()
  })

  it("moves to root when the root option is chosen", async () => {
    const start = await createFolder({ name: "Start" })
    const wf = await createWorkflow({ name: "WF", folderId: start.id })
    useWorkflowLibraryStore.setState({ moveDialogTarget: { ids: [wf.id] } })

    render(<WorkflowMoveToFolderDialog />)
    fireEvent.click(await screen.findByTestId("workflow-move-target-root"))
    fireEvent.click(screen.getByTestId("workflow-move-submit"))

    await waitFor(async () => {
      expect((await listWorkflowsInFolder(ROOT_FOLDER_ID)).map((w) => w.id)).toContain(wf.id)
    })
  })
})
