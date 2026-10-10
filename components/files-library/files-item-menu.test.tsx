/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

let mockTemplatesEnabled = true
jest.mock("@/lib/templates/feature-flags", () => ({
  isUnifiedTemplatePlatformEnabled: () => mockTemplatesEnabled,
}))

import type { FilesActions } from "@/hooks/files-library/use-files-actions"
import type { FilesEntry } from "@/lib/files-library/types"
import { useFilesLibraryStore } from "@/stores/files-library"
import { FilesItemContextMenu, FilesItemMenu } from "./files-item-menu"

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

beforeEach(() => {
  mockTemplatesEnabled = true
  useFilesLibraryStore.setState({
    moveTarget: null,
    renameTarget: null,
    deleteForeverTarget: null,
    saveTemplateTarget: null,
  })
})

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
    ["Duplicate", a.duplicate],
    ["Download", a.download],
  ] as const) {
    user = await openMenu()
    await user.click(screen.getByRole("menuitem", { name }))
    expect(fn).toHaveBeenCalledWith(e)
  }
  user = await openMenu()
  await user.click(screen.getByRole("menuitem", { name: "Move to Trash" }))
  expect(a.trash).toHaveBeenCalledWith([e])
  user = await openMenu()
  await user.click(screen.getByRole("menuitem", { name: "Move to folder…" }))
  expect(useFilesLibraryStore.getState().moveTarget).toEqual(["artifact:a"])
  user = await openMenu()
  await user.click(screen.getByRole("menuitem", { name: /^Rename…/ }))
  expect(useFilesLibraryStore.getState().renameTarget).toBe("artifact:a")
  await openMenu()
  expect(screen.queryByRole("menuitem", { name: "Take out of folder" })).toBeNull()
  expect(screen.queryByRole("menuitem", { name: "Restore" })).toBeNull()
})

it("keeps Share inert until file snapshots exist", async () => {
  render(<FilesItemMenu entry={entry()} title="Parser" actions={actions()} />)
  await openMenu()
  const share = screen.getByRole("menuitem", { name: /^Share…/ })
  expect(share).toHaveAttribute("aria-disabled", "true")
  expect(share).toHaveTextContent("Coming soon")
})

it("offers unfile for a filed favorite", async () => {
  const a = actions()
  const e = entry({ folderId: "root", favoritedAt: 1 })
  render(<FilesItemMenu entry={e} title="Parser" actions={a} />)
  const user = await openMenu()
  expect(screen.getByRole("menuitem", { name: "Remove from favorites" })).toBeInTheDocument()
  await user.click(screen.getByRole("menuitem", { name: "Take out of folder" }))
  expect(a.moveToFolder).toHaveBeenCalledWith([e], null)
})

it("offers only preview, restore and delete forever in the Trash", async () => {
  const a = actions()
  const e = entry({ trashedAt: 5 })
  render(<FilesItemMenu entry={e} title="Parser" actions={a} />)
  let user = await openMenu()
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
    "Preview",
    "Restore",
    "Delete forever",
  ])
  await user.click(screen.getByRole("menuitem", { name: "Restore" }))
  expect(a.restore).toHaveBeenCalledWith([e])
  user = await openMenu()
  await user.click(screen.getByRole("menuitem", { name: "Delete forever" }))
  expect(useFilesLibraryStore.getState().deleteForeverTarget).toEqual(["artifact:a"])
})

it("opens the same entries on right-click", async () => {
  const a = actions()
  const e = entry()
  render(
    <FilesItemContextMenu entry={e} actions={a}>
      <div data-testid="target">Parser</div>
    </FilesItemContextMenu>
  )
  fireEvent.contextMenu(screen.getByTestId("target"))
  const items = await screen.findAllByRole("menuitem")
  expect(items.map((item) => item.textContent?.replace(/F2|Coming soon/, ""))).toEqual([
    "Open",
    "Preview",
    "Use in chat",
    "Add to favorites",
    "Move to folder…",
    "Rename…",
    "Duplicate",
    "Save as template…",
    "Download",
    "Share…",
    "Move to Trash",
  ])
  await userEvent.setup().click(screen.getByRole("menuitem", { name: "Use in chat" }))
  expect(a.useInChat).toHaveBeenCalledWith(e)
})

it("saves documents as templates, only while the template platform is on", async () => {
  const { unmount } = render(<FilesItemMenu entry={entry()} title="Parser" actions={actions()} />)
  const user = await openMenu()
  await user.click(screen.getByRole("menuitem", { name: "Save as template…" }))
  expect(useFilesLibraryStore.getState().saveTemplateTarget).toBe("artifact:a")
  unmount()

  mockTemplatesEnabled = false
  render(<FilesItemMenu entry={entry()} title="Parser" actions={actions()} />)
  await openMenu()
  expect(screen.queryByRole("menuitem", { name: "Save as template…" })).toBeNull()
})

it("offers no template entry for images and files", async () => {
  render(
    <FilesItemMenu
      entry={entry({ key: "upload:u", kind: "upload", sourceId: "u" })}
      title="Parser"
      actions={actions()}
    />
  )
  await openMenu()
  expect(screen.queryByRole("menuitem", { name: "Save as template…" })).toBeNull()
})
