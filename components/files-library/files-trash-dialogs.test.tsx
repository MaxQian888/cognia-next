/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesTrashDialogs } from "./files-trash-dialogs"

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

const trashed = [
  entry({ trashedAt: 1 }),
  entry({ key: "artifact:b", sourceId: "b", title: "Lexer", trashedAt: 2 }),
  entry({ key: "artifact:live", sourceId: "live", title: "Live" }),
]

beforeEach(() =>
  useFilesLibraryStore.setState({ deleteForeverTarget: null, emptyTrashOpen: false })
)

it("confirms deleting one item forever and explains what that means", async () => {
  const a = actions()
  const onDeleted = jest.fn()
  useFilesLibraryStore.setState({ deleteForeverTarget: ["artifact:a"] })
  render(<FilesTrashDialogs entries={trashed} actions={a} onDeleted={onDeleted} />)
  const dialog = screen.getByRole("alertdialog")
  expect(dialog).toHaveTextContent("Delete “Parser” forever?")
  expect(dialog).toHaveTextContent("only leaves Files")
  await userEvent.setup().click(screen.getByRole("button", { name: "Delete forever" }))
  expect(a.deleteForever).toHaveBeenCalledWith([trashed[0]])
  expect(onDeleted).toHaveBeenCalled()
  expect(useFilesLibraryStore.getState().deleteForeverTarget).toBeNull()
})

it("counts several items and never deletes one that left the Trash", async () => {
  const a = actions()
  useFilesLibraryStore.setState({
    deleteForeverTarget: ["artifact:a", "artifact:b", "artifact:live"],
  })
  render(<FilesTrashDialogs entries={trashed} actions={a} />)
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete 2 items forever?")
  await userEvent.setup().click(screen.getByRole("button", { name: "Delete forever" }))
  expect(a.deleteForever).toHaveBeenCalledWith([trashed[0], trashed[1]])
})

it("empties the whole Trash", async () => {
  const a = actions()
  useFilesLibraryStore.setState({ emptyTrashOpen: true })
  render(<FilesTrashDialogs entries={trashed} actions={a} />)
  expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete 2 items in the Trash forever?")
  await userEvent.setup().click(screen.getByRole("button", { name: "Empty Trash" }))
  expect(a.deleteForever).toHaveBeenCalledWith([trashed[0], trashed[1]])
  expect(useFilesLibraryStore.getState().emptyTrashOpen).toBe(false)
})

it("cancels without deleting", async () => {
  const a = actions()
  useFilesLibraryStore.setState({ deleteForeverTarget: ["artifact:a"] })
  render(<FilesTrashDialogs entries={trashed} actions={a} />)
  await userEvent.setup().click(screen.getByRole("button", { name: "Cancel" }))
  expect(a.deleteForever).not.toHaveBeenCalled()
  expect(useFilesLibraryStore.getState().deleteForeverTarget).toBeNull()
})
