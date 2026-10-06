/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"

jest.mock("./files-image-thumb", () => ({
  FilesImageThumb: ({ hash }: { hash: string }) => <div data-testid={`thumb-${hash}`} />,
}))

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { FilesRow } from "./files-row"

function entry(overrides: Partial<FilesEntry> = {}): FilesEntry {
  return {
    key: "upload:u",
    kind: "upload",
    sourceId: "u",
    title: "SPEC.md",
    byteSize: 2048,
    projectIds: [],
    sessionIds: [],
    originAlive: true,
    createdAt: 1,
    updatedAt: 1,
    ownedByFiles: true,
    hidden: false,
    searchText: "",
    ...overrides,
  }
}

const actions = () =>
  ({ open: jest.fn(async () => {}), preview: jest.fn() }) as unknown as jest.Mocked<FilesActions>

it("shows kind, size and shares, and routes clicks like the card", () => {
  const a = actions()
  const e = entry({ sessionIds: ["s1", "s2"], favoritedAt: 2 })
  render(<FilesRow entry={e} actions={a} selected={false} />)
  const row = screen.getByRole("button", { name: "Open SPEC.md" })
  expect(row).toHaveTextContent("File")
  expect(row).toHaveTextContent("2.0 KB")
  expect(row).toHaveTextContent("In 2 conversations")
  expect(screen.getByLabelText("Favorite")).toBeInTheDocument()
  fireEvent.click(row)
  expect(a.preview).toHaveBeenCalledWith(e)
  fireEvent.keyDown(row, { key: "Enter" })
  fireEvent.doubleClick(row)
  expect(a.open).toHaveBeenCalledTimes(2)
  fireEvent.keyDown(row, { key: " " })
  expect(a.preview).toHaveBeenCalledTimes(2)
})

it("thumbnails images and flags a deleted conversation", () => {
  render(
    <FilesRow
      entry={entry({
        key: "image:h",
        kind: "image",
        sourceId: "h",
        originAlive: false,
        ownedByFiles: false,
      })}
      actions={actions()}
      selected
    />
  )
  expect(screen.getByTestId("thumb-h")).toBeInTheDocument()
  expect(screen.getByText("Conversation deleted")).toBeInTheDocument()
})

it("labels an uploaded video as a video", () => {
  render(
    <FilesRow
      entry={entry({ title: "A paper boat.mp4", mediaType: "video/mp4" })}
      actions={actions()}
      selected={false}
    />
  )
  expect(screen.getByRole("button", { name: "Open A paper boat.mp4" })).toHaveTextContent("Video")
})

it("reuses the shared touch-aware reveal policy for the item menu", () => {
  render(<FilesRow entry={entry()} actions={actions()} selected={false} />)
  expect(screen.getByTestId("files-item-menu-upload:u")).toHaveClass(
    "pointer-coarse:opacity-100",
    "group-focus-within:opacity-100"
  )
})
