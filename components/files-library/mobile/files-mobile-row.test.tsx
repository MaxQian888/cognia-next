/**
 * @jest-environment jsdom
 */
import "@/components/interactions/test-pointer-polyfill"
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("../files-image-thumb", () => ({
  // The entry tells a paired device's thumbnail where the bytes live.
  FilesImageThumb: ({ hash, entry }: { hash: string; entry?: { key: string } }) => (
    <div data-testid={`thumb-${hash}`} data-entry={entry?.key} />
  ),
}))
// The long-press haptic is a Capacitor call.
jest.mock("@/lib/capacitor/haptics", () => ({ impact: jest.fn(async () => undefined) }))

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { FilesMobileRow, type FilesMobileRowProps } from "./files-mobile-row"

const NOW = Date.UTC(2026, 8, 21, 12)

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
    originSessionTitle: "Roadmap chat",
    createdAt: 1,
    updatedAt: NOW - 2 * 3_600_000,
    ownedByFiles: false,
    hidden: false,
    sharedWithMe: false,
    creator: "user",
    searchText: "",
    byteSize: 2048,
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

function setup(props: Partial<FilesMobileRowProps> = {}) {
  const all: FilesMobileRowProps = {
    entry: entry(),
    actions: actions(),
    selecting: false,
    selected: false,
    previewed: false,
    onStartSelecting: jest.fn(),
    onToggle: jest.fn(),
    now: NOW,
    ...props,
  }
  render(
    <ul>
      <FilesMobileRow {...all} />
    </ul>
  )
  return all
}

it("draws two lines: the name and markers, then source, size and format", () => {
  setup({ entry: entry({ favoritedAt: 5, sharedLinks: 2 }) })
  expect(screen.getByText("Parser")).toBeInTheDocument()
  expect(screen.getByLabelText("Favorite")).toBeInTheDocument()
  expect(screen.getByTestId("files-mobile-shared-link")).toHaveAccessibleName(
    "Shared by 2 links"
  )
  expect(screen.getByTestId("files-mobile-details-artifact:a")).toHaveTextContent(
    "Roadmap chat · 2.0 KB · Code"
  )
  expect(screen.getByTestId("files-mobile-activity-artifact:a")).toHaveTextContent(/2.*h/)
})

it("says a Files upload was uploaded, and when a trashed item was deleted", () => {
  setup({
    entry: entry({
      kind: "upload",
      key: "upload:u",
      originSessionTitle: undefined,
      ownedByFiles: true,
      trashedAt: NOW - 3_600_000,
      byteSize: undefined,
      mediaType: "text/markdown",
      title: "notes.md",
    }),
  })
  expect(screen.getByTestId("files-mobile-details-upload:u").textContent).toMatch(/^Uploaded · /)
  expect(screen.getByTestId("files-mobile-activity-upload:u")).toHaveTextContent(/^Deleted /)
})

it("marks an item whose conversation is gone", () => {
  setup({ entry: entry({ originAlive: false }) })
  expect(screen.getByText("Conversation deleted")).toBeInTheDocument()
})

it("previews on a tap", () => {
  const props = setup()
  fireEvent.click(screen.getByTestId("files-mobile-open-artifact:a"))
  expect(props.actions.preview).toHaveBeenCalledWith(props.entry)
  expect(props.onToggle).not.toHaveBeenCalled()
})

it("toggles on a tap while selecting, and draws the check", () => {
  const props = setup({ selecting: true, selected: true })
  const open = screen.getByRole("button", { name: "Select Parser" })
  expect(open).toHaveAttribute("aria-pressed", "true")
  expect(screen.getByTestId("files-mobile-check-artifact:a")).toHaveAttribute(
    "data-state",
    "checked"
  )
  fireEvent.click(open)
  expect(props.onToggle).toHaveBeenCalledWith("artifact:a")
  expect(props.actions.preview).not.toHaveBeenCalled()
})

it("starts selecting on a long-press, without also previewing", () => {
  jest.useFakeTimers()
  try {
    const props = setup()
    const open = screen.getByTestId("files-mobile-open-artifact:a")
    fireEvent.pointerDown(open, { pointerType: "touch", button: 0, clientX: 5, clientY: 5 })
    act(() => {
      jest.advanceTimersByTime(600)
    })
    expect(props.onStartSelecting).toHaveBeenCalledWith("artifact:a")
    fireEvent.pointerUp(open)
    fireEvent.click(open)
    expect(props.actions.preview).not.toHaveBeenCalled()
  } finally {
    jest.useRealTimers()
  }
})

it("offers Select ahead of the item's own menu, and only outside selection", async () => {
  const user = userEvent.setup()
  const props = setup()
  await user.click(screen.getByTestId("files-item-menu-artifact:a"))
  expect(await screen.findByTestId("files-action-open")).toBeInTheDocument()
  await user.click(screen.getByTestId("files-action-select"))
  expect(props.onStartSelecting).toHaveBeenCalledWith("artifact:a")
})

it("leaves Select out of the menu while selecting", async () => {
  const user = userEvent.setup()
  setup({ selecting: true })
  await user.click(screen.getByTestId("files-item-menu-artifact:a"))
  expect(await screen.findByTestId("files-action-open")).toBeInTheDocument()
  expect(screen.queryByTestId("files-action-select")).toBeNull()
})

it("gives the menu button a 44px target", () => {
  setup()
  expect(screen.getByTestId("files-item-menu-artifact:a")).toHaveClass("size-11")
})

it("draws an image from its bytes, telling the thumbnail which entry they belong to", () => {
  setup({ entry: entry({ key: "image:h", kind: "image", sourceId: "h" }) })
  expect(screen.getByTestId("thumb-h")).toHaveAttribute("data-entry", "image:h")
})
