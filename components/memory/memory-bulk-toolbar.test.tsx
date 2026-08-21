/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MemoryBulkToolbar } from "./memory-bulk-toolbar"

function setup(over: Partial<Parameters<typeof MemoryBulkToolbar>[0]> = {}) {
  const handlers = {
    onToggleSelectAll: jest.fn(),
    onPin: jest.fn(),
    onUnpin: jest.fn(),
    onArchive: jest.fn(),
    onDelete: jest.fn(),
    onClear: jest.fn(),
  }
  render(
    <MemoryBulkToolbar
      selectedCount={2}
      visibleCount={5}
      allSelected={false}
      {...handlers}
      {...over}
    />
  )
  return handlers
}

describe("MemoryBulkToolbar", () => {
  it("shows the selected count", () => {
    setup({ selectedCount: 3 })
    expect(screen.getByTestId("memory-bulk-count").textContent).toContain("3")
  })

  it("pins and unpins the selection", () => {
    const { onPin, onUnpin } = setup()
    fireEvent.click(screen.getByRole("button", { name: /^pin$/i }))
    expect(onPin).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: /^unpin$/i }))
    expect(onUnpin).toHaveBeenCalled()
  })

  it("clears the selection", () => {
    const { onClear } = setup()
    fireEvent.click(screen.getByRole("button", { name: /clear selection/i }))
    expect(onClear).toHaveBeenCalled()
  })

  it("toggles select-all through the header checkbox", () => {
    const { onToggleSelectAll } = setup({ allSelected: false })
    fireEvent.click(screen.getByTestId("memory-bulk-select-all"))
    expect(onToggleSelectAll).toHaveBeenCalledWith(true)
  })

  it("deletes only after confirming", () => {
    const { onDelete } = setup({ selectedCount: 2 })
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }))
    expect(onDelete).not.toHaveBeenCalled()
    const dialog = screen.getByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    expect(onDelete).toHaveBeenCalled()
  })

  it("disables every action while a bulk mutation is in flight", () => {
    const { onPin } = setup({ busy: true })
    const pin = screen.getByRole("button", { name: /^pin$/i })
    expect(pin).toBeDisabled()
    expect(screen.getByRole("button", { name: /^unpin$/i })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^delete$/i })).toBeDisabled()
    fireEvent.click(pin)
    expect(onPin).not.toHaveBeenCalled()
  })
})

describe("MemoryBulkToolbar — archive", () => {
  // Archive is the softer default: `invalidate` keeps history and can be undone
  // from the Archived view, so it is offered alongside the permanent delete
  // rather than the permanent delete being the only bulk removal.
  it("confirms before archiving the selection", async () => {
    const { onArchive } = setup({ selectedCount: 4 })
    await userEvent.click(screen.getByTestId("memory-bulk-archive"))
    expect(onArchive).not.toHaveBeenCalled()
    const dialog = await screen.findByRole("alertdialog")
    expect(dialog.textContent).toContain("4")
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }))
    expect(onArchive).toHaveBeenCalled()
  })

  it("keeps archive and permanent delete as separate actions", () => {
    setup()
    expect(screen.getByTestId("memory-bulk-archive")).toBeTruthy()
    expect(screen.getByTestId("memory-bulk-delete")).toBeTruthy()
  })

  it("disables every action while a bulk mutation is in flight", () => {
    setup({ busy: true })
    for (const testid of ["memory-bulk-archive", "memory-bulk-delete"]) {
      expect(screen.getByTestId(testid).hasAttribute("disabled")).toBe(true)
    }
  })
})
