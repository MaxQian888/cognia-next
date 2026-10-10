/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("./files-image-thumb", () => ({
  FilesImageThumb: ({ hash }: { hash: string }) => <div data-testid={`thumb-${hash}`} />,
}))

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { FilesCard, type FilesCardProps } from "./files-card"

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

function renderCard(props: Partial<FilesCardProps> = {}) {
  const a = actions()
  const onSelect = jest.fn()
  const e = props.entry ?? entry()
  const utils = render(
    <FilesCard
      entry={e}
      actions={a}
      previewed={false}
      selected={false}
      selecting={false}
      onSelect={onSelect}
      {...props}
    />
  )
  return { ...utils, a, onSelect, e }
}

it("selects and previews on a plain click, opens on double click or Enter", () => {
  const { a, onSelect, e } = renderCard()
  const card = screen.getByRole("button", { name: "Open Parser" })
  expect(card).toHaveTextContent("Parser")
  expect(card).toHaveTextContent("Modified 2026-09-21")
  expect(card).toHaveAttribute("data-files-key", "artifact:a")
  fireEvent.click(card)
  expect(onSelect).toHaveBeenCalledWith("artifact:a", expect.objectContaining({ ctrlKey: false }))
  expect(a.preview).toHaveBeenCalledWith(e)
  fireEvent.doubleClick(card)
  expect(a.open).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(card, { key: "Enter" })
  expect(a.open).toHaveBeenCalledTimes(2)
})

it("extends the selection with modifiers without previewing", () => {
  const { a, onSelect } = renderCard()
  const card = screen.getByRole("button", { name: "Open Parser" })
  fireEvent.click(card, { metaKey: true })
  fireEvent.click(card, { shiftKey: true })
  expect(onSelect).toHaveBeenCalledTimes(2)
  expect(a.preview).not.toHaveBeenCalled()
  fireEvent.keyDown(card, { key: " " })
  expect(onSelect).toHaveBeenLastCalledWith("artifact:a", {
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
  })
})

it("toggles selection from its checkbox", () => {
  const { a, onSelect } = renderCard({ selected: true, selecting: true })
  const check = screen.getByRole("checkbox", { name: "Select Parser" })
  expect(check).toBeChecked()
  fireEvent.click(check)
  expect(onSelect).toHaveBeenCalledWith("artifact:a", {
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
  })
  expect(a.preview).not.toHaveBeenCalled()
  expect(screen.getByRole("button", { name: "Open Parser" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
})

it("marks favorites, shares, deleted sources, Files uploads and pictures", () => {
  const { rerender, a, onSelect } = renderCard({
    entry: entry({ favoritedAt: 1, originAlive: false, sharedWithMe: true }),
  })
  expect(screen.getByTestId("files-card-favorite")).toBeInTheDocument()
  expect(screen.getByTestId("files-card-shared")).toBeInTheDocument()
  expect(screen.getByTestId("files-card-source-deleted")).toHaveTextContent("Conversation deleted")
  rerender(
    <FilesCard
      entry={entry({
        key: "image:h",
        kind: "image",
        sourceId: "h",
        title: "",
        sessionIds: ["s1", "s2"],
        ownedByFiles: true,
      })}
      actions={a}
      previewed={false}
      selected={false}
      selecting={false}
      onSelect={onSelect}
    />
  )
  expect(screen.getByTestId("thumb-h")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Open Untitled image" })).toBeInTheDocument()
  expect(screen.getByTestId("files-card-used-in")).toHaveTextContent("In 2 conversations")
  expect(screen.getByText("Uploaded to Files")).toBeInTheDocument()
})

it("draws an image upload (a duplicated image) as a picture", () => {
  renderCard({
    entry: entry({
      key: "upload:u",
      kind: "upload",
      sourceId: "u",
      title: "cat.png",
      mediaType: "image/png",
      mediaHash: "original:sha",
      ownedByFiles: true,
    }),
  })
  expect(screen.getByTestId("thumb-original:sha")).toBeInTheDocument()
})

it("in the Trash shows when it was deleted and only previews on double click", () => {
  const { a } = renderCard({ entry: entry({ trashedAt: Date.UTC(2026, 8, 25) }) })
  const card = screen.getByRole("button", { name: "Open Parser" })
  expect(card).toHaveTextContent("Deleted 2026-09-25")
  fireEvent.doubleClick(card)
  expect(a.open).not.toHaveBeenCalled()
  expect(a.preview).toHaveBeenCalled()
})

it("reuses the shared touch-aware reveal policy for the item menu", () => {
  renderCard()
  expect(screen.getByTestId("files-item-menu-artifact:a")).toHaveClass(
    "pointer-coarse:opacity-100",
    "group-focus-within:opacity-100"
  )
})
