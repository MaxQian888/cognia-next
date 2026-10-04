/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

jest.mock("next-intl", () => ({
  useTranslations: () => (key: string, vars?: Record<string, unknown>) =>
    vars ? `${key}:${JSON.stringify(vars)}` : key,
}))

import { ChannelListBulkToolbar } from "./channel-list-bulk-toolbar"

function setup(overrides: Partial<Parameters<typeof ChannelListBulkToolbar>[0]> = {}) {
  const onDelete = jest.fn()
  const onPin = jest.fn()
  const onUnpin = jest.fn()
  const onArchive = jest.fn()
  const onUnarchive = jest.fn()
  const onShare = jest.fn()
  const onClear = jest.fn()
  const utils = render(
    <ChannelListBulkToolbar
      count={3}
      onDelete={onDelete}
      onPin={onPin}
      onUnpin={onUnpin}
      onArchive={onArchive}
      onUnarchive={onUnarchive}
      onShare={onShare}
      onClear={onClear}
      {...overrides}
    />
  )
  return { ...utils, onDelete, onPin, onUnpin, onArchive, onUnarchive, onShare, onClear }
}
test("files the selection into a folder, and can take it out of one", async () => {
  const onMoveToFolder = jest.fn()
  const user = userEvent.setup()
  setup({
    folders: [
      { id: "f1", name: "Research" } as never,
      { id: "f2", name: "Archive notes" } as never,
    ],
    onMoveToFolder,
    anyInFolder: true,
  })
  await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
  await user.click(screen.getByTestId("channel-list-bulk-folder-f1"))
  expect(onMoveToFolder).toHaveBeenCalledWith("f1")

  await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
  await user.click(screen.getByTestId("channel-list-bulk-folder-none"))
  expect(onMoveToFolder).toHaveBeenLastCalledWith(null)
})

test("offers Remove from folder only when part of the selection sits in one", async () => {
  const user = userEvent.setup()
  setup({ folders: [{ id: "f1", name: "Research" } as never], onMoveToFolder: jest.fn() })
  await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
  expect(screen.getByTestId("channel-list-bulk-folder-f1")).toBeInTheDocument()
  expect(screen.queryByTestId("channel-list-bulk-folder-none")).toBeNull()
})

test("makes a new folder for the selection, even before any folder exists", async () => {
  const onNewFolder = jest.fn()
  const user = userEvent.setup()
  setup({ folders: [], onMoveToFolder: jest.fn(), onNewFolder })
  await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
  await user.click(screen.getByTestId("channel-list-bulk-folder-new"))
  expect(onNewFolder).toHaveBeenCalledTimes(1)
})

test("drops the folder control when it has nowhere to send the selection", () => {
  // No folders, nothing filed, no way to make one: the menu would hold only a
  // no-op.
  setup({ folders: [], onMoveToFolder: jest.fn() })
  expect(screen.queryByTestId("channel-list-bulk-move-to-folder")).toBeNull()
})

test("lists a folder that cannot take the selection as disabled, with the reason", async () => {
  const onMoveToFolder = jest.fn()
  const user = userEvent.setup()
  setup({
    folders: [{ id: "f1", name: "Research" } as never, { id: "f2", name: "Elsewhere" } as never],
    blockedFolderIds: new Set(["f2"]),
    onMoveToFolder,
  })
  await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
  expect(screen.getByTestId("channel-list-bulk-folder-blocked-note")).toHaveTextContent(
    "folderOtherWorkspace"
  )
  const blocked = screen.getByTestId("channel-list-bulk-folder-f2")
  expect(blocked).toHaveAttribute("data-disabled")
  await user.click(blocked)
  expect(onMoveToFolder).not.toHaveBeenCalled()
  await user.click(screen.getByTestId("channel-list-bulk-folder-f1"))
  expect(onMoveToFolder).toHaveBeenCalledWith("f1")
})

test("says nothing about workspaces when every folder can take the selection", async () => {
  const user = userEvent.setup()
  setup({ folders: [{ id: "f1", name: "Research" } as never], onMoveToFolder: jest.fn() })
  await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
  expect(screen.queryByTestId("channel-list-bulk-folder-blocked-note")).toBeNull()
})

test("hides the folder control without a handler, and in the archived view", () => {
  const { unmount } = setup()
  expect(screen.queryByTestId("channel-list-bulk-move-to-folder")).toBeNull()
  unmount()
  // Archived conversations live in date buckets, not folders.
  setup({ archived: true, onMoveToFolder: jest.fn() })
  expect(screen.queryByTestId("channel-list-bulk-move-to-folder")).toBeNull()
})

test("renders the i18n'd count with the selection size", () => {
  setup({ count: 5 })
  // The mock translation echoes `key:{json}` — confirms `count` was passed through.
  expect(screen.getAllByText(/selectedCount:\{"count":5\}/).length).toBeGreaterThan(0)
})

test("offers Pin for a selection that is not all pinned, and only Pin", async () => {
  const user = userEvent.setup()
  const { onPin, onUnpin } = setup()
  expect(screen.queryByRole("button", { name: "unpin" })).toBeNull()
  await user.click(screen.getByRole("button", { name: "pin" }))
  expect(onPin).toHaveBeenCalledTimes(1)
  expect(onUnpin).not.toHaveBeenCalled()
})

test("offers Unpin once every selected row is pinned", async () => {
  const user = userEvent.setup()
  const { onPin, onUnpin } = setup({ allPinned: true })
  expect(screen.queryByRole("button", { name: "pin" })).toBeNull()
  await user.click(screen.getByRole("button", { name: "unpin" }))
  expect(onUnpin).toHaveBeenCalledTimes(1)
  expect(onPin).not.toHaveBeenCalled()
})

test("points the read switch at the direction that changes something", async () => {
  const onMarkRead = jest.fn()
  const onMarkUnread = jest.fn()
  const user = userEvent.setup()
  const { unmount } = setup({ onMarkRead, onMarkUnread, anyUnread: true })
  expect(screen.queryByTestId("channel-list-bulk-mark-unread")).toBeNull()
  await user.click(screen.getByTestId("channel-list-bulk-mark-read"))
  expect(onMarkRead).toHaveBeenCalledTimes(1)
  unmount()
  setup({ onMarkRead, onMarkUnread, anyUnread: false })
  expect(screen.queryByTestId("channel-list-bulk-mark-read")).toBeNull()
  await user.click(screen.getByTestId("channel-list-bulk-mark-unread"))
  expect(onMarkUnread).toHaveBeenCalledTimes(1)
})

test("grows the selection to every row, then offers to empty it", async () => {
  const onSelectAll = jest.fn()
  const onDeselectAll = jest.fn()
  const user = userEvent.setup()
  const { unmount } = setup({ count: 2, total: 7, onSelectAll, onDeselectAll })
  await user.click(screen.getByTestId("channel-list-bulk-select-all"))
  expect(onSelectAll).toHaveBeenCalledTimes(1)
  expect(screen.getByTestId("channel-list-bulk-select-all")).toHaveTextContent(
    'selectAll:{"count":7}'
  )
  expect(screen.queryByTestId("channel-list-bulk-deselect-all")).toBeNull()
  unmount()
  setup({ count: 7, total: 7, onSelectAll, onDeselectAll })
  expect(screen.queryByTestId("channel-list-bulk-select-all")).toBeNull()
  await user.click(screen.getByTestId("channel-list-bulk-deselect-all"))
  expect(onDeselectAll).toHaveBeenCalledTimes(1)
})

test("says how to select while nothing is, keeping its verbs in place but disabled", () => {
  setup({
    count: 0,
    total: 4,
    onMarkRead: jest.fn(),
    onMoveToFolder: jest.fn(),
    onNewFolder: jest.fn(),
  })
  expect(screen.getByTestId("channel-list-bulk-count")).toHaveTextContent("selectHint")
  expect(screen.getByRole("toolbar")).toHaveAttribute("aria-label", "selectHint")
  for (const name of ["share", "pin", "archive", "delete", "markRead", "moveToFolder"]) {
    expect(screen.getByRole("button", { name })).toBeDisabled()
  }
  // The way out never is.
  expect(screen.getByRole("button", { name: "done" })).toBeEnabled()
})

test("sets Delete apart at the end of the action row", () => {
  setup({ onMarkRead: jest.fn() })
  const actions = screen.getByTestId("channel-list-bulk-actions")
  const buttons = Array.from(actions.querySelectorAll("button"))
  expect(buttons[buttons.length - 1]).toHaveAccessibleName("delete")
  expect(buttons[buttons.length - 1]).toHaveClass("ml-auto")
})

test("clicking Share invokes the selected-conversation share callback", async () => {
  const user = userEvent.setup()
  const onShare = jest.fn()
  setup({ onShare })

  await user.click(screen.getByRole("button", { name: "share" }))

  expect(onShare).toHaveBeenCalledTimes(1)
})

test("clicking Done invokes onClear", async () => {
  const user = userEvent.setup()
  const { onClear } = setup()
  await user.click(screen.getByRole("button", { name: "done" }))
  expect(onClear).toHaveBeenCalledTimes(1)
})

test("active view shows Archive, which invokes onArchive", async () => {
  const user = userEvent.setup()
  const { onArchive } = setup()
  await user.click(screen.getByRole("button", { name: "archive" }))
  expect(onArchive).toHaveBeenCalledTimes(1)
  // Pin/Unpin available in the active view; Unarchive is not.
  expect(screen.getByRole("button", { name: "pin" })).toBeInTheDocument()
  expect(screen.queryByRole("button", { name: "unarchive" })).toBeNull()
})

test("archived view swaps pin/archive for a single Unarchive action", async () => {
  const user = userEvent.setup()
  const { onUnarchive } = setup({ archived: true })
  expect(screen.queryByRole("button", { name: "pin" })).toBeNull()
  expect(screen.queryByRole("button", { name: "archive" })).toBeNull()
  await user.click(screen.getByRole("button", { name: "unarchive" }))
  expect(onUnarchive).toHaveBeenCalledTimes(1)
})

test("Delete opens the confirm dialog; the destructive action fires onDelete", async () => {
  const user = userEvent.setup()
  const { onDelete } = setup({ count: 2 })
  await user.click(screen.getByRole("button", { name: "delete" }))
  const dialog = await screen.findByRole("alertdialog")
  expect(screen.getByText(/deleteConfirmTitle:\{"count":2\}/)).toBeInTheDocument()
  // Inside the dialog, two buttons: Cancel (first) + the destructive
  // AlertDialogAction (second, labeled "delete"). Walk the children to pick it.
  const dialogButtons = Array.from(dialog.querySelectorAll("button"))
  const destructive = dialogButtons.find((b) => b.textContent?.trim() === "delete")
  if (!destructive) throw new Error("expected destructive button inside alertdialog")
  await user.click(destructive)
  expect(onDelete).toHaveBeenCalledTimes(1)
})

test("Delete dialog cancel closes the dialog without firing onDelete", async () => {
  const user = userEvent.setup()
  const { onDelete } = setup()
  await user.click(screen.getByRole("button", { name: "delete" }))
  const dialog = await screen.findByRole("alertdialog")
  const dialogButtons = Array.from(dialog.querySelectorAll("button"))
  const cancel = dialogButtons.find((b) => b.textContent?.trim() === "cancel")
  if (!cancel) throw new Error("expected cancel button inside alertdialog")
  await user.click(cancel)
  expect(onDelete).not.toHaveBeenCalled()
})

test("draws only the actions it was handed a writer for", () => {
  render(<ChannelListBulkToolbar count={2} onShare={jest.fn()} onClear={jest.fn()} />)
  for (const name of ["pin", "unpin", "archive", "delete", "markRead"]) {
    expect(screen.queryByRole("button", { name })).toBeNull()
  }
  expect(screen.getByRole("button", { name: "share" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "done" })).toBeInTheDocument()
})

test("marks the selection read", async () => {
  const onMarkRead = jest.fn()
  const user = userEvent.setup()
  setup({ onMarkRead })
  await user.click(screen.getByTestId("channel-list-bulk-mark-read"))
  expect(onMarkRead).toHaveBeenCalledTimes(1)
})

test("names what Delete will remove, and summarizes past five", async () => {
  const user = userEvent.setup()
  setup({ count: 7, selectedTitles: ["A", "B", "C", "D", "E", "F", "G"] })
  await user.click(screen.getByRole("button", { name: "delete" }))
  const list = await screen.findByTestId("channel-list-bulk-delete-titles")
  const items = Array.from(list.querySelectorAll("li")).map((item) => item.textContent)
  expect(items).toEqual(["A", "B", "C", "D", "E", 'deleteConfirmMore:{"count":2}'])
})

test("lists nothing when it was not told the titles", async () => {
  const user = userEvent.setup()
  setup({ count: 2 })
  await user.click(screen.getByRole("button", { name: "delete" }))
  await screen.findByRole("alertdialog")
  expect(screen.queryByTestId("channel-list-bulk-delete-titles")).toBeNull()
})

describe("a selection that mixes active and archived rows", () => {
  test("offers Archive and Unarchive, and freezes pin, folder and read state", () => {
    setup({
      count: 3,
      archivedCount: 1,
      folders: [{ id: "f1", name: "Research" } as never],
      onMoveToFolder: jest.fn(),
      onMarkRead: jest.fn(),
    })
    expect(screen.getByRole("button", { name: "archive" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "unarchive" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "pin" })).toBeNull()
    expect(screen.queryByTestId("channel-list-bulk-move-to-folder")).toBeNull()
    // Read state still applies to the active part of the selection.
    expect(screen.getByRole("button", { name: "markRead" })).toBeInTheDocument()
  })

  test("an all-active selection made inside the archive view offers Archive, not Unarchive", () => {
    setup({ archived: true, count: 2, archivedCount: 0, onMarkRead: jest.fn() })
    expect(screen.getByRole("button", { name: "archive" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "unarchive" })).toBeNull()
    expect(screen.getByRole("button", { name: "pin" })).toBeInTheDocument()
  })

  test("an all-archived selection hides the read switch", () => {
    setup({ archived: true, onMarkRead: jest.fn(), onMarkUnread: jest.fn() })
    expect(screen.queryByRole("button", { name: "markRead" })).toBeNull()
    expect(screen.queryByRole("button", { name: "markUnread" })).toBeNull()
  })

  test("before anything is selected the bar keeps the view's shape", () => {
    setup({ archived: true, count: 0 })
    expect(screen.getByRole("button", { name: "unarchive" })).toBeDisabled()
    expect(screen.queryByRole("button", { name: "archive" })).toBeNull()
  })
})

describe("bar layout", () => {
  test("lays the verbs out in one row with their labels", () => {
    setup({ layout: "bar", total: 9, onSelectAll: jest.fn() })
    const toolbar = screen.getByTestId("channel-list-bulk-toolbar")
    expect(toolbar).toHaveAttribute("data-layout", "bar")
    expect(screen.getByRole("button", { name: "archive" })).toHaveTextContent("archive")
    expect(screen.getByRole("button", { name: "delete" })).toHaveTextContent("delete")
    expect(screen.getByTestId("channel-list-bulk-select-all")).toBeInTheDocument()
    expect(screen.getByTestId("channel-list-bulk-done")).toBeInTheDocument()
  })

  test("the rail stays icon-only", () => {
    setup()
    expect(screen.getByTestId("channel-list-bulk-toolbar")).toHaveAttribute("data-layout", "rail")
    expect(screen.getByRole("button", { name: "archive" })).toHaveTextContent("")
  })
})
