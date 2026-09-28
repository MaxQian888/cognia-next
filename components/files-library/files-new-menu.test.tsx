/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesNewMenu } from "./files-new-menu"

function actions() {
  return { upload: jest.fn(async () => {}), newCanvasDocument: jest.fn() }
}

beforeEach(() =>
  useFilesLibraryStore.setState({ tab: "recent", folderId: "root", folderDialog: null })
)

it("uploads the chosen files", () => {
  const a = actions()
  render(<FilesNewMenu actions={a} />)
  const file = new File(["x"], "a.md")
  fireEvent.change(screen.getByLabelText("Choose files to upload"), { target: { files: [file] } })
  expect(a.upload).toHaveBeenCalledWith([file])
})

it("starts a canvas document and opens the new-folder dialog in the Folders tab", async () => {
  const a = actions()
  const user = userEvent.setup()
  render(<FilesNewMenu actions={a} />)
  await user.click(screen.getByRole("button", { name: "New" }))
  await user.click(screen.getByRole("menuitem", { name: "Canvas document" }))
  expect(a.newCanvasDocument).toHaveBeenCalled()
  await user.click(screen.getByRole("button", { name: "New" }))
  await user.click(screen.getByRole("menuitem", { name: "Folder" }))
  expect(useFilesLibraryStore.getState()).toMatchObject({
    tab: "folders",
    folderDialog: { mode: "create", parentId: "root" },
  })
})

it("creates the folder inside the folder being browsed", async () => {
  useFilesLibraryStore.setState({ tab: "folders", folderId: "lbf_1" })
  const user = userEvent.setup()
  render(<FilesNewMenu actions={actions()} />)
  await user.click(screen.getByRole("button", { name: "New" }))
  await user.click(screen.getByRole("menuitem", { name: "Folder" }))
  expect(useFilesLibraryStore.getState().folderDialog).toEqual({
    mode: "create",
    parentId: "lbf_1",
  })
})
