/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesBulkBar } from "./files-bulk-bar"

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

beforeEach(() => useFilesLibraryStore.setState({ moveTarget: null, deleteForeverTarget: null }))

const two = () => [entry(), entry({ key: "artifact:b", sourceId: "b", favoritedAt: 1 })]

it("renders nothing without a selection", () => {
  render(
    <FilesBulkBar
      selected={[]}
      folders={[]}
      trash={false}
      actions={actions()}
      onClear={jest.fn()}
    />
  )
  expect(screen.queryByRole("toolbar")).toBeNull()
})

it("favorites, moves, exports, shares and trashes the whole selection", async () => {
  const a = actions()
  const onClear = jest.fn()
  const selected = two()
  render(
    <FilesBulkBar selected={selected} folders={[]} trash={false} actions={a} onClear={onClear} />
  )
  expect(screen.getByRole("toolbar", { name: "Selected items" })).toHaveTextContent("2 selected")
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Add to favorites" }))
  expect(a.setFavorite).toHaveBeenCalledWith(selected, true)
  await user.click(screen.getByRole("button", { name: "Move to folder…" }))
  expect(useFilesLibraryStore.getState().moveTarget).toEqual(["artifact:a", "artifact:b"])
  await user.click(screen.getByRole("button", { name: "Download as zip" }))
  expect(a.exportZip).toHaveBeenCalledWith(selected, [])
  await user.click(screen.getByRole("button", { name: "Share…" }))
  expect(useFilesLibraryStore.getState().shareTarget).toEqual(["artifact:a", "artifact:b"])
  await user.click(screen.getByRole("button", { name: "Move to Trash" }))
  expect(a.trash).toHaveBeenCalledWith(selected)
  expect(onClear).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole("button", { name: "Clear selection" }))
  expect(onClear).toHaveBeenCalledTimes(2)
})

it("unfavorites when every selected item is a favorite", async () => {
  const a = actions()
  const selected = [entry({ favoritedAt: 1 })]
  render(
    <FilesBulkBar selected={selected} folders={[]} trash={false} actions={a} onClear={jest.fn()} />
  )
  await userEvent.setup().click(screen.getByRole("button", { name: "Remove from favorites" }))
  expect(a.setFavorite).toHaveBeenCalledWith(selected, false)
})

it("restores or deletes forever in the Trash", async () => {
  const a = actions()
  const onClear = jest.fn()
  const selected = two()
  render(<FilesBulkBar selected={selected} folders={[]} trash actions={a} onClear={onClear} />)
  expect(screen.queryByRole("button", { name: "Move to Trash" })).toBeNull()
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "Delete forever" }))
  expect(useFilesLibraryStore.getState().deleteForeverTarget).toEqual(["artifact:a", "artifact:b"])
  await user.click(screen.getByRole("button", { name: "Restore" }))
  expect(a.restore).toHaveBeenCalledWith(selected)
  expect(onClear).toHaveBeenCalled()
})
