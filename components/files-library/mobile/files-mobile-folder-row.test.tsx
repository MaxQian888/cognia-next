/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { LibraryFolder } from "@/lib/db/files-library-types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesMobileFolderRow } from "./files-mobile-folder-row"

const NOW = Date.UTC(2026, 8, 21, 12)

const folder: LibraryFolder = {
  id: "f1",
  name: "Research",
  parentFolderId: "root",
  createdAt: 1,
  updatedAt: NOW - 3 * 86_400_000,
}

function setup() {
  const actions = { setFolderStyle: jest.fn(async () => {}) }
  render(
    <ul>
      <FilesMobileFolderRow folder={folder} itemCount={4} actions={actions} now={NOW} />
    </ul>
  )
  return actions
}

beforeEach(() => {
  useFilesLibraryStore.setState({
    section: { kind: "folder", folderId: "root" },
    expandedFolderIds: [],
    folderDialog: null,
  })
})

it("shows the folder's name, item count and age", () => {
  setup()
  expect(screen.getByText("Research")).toBeInTheDocument()
  expect(screen.getByText("4 items")).toBeInTheDocument()
  expect(screen.getByText(/3.*d/)).toBeInTheDocument()
})

it("opens the folder on a tap and keeps it expanded in the tree", () => {
  setup()
  fireEvent.click(screen.getByRole("button", { name: "Open folder Research" }))
  const state = useFilesLibraryStore.getState()
  expect(state.section).toEqual({ kind: "folder", folderId: "f1" })
  expect(state.expandedFolderIds).toContain("f1")
})

it("carries the folder's own menu on a 44px button", async () => {
  const user = userEvent.setup()
  setup()
  const trigger = screen.getByTestId("files-folder-item-menu-f1")
  expect(trigger).toHaveClass("size-11")
  await user.click(trigger)
  await user.click(await screen.findByTestId("files-folder-action-rename"))
  expect(useFilesLibraryStore.getState().folderDialog).toMatchObject({ mode: "rename" })
})
