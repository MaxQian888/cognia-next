/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("./files-image-thumb", () => ({
  FilesImageThumb: ({ hash }: { hash: string }) => <div data-testid={`thumb-${hash}`} />,
}))

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { FilesCard } from "./files-card"

function entry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: "artifact:a",
    kind: "artifact",
    sourceId: "a",
    title: "Parser",
    subtype: "code",
    projectIds: [],
    sessionIds: ["s1"],
    originAlive: true,
    createdAt: 1,
    updatedAt: Date.UTC(2026, 8, 21),
    ownedByFiles: false,
    hidden: false,
    searchText: "",
    ...overrides,
  }
}

function actions() {
  return {
    open: jest.fn(async () => {}),
    preview: jest.fn(),
  } as unknown as jest.Mocked<FilesActions>
}

it("previews on click and opens on double click or Enter", () => {
  const a = actions()
  const e = entry()
  render(<FilesCard entry={e} actions={a} selected={false} />)
  const card = screen.getByRole("button", { name: "Open Parser" })
  expect(card).toHaveTextContent("Parser")
  expect(card).toHaveTextContent("Modified 2026-09-21")
  fireEvent.click(card)
  expect(a.preview).toHaveBeenCalledWith(e)
  fireEvent.doubleClick(card)
  expect(a.open).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(card, { key: "Enter" })
  expect(a.open).toHaveBeenCalledTimes(2)
  fireEvent.keyDown(card, { key: " " })
  expect(a.preview).toHaveBeenCalledTimes(2)
})

it("marks favorites, deleted sources, Files uploads and shared images", () => {
  const { rerender } = render(
    <FilesCard entry={entry({ favoritedAt: 1, originAlive: false })} actions={actions()} selected />
  )
  expect(screen.getByTestId("files-card-favorite")).toBeInTheDocument()
  expect(screen.getByTestId("files-card-source-deleted")).toHaveTextContent("Conversation deleted")
  expect(screen.getByRole("button", { name: "Open Parser" })).toHaveAttribute(
    "aria-pressed",
    "true"
  )
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
      actions={actions()}
      selected={false}
    />
  )
  expect(screen.getByTestId("thumb-h")).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Open Untitled image" })).toBeInTheDocument()
  expect(screen.getByTestId("files-card-used-in")).toHaveTextContent("In 2 conversations")
  expect(screen.getByText("Uploaded to Files")).toBeInTheDocument()
})

it("reuses the shared touch-aware reveal policy for the item menu", () => {
  render(<FilesCard entry={entry()} actions={actions()} selected={false} />)
  expect(screen.getByTestId("files-item-menu-artifact:a")).toHaveClass(
    "pointer-coarse:opacity-100",
    "group-focus-within:opacity-100"
  )
})
