/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react"
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

function setup(over: Partial<Memory> = {}, extra: Partial<Parameters<typeof MemoryRow>[0]> = {}) {
  const onPinToggle = jest.fn()
  const onSave = jest.fn()
  const onDelete = jest.fn()
  render(
    <MemoryRow
      memory={mem(over)}
      onPinToggle={onPinToggle}
      onSave={onSave}
      onDelete={onDelete}
      {...extra}
    />
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

  it("deletes after the brief fade-out", async () => {
    const { onDelete } = setup()
    fireEvent.click(screen.getByRole("button", { name: /delete/i }))
    // Delete defers ~160ms while the row fades itself out.
    expect(onDelete).not.toHaveBeenCalled()
    expect(screen.getByTestId("memory-row").className).toContain("opacity-0")
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("m1"))
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

  it("uses a translucent theme-aware card surface so it reads over wallpapers", () => {
    setup()
    const row = screen.getByTestId("memory-row")
    // Mirrors StatCard's `bg-card/80` so the panel adapts to theme + image
    // backgrounds (the page opts in via data-bg-target="chat").
    expect(row.className).toContain("bg-card/80")
    expect(row.className).toContain("backdrop-blur-sm")
  })

  it("opens the detail view on row click and Enter when onOpenDetail is set", () => {
    const onOpenDetail = jest.fn()
    setup({ id: "m1" }, { onOpenDetail })
    fireEvent.click(screen.getByTestId("memory-row"))
    expect(onOpenDetail).toHaveBeenCalledWith("m1")
    fireEvent.keyDown(screen.getByTestId("memory-row"), { key: "Enter" })
    expect(onOpenDetail).toHaveBeenCalledTimes(2)
  })

  it("does not open the detail view when an action button is clicked", async () => {
    const onOpenDetail = jest.fn()
    const { onDelete } = setup({ id: "m1" }, { onOpenDetail })
    fireEvent.click(screen.getByRole("button", { name: /delete/i }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("m1"))
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  it("renders a selection checkbox and reports toggles", () => {
    const onSelectToggle = jest.fn()
    setup({ id: "m1" }, { selectable: true, selected: false, onSelectToggle })
    fireEvent.click(screen.getByTestId("memory-select"))
    expect(onSelectToggle).toHaveBeenCalledWith("m1", true)
  })

  it("renders clickable tag chips that filter and never open detail", () => {
    const onTagClick = jest.fn()
    const onOpenDetail = jest.fn()
    setup({ tags: ["work"] }, { onTagClick, onOpenDetail, activeTags: new Set(["work"]) })
    const chip = screen.getByRole("button", { name: "#work" })
    expect(chip.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(chip)
    expect(onTagClick).toHaveBeenCalledWith("work")
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  it("renders plain tag chips when no tag handler is provided", () => {
    setup({ tags: ["home"] })
    const tags = screen.getByTestId("memory-tags")
    expect(within(tags).getByText("#home")).toBeTruthy()
    expect(within(tags).queryByRole("button")).toBeNull()
  })

  it("highlights the active row", () => {
    setup({}, { active: true })
    expect(screen.getByTestId("memory-row").className).toContain("ring-primary/50")
  })

  it.each([
    [{ reviewStatus: "conflict" as const }, "Conflict"],
    [{ evidenceState: "supported" as const }, "Evidence-backed"],
    [{}, "Legacy / no evidence"],
  ])("renders the governed trust badge for %j", (overrides, label) => {
    setup(overrides)
    expect(screen.getByText(label)).toBeInTheDocument()
  })
})
