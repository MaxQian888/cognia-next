/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("./files-image-thumb", () => ({ FilesImageThumb: () => <div /> }))

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { LibraryFolder } from "@/lib/db/files-library-types"
import type { FilesEntry } from "@/lib/files-library/types"
import { FilesListTable, type FilesListTableProps } from "./files-list-table"

function entry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: "artifact:a",
    kind: "artifact",
    sourceId: "a",
    title: "Parser",
    sourceTitle: "Parser",
    subtype: "code",
    projectIds: [],
    sessionIds: ["s1"],
    originAlive: true,
    createdAt: 1,
    updatedAt: Date.UTC(2026, 8, 21),
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: "",
    ...overrides,
  }
}

function actions(): jest.Mocked<FilesActions> {
  return {
    open: jest.fn(async () => {}),
    preview: jest.fn(),
    toggleFavorite: jest.fn(async () => {}),
    setFavorite: jest.fn(async () => {}),
    moveToFolder: jest.fn(async () => {}),
    trash: jest.fn(async () => {}),
    restore: jest.fn(async () => {}),
    deleteForever: jest.fn(async () => {}),
    rename: jest.fn(async () => true),
    duplicate: jest.fn(async () => {}),
    download: jest.fn(async () => {}),
    exportZip: jest.fn(async () => {}),
    useInChat: jest.fn(async () => {}),
    goToConversation: jest.fn(async () => {}),
    upload: jest.fn(async () => {}),
    newCanvasDocument: jest.fn(),
    moveFolder: jest.fn(async () => {}),
    setFolderStyle: jest.fn(async () => {}),
  } as unknown as jest.Mocked<FilesActions>
}

const folder: LibraryFolder = {
  id: "lbf_a",
  name: "Specs",
  parentFolderId: "root",
  createdAt: 1,
  updatedAt: 1,
}

function renderTable(props: Partial<FilesListTableProps> = {}) {
  const handlers = {
    onSelect: jest.fn(),
    onSelectAll: jest.fn(),
    onClearSelection: jest.fn(),
    onSort: jest.fn(),
  }
  render(
    <FilesListTable
      entries={[entry(), entry({ key: "artifact:b", sourceId: "b", title: "Lexer" })]}
      folders={[]}
      folderItemCounts={new Map()}
      totalInView={2}
      selectedCount={0}
      isSelected={() => false}
      previewedKey={null}
      sort={null}
      trash={false}
      actions={actions()}
      now={Date.UTC(2026, 8, 21)}
      {...handlers}
      {...props}
    />
  )
  return handlers
}

it("draws a header per column and one row per item, folders first", () => {
  renderTable({ folders: [folder], folderItemCounts: new Map([["lbf_a", 3]]) })
  const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent)
  expect(headers).toEqual(["", "Name", "Source", "Last activity", "Size", "Type", "Actions"])
  const rows = screen.getAllByRole("row").slice(1)
  expect(rows[0]).toHaveAccessibleName("Open folder Specs")
  expect(rows[0]).toHaveTextContent("3 items")
  expect(rows[1]).toHaveAccessibleName("Open Parser")
  expect(rows[2]).toHaveAccessibleName("Open Lexer")
})

it("cycles a column's sort and reports it through aria-sort", async () => {
  const user = userEvent.setup()
  const { onSort } = renderTable()
  await user.click(screen.getByRole("button", { name: "Sort by Name" }))
  expect(onSort).toHaveBeenCalledWith({ key: "name", dir: "asc" })
  await user.click(screen.getByRole("button", { name: "Sort by Last activity" }))
  expect(onSort).toHaveBeenLastCalledWith({ key: "activity", dir: "desc" })
})

it("marks the sorted column and clears the sort after its second direction", async () => {
  const { onSort } = renderTable({ sort: { key: "size", dir: "asc" } })
  const size = screen.getByRole("columnheader", { name: /Size/ })
  expect(size).toHaveAttribute("aria-sort", "ascending")
  expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "none")
  await userEvent.setup().click(within(size).getByRole("button"))
  expect(onSort).toHaveBeenCalledWith(null)
})

it("selects all, shows a partial selection, and clears a full one", async () => {
  const user = userEvent.setup()
  const first = renderTable({ selectedCount: 1 })
  const all = screen.getByRole("checkbox", { name: "Select all" })
  expect(all).toHaveAttribute("data-state", "indeterminate")
  await user.click(all)
  expect(first.onSelectAll).toHaveBeenCalled()
})

it("clears when everything is selected, and reads Deleted in the Trash", async () => {
  const { onClearSelection } = renderTable({ selectedCount: 2, trash: true })
  expect(screen.getByRole("columnheader", { name: /Deleted/ })).toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole("checkbox", { name: "Select all" }))
  expect(onClearSelection).toHaveBeenCalled()
})

it("disables select-all for an empty view", () => {
  renderTable({ entries: [], totalInView: 0 })
  expect(screen.getByRole("checkbox", { name: "Select all" })).toBeDisabled()
})
