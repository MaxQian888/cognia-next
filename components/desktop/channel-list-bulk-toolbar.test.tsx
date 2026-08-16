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
  })
  await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
  await user.click(screen.getByTestId("channel-list-bulk-folder-f1"))
  expect(onMoveToFolder).toHaveBeenCalledWith("f1")

  await user.click(screen.getByTestId("channel-list-bulk-move-to-folder"))
  await user.click(screen.getByTestId("channel-list-bulk-folder-none"))
  expect(onMoveToFolder).toHaveBeenLastCalledWith(null)
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

test("clicking Pin and Unpin invokes their callbacks", async () => {
  const user = userEvent.setup()
  const { onPin, onUnpin } = setup()
  await user.click(screen.getByRole("button", { name: "pin" }))
  expect(onPin).toHaveBeenCalledTimes(1)
  await user.click(screen.getByRole("button", { name: "unpin" }))
  expect(onUnpin).toHaveBeenCalledTimes(1)
})

test("clicking Share invokes the selected-conversation share callback", async () => {
  const user = userEvent.setup()
  const onShare = jest.fn()
  setup({ onShare })

  await user.click(screen.getByRole("button", { name: "share" }))

  expect(onShare).toHaveBeenCalledTimes(1)
})

test("clicking Cancel (X) invokes onClear", async () => {
  const user = userEvent.setup()
  const { onClear } = setup()
  await user.click(screen.getByRole("button", { name: "cancel" }))
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
