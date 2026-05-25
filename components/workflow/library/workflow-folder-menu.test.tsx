/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { WorkflowFolderMenu } from "./workflow-folder-menu"
import { createFolder, getFolder, listChildFolders } from "@/lib/db/workflow-folders"
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
  useWorkflowLibraryStore.setState({ renameFolderTarget: null })
})

function f(id: string): WorkflowFolder {
  return { id, name: "Reports", parentFolderId: ROOT_FOLDER_ID, createdAt: 0, updatedAt: 0 }
}

describe("WorkflowFolderMenu", () => {
  it("opens the rename dialog target via the store", async () => {
    const user = userEvent.setup()
    render(<WorkflowFolderMenu folder={f("wff_a")} />)
    await user.click(screen.getByTestId("workflow-folder-menu-wff_a"))
    fireEvent.click(await screen.findByTestId("workflow-folder-rename-wff_a"))
    expect(useWorkflowLibraryStore.getState().renameFolderTarget).toEqual({
      id: "wff_a",
      name: "Reports",
    })
  })

  it("deletes the folder (reparent) after confirmation", async () => {
    const user = userEvent.setup()
    const parent = await createFolder({ name: "Parent" })
    const child = await createFolder({ name: "Child", parentFolderId: parent.id })
    const wf = await createWorkflow({ name: "WF" })
    await getDb().workflows.update(wf.id, { folderId: parent.id })

    render(<WorkflowFolderMenu folder={parent} />)
    await user.click(screen.getByTestId(`workflow-folder-menu-${parent.id}`))
    fireEvent.click(await screen.findByTestId(`workflow-folder-delete-${parent.id}`))
    fireEvent.click(await screen.findByText("Delete folder"))

    await waitFor(async () => {
      expect(await getFolder(parent.id)).toBeUndefined()
    })
    // Child folder and the workflow were lifted to root.
    expect((await getFolder(child.id))?.parentFolderId).toBe(ROOT_FOLDER_ID)
    expect((await listWorkflowsInFolder(ROOT_FOLDER_ID)).map((w) => w.id)).toContain(wf.id)
    expect(await listChildFolders(parent.id)).toEqual([])
  })
})
