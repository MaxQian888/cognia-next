/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { WorkflowCreateFolderDialog } from "./workflow-create-folder-dialog"
import { createFolder, getFolder, listChildFolders } from "@/lib/db/workflow-folders"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { ROOT_FOLDER_ID } from "@/types/workflow/folder"
import { useWorkflowLibraryStore } from "@/stores/workflow"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().workflowFolders.clear()
  useWorkflowLibraryStore.setState({ createFolderParentId: null, renameFolderTarget: null })
})

describe("WorkflowCreateFolderDialog", () => {
  it("is closed when no target is set", () => {
    render(<WorkflowCreateFolderDialog />)
    expect(screen.queryByTestId("workflow-folder-name-input")).not.toBeInTheDocument()
  })

  it("creates a folder under the requested parent", async () => {
    useWorkflowLibraryStore.setState({ createFolderParentId: ROOT_FOLDER_ID })
    render(<WorkflowCreateFolderDialog />)
    fireEvent.change(await screen.findByTestId("workflow-folder-name-input"), {
      target: { value: "Reports" },
    })
    fireEvent.click(screen.getByTestId("workflow-folder-submit"))
    await waitFor(() => {
      expect(useWorkflowLibraryStore.getState().createFolderParentId).toBeNull()
    })
    const children = await listChildFolders(ROOT_FOLDER_ID)
    expect(children.map((c) => c.name)).toContain("Reports")
  })

  it("renames an existing folder", async () => {
    const existing = await createFolder({ name: "Old" })
    useWorkflowLibraryStore.setState({
      renameFolderTarget: { id: existing.id, name: existing.name },
    })
    render(<WorkflowCreateFolderDialog />)
    const input = await screen.findByTestId("workflow-folder-name-input")
    expect(input).toHaveValue("Old")
    fireEvent.change(input, { target: { value: "New name" } })
    fireEvent.click(screen.getByTestId("workflow-folder-submit"))
    await waitFor(async () => {
      expect((await getFolder(existing.id))?.name).toBe("New name")
    })
    expect(useWorkflowLibraryStore.getState().renameFolderTarget).toBeNull()
  })
})
