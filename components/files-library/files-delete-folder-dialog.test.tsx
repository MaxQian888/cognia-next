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
import { FilesBackendProvider, type FilesBackend } from "@/hooks/files-library/files-backend"
import type { FilesOps } from "@/lib/files-library/ops"
import { FilesDeleteFolderDialog } from "./files-delete-folder-dialog"

function withOps(ops: Partial<FilesOps>) {
  const backend = {
    source: { entries: [], imagesTruncated: false, loadMoreImages: () => {}, folders: [] },
    ops,
  } as unknown as FilesBackend
  return function Paired({ children }: { children: React.ReactNode }) {
    return <FilesBackendProvider backend={backend}>{children}</FilesBackendProvider>
  }
}

const remove = deleteLibraryFolder as jest.Mock
const folders: LibraryFolder[] = [
  { id: "lbf_a", name: "Specs", parentFolderId: "lbf_p", createdAt: 1, updatedAt: 1 },
  { id: "lbf_c", name: "Drafts", parentFolderId: "lbf_a", createdAt: 1, updatedAt: 1 },
]

beforeEach(() => remove.mockClear())

it("moves contents up by default and returns to the parent", async () => {
  useFilesLibraryStore.setState({
    deleteFolderTarget: "lbf_a",
    section: { kind: "folder", folderId: "lbf_a" },
  })
  render(<FilesDeleteFolderDialog folders={folders} />)
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete “Specs”?")
  await userEvent.setup().click(screen.getByRole("button", { name: "Delete folder" }))
  expect(remove).toHaveBeenCalledWith("lbf_a", "reparent")
  await waitFor(() =>
    expect(useFilesLibraryStore.getState().section).toEqual({ kind: "folder", folderId: "lbf_p" })
  )
  expect(useFilesLibraryStore.getState().deleteFolderTarget).toBeNull()
})

it("cascades when asked, leaving a deleted subfolder in view", async () => {
  useFilesLibraryStore.setState({
    deleteFolderTarget: "lbf_a",
    section: { kind: "folder", folderId: "lbf_c" },
  })
  const user = userEvent.setup()
  render(<FilesDeleteFolderDialog folders={folders} />)
  await user.click(screen.getByRole("checkbox"))
  await user.click(screen.getByRole("button", { name: "Delete folder" }))
  expect(remove).toHaveBeenCalledWith("lbf_a", "cascade")
  await waitFor(() =>
    expect(useFilesLibraryStore.getState().section).toEqual({ kind: "folder", folderId: "lbf_p" })
  )
})

it("keeps a surviving subfolder in view when contents move up", async () => {
  useFilesLibraryStore.setState({
    deleteFolderTarget: "lbf_a",
    section: { kind: "folder", folderId: "lbf_c" },
  })
  render(<FilesDeleteFolderDialog folders={folders} />)
  await userEvent.setup().click(screen.getByRole("button", { name: "Delete folder" }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith("lbf_a", "reparent"))
  await Promise.resolve()
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "folder", folderId: "lbf_c" })
})

it("wraps long folder names inside a viewport-bounded confirmation", () => {
  useFilesLibraryStore.setState({ deleteFolderTarget: "lbf_a" })
  render(<FilesDeleteFolderDialog folders={[{ ...folders[0]!, name: "folder".repeat(20) }]} />)
  expect(screen.getByRole("alertdialog")).toHaveClass("max-h-[85vh]", "overflow-y-auto")
  expect(screen.getByRole("heading")).toHaveClass("[overflow-wrap:anywhere]")
})

it("deletes in the library the page manages", async () => {
  const deleteFolder = jest.fn(async () => {})
  useFilesLibraryStore.setState({ deleteFolderTarget: "lbf_a", section: { kind: "all" } })
  render(<FilesDeleteFolderDialog folders={folders} />, { wrapper: withOps({ deleteFolder }) })
  await userEvent.setup().click(screen.getByRole("button", { name: "Delete folder" }))
  expect(deleteFolder).toHaveBeenCalledWith("lbf_a", "reparent")
  expect(remove).not.toHaveBeenCalled()
})
