/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/lib/db/files-library-folders", () => ({
  deleteLibraryFolder: jest.fn(async () => {}),
}))

import { deleteLibraryFolder } from "@/lib/db/files-library-folders"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesDeleteFolderDialog } from "./files-delete-folder-dialog"

const remove = deleteLibraryFolder as jest.Mock
const folders: LibraryFolder[] = [
  { id: "lbf_a", name: "Specs", parentFolderId: "lbf_p", createdAt: 1, updatedAt: 1 },
]

beforeEach(() => remove.mockClear())

it("moves contents up by default and returns to the parent", async () => {
  useFilesLibraryStore.setState({ deleteFolderTarget: "lbf_a", folderId: "lbf_a" })
  render(<FilesDeleteFolderDialog folders={folders} />)
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete “Specs”?")
  await userEvent.setup().click(screen.getByRole("button", { name: "Delete folder" }))
  expect(remove).toHaveBeenCalledWith("lbf_a", "reparent")
  await waitFor(() => expect(useFilesLibraryStore.getState().folderId).toBe("lbf_p"))
  expect(useFilesLibraryStore.getState().deleteFolderTarget).toBeNull()
})

it("cascades when asked", async () => {
  useFilesLibraryStore.setState({ deleteFolderTarget: "lbf_a" })
  const user = userEvent.setup()
  render(<FilesDeleteFolderDialog folders={folders} />)
  await user.click(screen.getByRole("checkbox"))
  await user.click(screen.getByRole("button", { name: "Delete folder" }))
  expect(remove).toHaveBeenCalledWith("lbf_a", "cascade")
})
