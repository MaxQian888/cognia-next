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
import { FilesBackendProvider, type FilesBackend } from "@/hooks/files-library/files-backend"
import type { FilesOps } from "@/lib/files-library/ops"
import { FilesRemoteError } from "@/lib/files-library/remote/client"
import { FilesFolderDialog } from "./files-folder-dialog"

function withOps(ops: Partial<FilesOps>) {
  const backend = {
    source: { entries: [], imagesTruncated: false, loadMoreImages: () => {}, folders: [] },
    ops,
  } as unknown as FilesBackend
  return function Paired({ children }: { children: React.ReactNode }) {
    return <FilesBackendProvider backend={backend}>{children}</FilesBackendProvider>
  }
}

const create = createLibraryFolder as jest.Mock
const rename = renameLibraryFolder as jest.Mock

beforeEach(() => {
  create.mockClear()
  rename.mockClear()
})

it("creates a folder under the requested parent and opens the parent in the tree", async () => {
  useFilesLibraryStore.setState({
    folderDialog: { mode: "create", parentId: "lbf_p" },
    expandedFolderIds: [],
  })
  const user = userEvent.setup()
  render(<FilesFolderDialog />)
  expect(screen.getByRole("button", { name: "Create" })).toBeDisabled()
  await user.type(screen.getByLabelText("Name"), "Specs")
  await user.click(screen.getByRole("button", { name: "Create" }))
  await waitFor(() => expect(useFilesLibraryStore.getState().folderDialog).toBeNull())
  expect(create).toHaveBeenCalledWith({ name: "Specs", parentFolderId: "lbf_p" })
  expect(useFilesLibraryStore.getState().expandedFolderIds).toEqual(["lbf_p"])
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

it("creates in the library the page manages, mapping the host's refusals", async () => {
  const createFolder = jest
    .fn()
    .mockRejectedValueOnce(new FilesRemoteError("headless_host"))
    .mockResolvedValueOnce(undefined)
  useFilesLibraryStore.setState({ folderDialog: { mode: "create", parentId: "root" } })
  const user = userEvent.setup()
  render(<FilesFolderDialog />, { wrapper: withOps({ createFolder }) })
  await user.type(screen.getByLabelText("Name"), "Host{Enter}")
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "The paired host can’t manage its Files library. Open Files on the desktop app."
    )
  )
  await user.click(screen.getByRole("button", { name: "Create" }))
  await waitFor(() => expect(useFilesLibraryStore.getState().folderDialog).toBeNull())
  expect(createFolder).toHaveBeenLastCalledWith("Host", "root")
  expect(create).not.toHaveBeenCalled()
})
