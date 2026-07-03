/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, within } from "@testing-library/react"
import { MemoryBulkToolbar } from "./memory-bulk-toolbar"

function setup(over: Partial<Parameters<typeof MemoryBulkToolbar>[0]> = {}) {
  const handlers = {
    onToggleSelectAll: jest.fn(),
    onPin: jest.fn(),
    onUnpin: jest.fn(),
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
})
