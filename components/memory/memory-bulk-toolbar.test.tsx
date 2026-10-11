/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import { MemoryBulkToolbar } from "./memory-bulk-toolbar"

function setup(over: Partial<Parameters<typeof MemoryBulkToolbar>[0]> = {}) {
  const handlers = {
    onToggleSelectAll: jest.fn(),
    onPin: jest.fn(),
    onUnpin: jest.fn(),
    onArchive: jest.fn(),
    onRestore: jest.fn(),
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
  it("shows the selected count as a named toolbar", () => {
    setup()
    expect(screen.getByRole("toolbar")).toBeInTheDocument()
    expect(screen.getByTestId("memory-bulk-count")).toHaveTextContent("2")
  })

  it("pins, unpins and archives the selection at once — archive is undone from its toast", () => {
    const handlers = setup()
    fireEvent.click(screen.getByTestId("memory-bulk-pin"))
    fireEvent.click(screen.getByTestId("memory-bulk-unpin"))
    fireEvent.click(screen.getByTestId("memory-bulk-archive"))
    expect(handlers.onPin).toHaveBeenCalledTimes(1)
    expect(handlers.onUnpin).toHaveBeenCalledTimes(1)
    expect(handlers.onArchive).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("requests delete without confirming itself — the console owns the one confirmation", () => {
    const handlers = setup()
    fireEvent.click(screen.getByTestId("memory-bulk-delete"))
    expect(handlers.onDelete).toHaveBeenCalledTimes(1)
  })

  it("offers restore instead of pin and archive in the Archived view", () => {
    const handlers = setup({ archivedView: true })
    expect(screen.queryByTestId("memory-bulk-archive")).toBeNull()
    expect(screen.queryByTestId("memory-bulk-pin")).toBeNull()
    fireEvent.click(screen.getByTestId("memory-bulk-restore"))
    expect(handlers.onRestore).toHaveBeenCalledTimes(1)
  })

  it("toggles select-all and clears", () => {
    const handlers = setup()
    fireEvent.click(screen.getByTestId("memory-bulk-select-all"))
    expect(handlers.onToggleSelectAll).toHaveBeenCalledWith(true)
    fireEvent.click(screen.getByTestId("memory-bulk-clear"))
    expect(handlers.onClear).toHaveBeenCalledTimes(1)
  })

  it("disables every action while a bulk mutation is in flight", () => {
    setup({ busy: true })
    for (const id of ["pin", "unpin", "archive", "delete", "clear"]) {
      expect(screen.getByTestId(`memory-bulk-${id}`)).toBeDisabled()
    }
  })

  it("disables the actions with nothing selected, but still lets the mode be left", () => {
    setup({ selectedCount: 0 })
    expect(screen.getByTestId("memory-bulk-delete")).toBeDisabled()
    expect(screen.getByTestId("memory-bulk-clear")).toBeEnabled()
  })

  it("goes icon-only when compact, and every button keeps its name", () => {
    setup({ layout: "compact" })
    expect(screen.getByTestId("memory-bulk-toolbar")).toHaveAttribute("data-layout", "compact")
    expect(screen.getByRole("button", { name: "Archive" })).toBeInTheDocument()
  })
})
