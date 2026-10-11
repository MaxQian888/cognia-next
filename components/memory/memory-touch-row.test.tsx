/** @jest-environment jsdom */
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Memory } from "@/types/memory/memory"
import { MemoryTouchRow, type MemoryTouchRowProps } from "./memory-touch-row"

function mem(over: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    scope: "global",
    type: "semantic",
    text: "likes tea",
    tags: [],
    importance: 6,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

function setup(over: Partial<MemoryTouchRowProps> = {}) {
  const props: MemoryTouchRowProps = {
    memory: mem(),
    selecting: false,
    selected: false,
    onOpen: jest.fn(),
    onToggleSelect: jest.fn(),
    onStartSelecting: jest.fn(),
    onPinToggle: jest.fn(),
    onArchive: jest.fn(),
    onRestore: jest.fn(),
    onMove: jest.fn(),
    onCopy: jest.fn(),
    onDelete: jest.fn(),
    ...over,
  }
  render(<MemoryTouchRow {...props} />)
  return props
}

describe("MemoryTouchRow", () => {
  it("opens the memory on tap, named by its text", async () => {
    const props = setup()
    await userEvent.click(screen.getByRole("button", { name: "Open memory: likes tea" }))
    expect(props.onOpen).toHaveBeenCalledWith("m1")
  })

  it("toggles instead of opening while selecting", async () => {
    const props = setup({ selecting: true })
    await userEvent.click(screen.getByTestId("memory-touch-open"))
    expect(props.onToggleSelect).toHaveBeenCalledWith("m1", true)
    expect(props.onOpen).not.toHaveBeenCalled()
    // No menu while selecting: the header's bulk actions are the actions.
    expect(screen.queryByTestId("memory-touch-more")).toBeNull()
  })

  it("starts selecting on a long press", () => {
    jest.useFakeTimers()
    try {
      const props = setup()
      const target = screen.getByTestId("memory-touch-open").parentElement!
      fireEvent.pointerDown(target, { pointerType: "touch", clientX: 0, clientY: 0 })
      act(() => {
        jest.advanceTimersByTime(600)
      })
      expect(props.onStartSelecting).toHaveBeenCalledWith("m1")
    } finally {
      jest.useRealTimers()
    }
  })

  it("keeps every per-row action in one menu", async () => {
    const props = setup()
    await userEvent.click(screen.getByTestId("memory-touch-more"))
    await userEvent.click(screen.getByRole("menuitem", { name: "Pin" }))
    expect(props.onPinToggle).toHaveBeenCalledWith("m1", true)

    await userEvent.click(screen.getByTestId("memory-touch-more"))
    await userEvent.click(screen.getByRole("menuitem", { name: "Edit" }))
    expect(props.onOpen).toHaveBeenCalledWith("m1", { edit: true })

    await userEvent.click(screen.getByTestId("memory-touch-more"))
    await userEvent.click(screen.getByRole("menuitem", { name: "Move to…" }))
    expect(props.onMove).toHaveBeenCalledWith("m1")

    await userEvent.click(screen.getByTestId("memory-touch-more"))
    await userEvent.click(screen.getByTestId("memory-touch-archive"))
    expect(props.onArchive).toHaveBeenCalledWith("m1")

    await userEvent.click(screen.getByTestId("memory-touch-more"))
    await userEvent.click(screen.getByTestId("memory-touch-delete"))
    expect(props.onDelete).toHaveBeenCalledWith("m1")
  })

  it("offers restore — and no pin, edit or move — on an archived memory", async () => {
    const props = setup({ memory: mem({ status: "invalidated", invalidatedAt: 1 }) })
    expect(screen.getByText("archived")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("memory-touch-more"))
    expect(screen.queryByRole("menuitem", { name: "Pin" })).toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Edit" })).toBeNull()
    await userEvent.click(screen.getByTestId("memory-touch-restore"))
    expect(props.onRestore).toHaveBeenCalledWith("m1")
  })

  it("marks pinned and conflicting memories in the meta line", () => {
    setup({ memory: mem({ pinned: true, reviewStatus: "conflict" }) })
    expect(screen.getByLabelText("Pinned")).toBeInTheDocument()
    expect(screen.getByText("Conflict")).toBeInTheDocument()
  })
})
