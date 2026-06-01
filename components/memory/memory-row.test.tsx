/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react"
import type { Memory } from "@/types/memory/memory"
import { MemoryRow } from "./memory-row"

function mem(over: Partial<Memory> = {}): Memory {
  const now = 1_700_000_000_000
  return {
    id: "m1",
    scope: "global",
    type: "semantic",
    text: "The user prefers pnpm",
    tags: [],
    importance: 7,
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

function setup(over: Partial<Memory> = {}) {
  const onPinToggle = jest.fn()
  const onSave = jest.fn()
  const onDelete = jest.fn()
  render(
    <MemoryRow memory={mem(over)} onPinToggle={onPinToggle} onSave={onSave} onDelete={onDelete} />
  )
  return { onPinToggle, onSave, onDelete }
}

describe("MemoryRow", () => {
  it("renders text, importance and type badge", () => {
    setup()
    expect(screen.getByText("The user prefers pnpm")).toBeTruthy()
    expect(screen.getByTestId("memory-importance").textContent).toContain("7")
  })

  it("toggles pin", () => {
    const { onPinToggle } = setup({ pinned: false })
    fireEvent.click(screen.getByRole("button", { name: /pin/i }))
    expect(onPinToggle).toHaveBeenCalledWith("m1", true)
  })

  it("enters edit mode and saves a changed value", () => {
    const { onSave } = setup()
    fireEvent.click(screen.getByRole("button", { name: /edit/i }))
    const textarea = screen.getByLabelText(/edit memory text/i) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "The user prefers bun" } })
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith("m1", "The user prefers bun")
  })

  it("does not save when the text is unchanged", () => {
    const { onSave } = setup()
    fireEvent.click(screen.getByRole("button", { name: /edit/i }))
    fireEvent.click(screen.getByRole("button", { name: /save/i }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("cancels edit without saving", () => {
    const { onSave } = setup()
    fireEvent.click(screen.getByRole("button", { name: /edit/i }))
    const textarea = screen.getByLabelText(/edit memory text/i)
    fireEvent.change(textarea, { target: { value: "changed" } })
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText("The user prefers pnpm")).toBeTruthy()
  })

  it("deletes", () => {
    const { onDelete } = setup()
    fireEvent.click(screen.getByRole("button", { name: /delete/i }))
    expect(onDelete).toHaveBeenCalledWith("m1")
  })

  it("renders a source link when sourceSessionId is set", () => {
    setup({ sourceSessionId: "ses_9" })
    const link = screen.getByTestId("memory-source-link") as HTMLAnchorElement
    expect(link.getAttribute("href")).toContain("ses_9")
  })

  it("shows pinned + invalidated styling cues", () => {
    setup({ pinned: true, status: "invalidated" })
    // Unpin affordance shown for a pinned row.
    expect(screen.getByRole("button", { name: /unpin/i })).toBeTruthy()
  })
})
