/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { LibraryFolder } from "@/lib/db/files-library-types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesFolderBar } from "./files-folder-bar"

function folder(id: string, name: string, parentFolderId = "root"): LibraryFolder {
  return { id, name, parentFolderId, createdAt: 1, updatedAt: 1 }
}
const folders = [folder("a", "Specs"), folder("b", "Drafts", "a"), folder("c", "Archive")]

beforeEach(() =>
  useFilesLibraryStore.setState({
    tab: "folders",
    folderId: "root",
    folderDialog: null,
    deleteFolderTarget: null,
  })
)

it("lists top-level folders at the root and enters one", async () => {
  render(<FilesFolderBar folders={folders} />)
  expect(screen.getByRole("list", { name: "Subfolders" })).toHaveTextContent("ArchiveSpecs")
  expect(screen.queryByRole("button", { name: /Folder actions/ })).toBeNull()
  await userEvent.setup().click(screen.getByRole("button", { name: "Open folder Specs" }))
  expect(useFilesLibraryStore.getState().folderId).toBe("a")
})

it("shows the path, creates inside, and renames or deletes the folder in view", async () => {
  useFilesLibraryStore.setState({ folderId: "b" })
  const user = userEvent.setup()
  render(<FilesFolderBar folders={folders} />)
  const nav = screen.getByRole("navigation", { name: "Folder path" })
  expect(nav).toHaveTextContent("FoldersSpecsDrafts")
  await user.click(screen.getByRole("button", { name: "New folder" }))
  expect(useFilesLibraryStore.getState().folderDialog).toEqual({ mode: "create", parentId: "b" })
  await user.click(screen.getByRole("button", { name: "Folder actions for Drafts" }))
  await user.click(screen.getByRole("menuitem", { name: "Rename folder" }))
  expect(useFilesLibraryStore.getState().folderDialog).toEqual({
    mode: "rename",
    folderId: "b",
    name: "Drafts",
  })
  await user.click(screen.getByRole("button", { name: "Folder actions for Drafts" }))
  await user.click(screen.getByRole("menuitem", { name: "Delete folder" }))
  expect(useFilesLibraryStore.getState().deleteFolderTarget).toBe("b")
  await user.click(screen.getByRole("button", { name: "Specs" }))
  expect(useFilesLibraryStore.getState().folderId).toBe("a")
  await user.click(screen.getByRole("button", { name: "Folders" }))
  expect(useFilesLibraryStore.getState().folderId).toBe("root")
})

it("keeps deep breadcrumbs locally scrollable beside folder actions", () => {
  useFilesLibraryStore.setState({ folderId: "b" })
  render(<FilesFolderBar folders={folders} />)
  expect(screen.getByRole("navigation", { name: "Folder path" })).toHaveClass(
    "overflow-x-auto",
    "basis-full",
    "@sm/files-folder:basis-auto"
  )
  expect(screen.getByTestId("files-breadcrumb-root")).toHaveClass("shrink-0")
  expect(screen.getByTestId("files-breadcrumb-b").parentElement).toHaveClass("shrink-0")
})
