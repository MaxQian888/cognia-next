import "fake-indexeddb/auto"
import { fireEvent, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { StorageCleanupDialog } from "./storage-cleanup-dialog"

const messages = {
  settings: {
    data: {
      cleanup: {
        title: "Storage cleanup",
        desc: "Free up space.",
        button: "Cleanup",
        tabs: { quick: "Quick", custom: "Custom", deep: "Deep" },
        quickDesc: "Safe & fast.",
        customDesc: "Pick categories.",
        deepDesc: "Aggressive.",
        deepWarning: "Removes data older than 7 days.",
        runQuick: "Run quick cleanup",
        runDeep: "Run deep cleanup",
        preview: "Preview",
        confirm: "Confirm cleanup",
        complete: "Cleanup complete!",
        freedSpace: "Freed space",
        deletedItems: "Deleted items",
        errors: "{count} errors occurred",
        willBeFreed: "will be freed",
        itemsWillBeDeleted: "{count} items will be deleted",
        back: "Back",
        done: "Done",
      },
    },
  },
  common: { done: "Done" },
}

function renderDialog() {
  const onComplete = jest.fn()
  const utils = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StorageCleanupDialog formatBytes={(n) => `${n} B`} onCleanupComplete={onComplete} />
    </NextIntlClientProvider>
  )
  return { ...utils, onComplete }
}

describe("StorageCleanupDialog", () => {
  it("opens the dialog when the trigger is clicked", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /cleanup/i }))
    expect(screen.getByRole("dialog")).toBeInTheDocument()
    expect(screen.getByText(/safe & fast/i)).toBeInTheDocument()
  })

  it("renders the three cleanup-mode tabs", () => {
    renderDialog()
    fireEvent.click(screen.getByRole("button", { name: /cleanup/i }))
    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByRole("tab", { name: /quick/i })).toBeInTheDocument()
    expect(within(dialog).getByRole("tab", { name: /custom/i })).toBeInTheDocument()
    expect(within(dialog).getByRole("tab", { name: /deep/i })).toBeInTheDocument()
  })

  it("custom tab swaps in the custom-cleanup description", async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByRole("button", { name: /cleanup/i }))
    const dialog = await screen.findByRole("dialog")
    expect(within(dialog).getByText(/safe & fast/i)).toBeInTheDocument()
    // userEvent simulates real pointer events that radix Tabs requires.
    await user.click(within(dialog).getByRole("tab", { name: /custom/i }))
    expect(await within(dialog).findByText(/pick categories/i)).toBeInTheDocument()
  })
})
