/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("@/lib/db/files-library-folders", () => {
  class LibraryFolderError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return {
    LibraryFolderError,
    createLibraryFolder: jest.fn(async () => ({ id: "lbf_new" })),
    renameLibraryFolder: jest.fn(async () => {}),
  }
})
jest.mock("sonner", () => ({ toast: { error: jest.fn() } }))

import { toast } from "sonner"
import {
  createLibraryFolder,
  LibraryFolderError,
  renameLibraryFolder,
} from "@/lib/db/files-library-folders"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesFolderDialog } from "./files-folder-dialog"

const create = createLibraryFolder as jest.Mock
const rename = renameLibraryFolder as jest.Mock

beforeEach(() => {
  create.mockClear()
  rename.mockClear()
})

it("creates a folder under the requested parent and opens it", async () => {
  useFilesLibraryStore.setState({
    folderDialog: { mode: "create", parentId: "lbf_p" },
    folderId: "lbf_p",
  })
  const user = userEvent.setup()
  render(<FilesFolderDialog />)
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled()
  await user.type(screen.getByLabelText("Name"), "Specs")
  await user.click(screen.getByRole("button", { name: "Create" }))
  await waitFor(() => expect(useFilesLibraryStore.getState().folderDialog).toBeNull())
  expect(create).toHaveBeenCalledWith({ name: "Specs", parentFolderId: "lbf_p" })
  expect(useFilesLibraryStore.getState().folderId).toBe("lbf_new")
})

it("renames, prefilled with the current name", async () => {
  useFilesLibraryStore.setState({
    folderDialog: { mode: "rename", folderId: "lbf_a", name: "Old" },
  })
  const user = userEvent.setup()
  render(<FilesFolderDialog />)
  const input = screen.getByLabelText("Name")
  expect(input).toHaveValue("Old")
  await user.clear(input)
  await user.type(input, "New{Enter}")
  await waitFor(() => expect(rename).toHaveBeenCalledWith("lbf_a", "New"))
})

it("reports a refused write and stays open", async () => {
  create.mockRejectedValueOnce(new LibraryFolderError("library_folder_parent_missing"))
  useFilesLibraryStore.setState({ folderDialog: { mode: "create", parentId: "gone" } })
  const user = userEvent.setup()
  render(<FilesFolderDialog />)
  await user.type(screen.getByLabelText("Name"), "X{Enter}")
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith("The parent folder no longer exists.")
  )
  expect(useFilesLibraryStore.getState().folderDialog).not.toBeNull()
})
