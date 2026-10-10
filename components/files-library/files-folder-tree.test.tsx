/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { LibraryFolder } from "@/lib/db/files-library-types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesFolderTree } from "./files-folder-tree"

function folder(id: string, name: string, parentFolderId = "root"): LibraryFolder {
  return { id, name, parentFolderId, createdAt: 1, updatedAt: 1 }
}
const folders = [folder("a", "Specs"), folder("b", "Drafts", "a"), folder("c", "Archive")]

beforeEach(() =>
  useFilesLibraryStore.setState({
    section: { kind: "all" },
    expandedFolderIds: [],
    folderDialog: null,
  })
)

function renderTree() {
  return render(
    <FilesFolderTree folders={folders} parentId="root" actions={{ setFolderStyle: jest.fn() }} />
  )
}

it("lists top-level folders by name and opens one as the place", async () => {
  renderTree()
  const tree = screen.getByRole("tree")
  expect(tree).toHaveTextContent("ArchiveSpecs")
  expect(screen.queryByText("Drafts")).toBeNull()
  await userEvent.setup().click(screen.getByTestId("files-tree-open-a"))
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "folder", folderId: "a" })
  expect(screen.getByTestId("files-tree-open-a")).toHaveAttribute("aria-current", "page")
})

it("expands and collapses a folder with children, remembered in the store", async () => {
  renderTree()
  const user = userEvent.setup()
  expect(screen.getByTestId("files-tree-toggle-c")).toHaveClass("invisible")
  await user.click(screen.getByRole("button", { name: "Expand Specs" }))
  expect(useFilesLibraryStore.getState().expandedFolderIds).toEqual(["a"])
  expect(screen.getByText("Drafts")).toBeInTheDocument()
  expect(screen.getAllByRole("treeitem")[1]).toHaveAttribute("aria-expanded", "true")
  await user.click(screen.getByRole("button", { name: "Collapse Specs" }))
  expect(screen.queryByText("Drafts")).toBeNull()
})

it("opens the folder menu from its button and on right-click", async () => {
  renderTree()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Folder actions for Specs" }))
  await user.click(screen.getByRole("menuitem", { name: "New subfolder" }))
  expect(useFilesLibraryStore.getState().folderDialog).toEqual({ mode: "create", parentId: "a" })
  fireEvent.contextMenu(screen.getByTestId("files-tree-folder-c"))
  expect(await screen.findByRole("menuitem", { name: "Rename folder" })).toBeInTheDocument()
})

it("stops at a corrupt parent cycle instead of recursing forever", () => {
  const loop = [folder("x", "X", "y"), folder("y", "Y", "x")]
  useFilesLibraryStore.setState({ expandedFolderIds: ["x", "y"] })
  render(<FilesFolderTree folders={loop} parentId="x" actions={{ setFolderStyle: jest.fn() }} />)
  expect(screen.getAllByText("Y").length).toBeGreaterThan(0)
})

it("sizes rows and controls for touch, down the whole tree", () => {
  useFilesLibraryStore.setState({ expandedFolderIds: ["a"] })
  render(
    <FilesFolderTree
      folders={folders}
      parentId="root"
      actions={{ setFolderStyle: jest.fn() }}
      touch
    />
  )
  for (const id of ["a", "b", "c"]) {
    expect(screen.getByTestId(`files-tree-folder-${id}`)).toHaveClass("h-11")
    expect(screen.getByTestId(`files-tree-toggle-${id}`)).toHaveClass("size-9")
    expect(screen.getByTestId(`files-tree-menu-${id}`)).toHaveClass("size-10")
  }
})
