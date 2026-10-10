/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, within } from "@testing-library/react"

jest.mock("./files-image-thumb", () => ({
  FilesImageThumb: ({ hash }: { hash: string }) => <div data-testid={`thumb-${hash}`} />,
}))

import { Table, TableBody } from "@/components/ui/table"
import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { FilesRow, type FilesRowProps } from "./files-row"

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

const NOW = Date.UTC(2026, 8, 21, 12)

function renderRow(props: Partial<FilesRowProps> = {}) {
  const a = actions()
  const onSelect = jest.fn()
  const e = props.entry ?? entry()
  const utils = render(
    <Table>
      <TableBody>
        <FilesRow
          entry={e}
          actions={a}
          previewed={false}
          selected={false}
          onSelect={onSelect}
          now={NOW}
          {...props}
        />
      </TableBody>
    </Table>
  )
  return { ...utils, a, onSelect, e }
}

it("shows name, source, last activity, size and type", () => {
  renderRow({
    entry: entry({
      originSessionId: "s1",
      originSessionTitle: "Refactor parser",
      byteSize: 2048,
      updatedAt: NOW - 4 * 60 * 60 * 1000,
    }),
  })
  const row = screen.getByRole("row", { name: "Open Parser" })
  expect(row).toHaveAttribute("data-files-key", "artifact:a")
  expect(row).toHaveTextContent("Parser")
  expect(row).toHaveTextContent("Refactor parser")
  expect(row).toHaveTextContent("4h ago")
  expect(row).toHaveTextContent("2.0 KB")
  expect(row).toHaveTextContent("Code")
})

it("jumps to the source conversation without selecting the row", () => {
  const { a, onSelect } = renderRow({
    entry: entry({ originSessionId: "s1", originSessionTitle: "Refactor parser" }),
  })
  fireEvent.click(screen.getByTestId("files-row-source-artifact:a"))
  expect(a.goToConversation).toHaveBeenCalledWith("s1")
  expect(onSelect).not.toHaveBeenCalled()
})

it("names the source of an upload, or none", () => {
  const { rerender, a, onSelect } = renderRow({ entry: entry({ ownedByFiles: true }) })
  expect(screen.getByRole("row")).toHaveTextContent("Uploaded")
  rerender(
    <Table>
      <TableBody>
        <FilesRow
          entry={entry()}
          actions={a}
          previewed={false}
          selected={false}
          onSelect={onSelect}
          now={NOW}
        />
      </TableBody>
    </Table>
  )
  expect(screen.getByLabelText("No conversation")).toBeInTheDocument()
})

it("selects and previews on click, extends with modifiers, opens on double click", () => {
  const { a, onSelect, e } = renderRow()
  const row = screen.getByRole("row", { name: "Open Parser" })
  fireEvent.click(row)
  expect(a.preview).toHaveBeenCalledWith(e)
  fireEvent.click(row, { shiftKey: true })
  expect(a.preview).toHaveBeenCalledTimes(1)
  expect(onSelect).toHaveBeenCalledTimes(2)
  fireEvent.doubleClick(row)
  expect(a.open).toHaveBeenCalledWith(e)
  fireEvent.keyDown(row, { key: "Enter" })
  expect(a.open).toHaveBeenCalledTimes(2)
  fireEvent.keyDown(row, { key: " " })
  expect(onSelect).toHaveBeenLastCalledWith("artifact:a", {
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
  })
})

it("toggles from its checkbox and reflects selection", () => {
  const { onSelect, a } = renderRow({ selected: true, previewed: true })
  const row = screen.getByRole("row", { name: "Open Parser" })
  expect(row).toHaveAttribute("aria-selected", "true")
  expect(row).toHaveAttribute("data-previewed", "true")
  fireEvent.click(within(row).getByRole("checkbox", { name: "Select Parser" }))
  expect(onSelect).toHaveBeenCalledWith("artifact:a", {
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
  })
  expect(a.preview).not.toHaveBeenCalled()
})

it("marks favorites, shares and deleted sources; draws pictures", () => {
  renderRow({
    entry: entry({
      key: "image:h",
      kind: "image",
      sourceId: "h",
      title: "photo.png",
      favoritedAt: 1,
      sharedWithMe: true,
      originAlive: false,
    }),
  })
  expect(screen.getByLabelText("Favorite")).toBeInTheDocument()
  expect(screen.getByLabelText("Shared with you")).toBeInTheDocument()
  expect(screen.getByText("Conversation deleted")).toBeInTheDocument()
  expect(screen.getByTestId("thumb-h")).toBeInTheDocument()
})

it("in the Trash dates the row by when it went in and previews instead of opening", () => {
  const { a } = renderRow({ entry: entry({ trashedAt: NOW - 2 * 24 * 60 * 60 * 1000 }) })
  const row = screen.getByRole("row", { name: "Open Parser" })
  expect(row).toHaveTextContent("2d ago")
  fireEvent.doubleClick(row)
  expect(a.open).not.toHaveBeenCalled()
  expect(a.preview).toHaveBeenCalled()
})

it("reads an item newer than the view's minute clock as now, never in the future", () => {
  renderRow({ entry: entry({ updatedAt: NOW + 30_000 }) })
  const row = screen.getByRole("row", { name: "Open Parser" })
  expect(row).toHaveTextContent("now")
  expect(row).not.toHaveTextContent(/in \d+s/)
})
