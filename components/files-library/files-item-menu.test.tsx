/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesItemMenu } from "./files-item-menu"

function entry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: "artifact:a",
    kind: "artifact",
    sourceId: "a",
    title: "Parser",
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    searchText: "",
    ...overrides,
  }
}

function actions(): jest.Mocked<FilesActions> {
  return {
    open: jest.fn(async (_entry: FilesEntry) => {}),
    preview: jest.fn((_entry: FilesEntry) => {}),
    toggleFavorite: jest.fn(async (_entry: FilesEntry) => {}),
    moveToFolder: jest.fn(async (_entries: readonly FilesEntry[], _folderId: string | null) => {}),
    remove: jest.fn(async (_entry: FilesEntry) => {}),
    deleteOwned: jest.fn(async (_entry: FilesEntry) => {}),
    download: jest.fn(async (_entry: FilesEntry) => {}),
    useInChat: jest.fn(async (_entry: FilesEntry) => {}),
    upload: jest.fn(async (_files: readonly File[]) => {}),
    newCanvasDocument: jest.fn(() => {}),
  }
}

beforeEach(() => useFilesLibraryStore.setState({ moveTarget: null, deleteTarget: null }))

async function openMenu() {
  const user = userEvent.setup()
  await user.click(screen.getByRole("button", { name: "More actions for Parser" }))
  return user
}

it("runs each action for a conversation item", async () => {
  const a = actions()
  const e = entry()
  render(<FilesItemMenu entry={e} title="Parser" actions={a} />)
  let user = await openMenu()
  await user.click(screen.getByRole("menuitem", { name: "Open" }))
  expect(a.open).toHaveBeenCalledWith(e)
  for (const [name, fn] of [
    ["Preview", a.preview],
    ["Use in chat", a.useInChat],
    ["Add to favorites", a.toggleFavorite],
    ["Download", a.download],
    ["Remove from Files", a.remove],
  ] as const) {
    user = await openMenu()
    await user.click(screen.getByRole("menuitem", { name }))
    expect(fn).toHaveBeenCalledWith(e)
  }
  user = await openMenu()
  await user.click(screen.getByRole("menuitem", { name: "Move to folder…" }))
  expect(useFilesLibraryStore.getState().moveTarget).toEqual(["artifact:a"])
  user = await openMenu()
  expect(screen.queryByRole("menuitem", { name: "Delete" })).toBeNull()
  expect(screen.queryByRole("menuitem", { name: "Take out of folder" })).toBeNull()
})

it("offers delete for a Files upload and unfile for a filed favorite", async () => {
  const a = actions()
  const e = entry({
    key: "upload:u",
    kind: "upload",
    ownedByFiles: true,
    folderId: "root",
    favoritedAt: 1,
  })
  render(<FilesItemMenu entry={e} title="Parser" actions={a} />)
  let user = await openMenu()
  expect(screen.getByRole("menuitem", { name: "Remove from favorites" })).toBeInTheDocument()
  expect(screen.queryByRole("menuitem", { name: "Remove from Files" })).toBeNull()
  await user.click(screen.getByRole("menuitem", { name: "Delete" }))
  expect(useFilesLibraryStore.getState().deleteTarget).toBe("upload:u")
  user = await openMenu()
  await user.click(screen.getByRole("menuitem", { name: "Take out of folder" }))
  expect(a.moveToFolder).toHaveBeenCalledWith([e], null)
})
