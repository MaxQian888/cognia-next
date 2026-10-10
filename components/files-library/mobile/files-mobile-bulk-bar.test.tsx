/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("@/lib/capacitor/haptics", () => ({ impact: jest.fn(async () => undefined) }))

import { impact } from "@/lib/capacitor/haptics"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesMobileBulkBar, type FilesMobileBulkBarProps } from "./files-mobile-bulk-bar"

function entry(key: string, overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key,
    kind: "artifact",
    sourceId: key,
    title: key,
    sourceTitle: key,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: key,
    ...overrides,
  }
}

function setup(props: Partial<FilesMobileBulkBarProps> = {}) {
  const all: FilesMobileBulkBarProps = {
    selected: [entry("artifact:a"), entry("artifact:b")],
    visibleCount: 3,
    folders: [],
    trash: false,
    actions: {
      setFavorite: jest.fn(async () => {}),
      exportZip: jest.fn(async () => {}),
      trash: jest.fn(async () => {}),
      restore: jest.fn(async () => {}),
    },
    onSelectAll: jest.fn(),
    onClear: jest.fn(),
    onDone: jest.fn(),
    ...props,
  }
  render(<FilesMobileBulkBar {...all} />)
  return all
}

beforeEach(() => {
  useFilesLibraryStore.setState({ moveTarget: null, shareTarget: null, deleteForeverTarget: null })
  jest.mocked(impact).mockClear()
})

it("counts the selection and acts on all of it", () => {
  const props = setup()
  expect(screen.getByTestId("files-mobile-bulk-count")).toHaveTextContent("2 selected")
  fireEvent.click(screen.getByTestId("files-mobile-bulk-favorite"))
  expect(props.actions.setFavorite).toHaveBeenCalledWith(props.selected, true)
  fireEvent.click(screen.getByTestId("files-mobile-bulk-export"))
  expect(props.actions.exportZip).toHaveBeenCalledWith(props.selected, [])
  fireEvent.click(screen.getByTestId("files-mobile-bulk-move"))
  expect(useFilesLibraryStore.getState().moveTarget).toEqual(["artifact:a", "artifact:b"])
  fireEvent.click(screen.getByTestId("files-mobile-bulk-share"))
  expect(useFilesLibraryStore.getState().shareTarget).toEqual(["artifact:a", "artifact:b"])
  expect(impact).toHaveBeenCalledWith("light")
})

it("unfavorites when every selected item is a favorite", () => {
  const selected = [entry("artifact:a", { favoritedAt: 1 }), entry("artifact:b", { favoritedAt: 2 })]
  const props = setup({ selected })
  const button = screen.getByTestId("files-mobile-bulk-favorite")
  expect(button).toHaveTextContent("Unfavorite")
  fireEvent.click(button)
  expect(props.actions.setFavorite).toHaveBeenCalledWith(selected, false)
})

it("ends selection after moving to the Trash", () => {
  const props = setup()
  fireEvent.click(screen.getByTestId("files-mobile-bulk-trash"))
  expect(props.actions.trash).toHaveBeenCalledWith(props.selected)
  expect(props.onDone).toHaveBeenCalled()
})

it("offers Restore and Delete forever in the Trash", () => {
  const props = setup({ trash: true })
  expect(screen.queryByTestId("files-mobile-bulk-favorite")).toBeNull()
  expect(screen.queryByTestId("files-mobile-bulk-share")).toBeNull()
  fireEvent.click(screen.getByTestId("files-mobile-bulk-delete-forever"))
  expect(useFilesLibraryStore.getState().deleteForeverTarget).toEqual(["artifact:a", "artifact:b"])
  fireEvent.click(screen.getByTestId("files-mobile-bulk-restore"))
  expect(props.actions.restore).toHaveBeenCalledWith(props.selected)
  expect(props.onDone).toHaveBeenCalled()
})

it("hints and disables the actions while nothing is selected yet", () => {
  setup({ selected: [] })
  expect(screen.getByTestId("files-mobile-bulk-count")).toHaveTextContent(
    "Tap items to select them"
  )
  for (const id of ["favorite", "move", "share", "export", "trash"]) {
    expect(screen.getByTestId(`files-mobile-bulk-${id}`)).toBeDisabled()
  }
})

it("selects all, clears once everything is selected, and leaves with Done", () => {
  const props = setup()
  fireEvent.click(screen.getByTestId("files-mobile-select-all"))
  expect(props.onSelectAll).toHaveBeenCalled()
  fireEvent.click(screen.getByTestId("files-mobile-select-done"))
  expect(props.onDone).toHaveBeenCalled()
})

it("turns Select all into Clear when the whole view is selected", () => {
  const props = setup({ visibleCount: 2 })
  const button = screen.getByTestId("files-mobile-select-all")
  expect(button).toHaveTextContent("Clear")
  fireEvent.click(button)
  expect(props.onClear).toHaveBeenCalled()
})
