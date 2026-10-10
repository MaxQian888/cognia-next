/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesRenameDialog } from "./files-rename-dialog"

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

beforeEach(() => useFilesLibraryStore.setState({ renameTarget: null }))

it("stays closed without a target", () => {
  render(<FilesRenameDialog entries={[entry()]} actions={actions()} />)
  expect(screen.queryByRole("dialog")).toBeNull()
})

it("renames a conversation item in Files only, and says so", async () => {
  const a = actions()
  const e = entry()
  useFilesLibraryStore.setState({ renameTarget: e.key })
  render(<FilesRenameDialog entries={[e]} actions={a} />)
  expect(screen.getByRole("dialog")).toHaveTextContent("keeps its name in its conversation")
  const input = screen.getByLabelText("Name")
  expect(input).toHaveValue("Parser")
  const user = userEvent.setup()
  await user.clear(input)
  await user.type(input, "Pratt parser{Enter}")
  await waitFor(() => expect(a.rename).toHaveBeenCalledWith(e, "Pratt parser"))
  await waitFor(() => expect(useFilesLibraryStore.getState().renameTarget).toBeNull())
})

it("renames the source of a Files upload, selecting the stem", async () => {
  const e = entry({
    key: "upload:u",
    kind: "upload",
    sourceId: "u",
    title: "notes.md",
    ownedByFiles: true,
  })
  useFilesLibraryStore.setState({ renameTarget: e.key })
  render(<FilesRenameDialog entries={[e]} actions={actions()} />)
  expect(screen.getByRole("dialog")).toHaveTextContent("The item itself is renamed.")
  const input = screen.getByLabelText("Name") as HTMLInputElement
  input.blur()
  input.focus()
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5])
})

it("keeps the dialog open when the rename is refused, and closes on an unchanged name", async () => {
  const a = actions()
  a.rename.mockResolvedValueOnce(false)
  const e = entry()
  useFilesLibraryStore.setState({ renameTarget: e.key })
  render(<FilesRenameDialog entries={[e]} actions={a} />)
  const user = userEvent.setup()
  await user.type(screen.getByLabelText("Name"), "2{Enter}")
  await waitFor(() => expect(a.rename).toHaveBeenCalled())
  expect(useFilesLibraryStore.getState().renameTarget).toBe(e.key)
  await user.type(screen.getByLabelText("Name"), "{Backspace}{Enter}")
  await waitFor(() => expect(useFilesLibraryStore.getState().renameTarget).toBeNull())
  expect(a.rename).toHaveBeenCalledTimes(1)
})

it("cannot save an empty name", async () => {
  const e = entry()
  useFilesLibraryStore.setState({ renameTarget: e.key })
  render(<FilesRenameDialog entries={[e]} actions={actions()} />)
  await userEvent.setup().clear(screen.getByLabelText("Name"))
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
})
