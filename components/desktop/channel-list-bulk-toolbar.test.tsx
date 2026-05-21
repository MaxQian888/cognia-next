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
  const onClear = jest.fn()
  const utils = render(
    <ChannelListBulkToolbar
      count={3}
      onDelete={onDelete}
      onPin={onPin}
      onUnpin={onUnpin}
      onClear={onClear}
      {...overrides}
    />
  )
  return { ...utils, onDelete, onPin, onUnpin, onClear }
}

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

test("clicking Cancel (X) invokes onClear", async () => {
  const user = userEvent.setup()
  const { onClear } = setup()
  await user.click(screen.getByRole("button", { name: "cancel" }))
  expect(onClear).toHaveBeenCalledTimes(1)
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
