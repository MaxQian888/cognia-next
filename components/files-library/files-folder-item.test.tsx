/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { Table, TableBody } from "@/components/ui/table"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesFolderRow, FilesFolderTile } from "./files-folder-item"

const NOW = Date.UTC(2026, 8, 21, 12)
const folder: LibraryFolder = {
  id: "lbf_a",
  name: "Specs",
  parentFolderId: "root",
  createdAt: 1,
  updatedAt: NOW - 3 * 60 * 60 * 1000,
  color: "green",
}
const actions = { setFolderStyle: jest.fn() }

beforeEach(() =>
  useFilesLibraryStore.setState({
    section: { kind: "folder", folderId: "root" },
    expandedFolderIds: [],
  })
)

it("a tile opens the folder and counts its items", async () => {
  render(<FilesFolderTile folder={folder} itemCount={2} actions={actions} now={NOW} />)
  const tile = screen.getByRole("button", { name: "Open folder Specs" })
  expect(tile).toHaveTextContent("2 items")
  await userEvent.setup().click(tile)
  expect(useFilesLibraryStore.getState()).toMatchObject({
    section: { kind: "folder", folderId: "lbf_a" },
    expandedFolderIds: ["lbf_a"],
  })
})

it("a tile opens with the keyboard and has the folder menu", async () => {
  render(<FilesFolderTile folder={folder} itemCount={0} actions={actions} now={NOW} />)
  fireEvent.keyDown(screen.getByRole("button", { name: "Open folder Specs" }), { key: "Enter" })
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "folder", folderId: "lbf_a" })
  await userEvent.setup().click(screen.getByRole("button", { name: "Folder actions for Specs" }))
  expect(screen.getByRole("menuitem", { name: "Delete folder" })).toBeInTheDocument()
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "folder", folderId: "lbf_a" })
})

it("a row spans the list columns and opens the folder", () => {
  render(
    <Table>
      <TableBody>
        <FilesFolderRow folder={folder} itemCount={1} actions={actions} now={NOW} />
      </TableBody>
    </Table>
  )
  const row = screen.getByRole("row", { name: "Open folder Specs" })
  expect(row).toHaveTextContent("1 item")
  expect(row).toHaveTextContent("3h ago")
  expect(row).toHaveTextContent("Folder")
  fireEvent.click(row)
  expect(useFilesLibraryStore.getState().section).toEqual({ kind: "folder", folderId: "lbf_a" })
})
