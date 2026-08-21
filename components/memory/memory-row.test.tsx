/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
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
  const onArchive = jest.fn()
  render(
    <MemoryRow
      memory={mem(over)}
      onPinToggle={onPinToggle}
      onSave={onSave}
      onDelete={onDelete}
      onArchive={onArchive}
      {...extra}
    />
  )
  return { onPinToggle, onSave, onDelete, onArchive }
}

/** Open the row's overflow menu and return its content element. */
async function openRowMenu() {
  await userEvent.click(screen.getByRole("button", { name: "More actions" }))
  return screen.getByRole("menu")
}

describe("MemoryRow", () => {
  it("renders text, importance and type badge", () => {
    setup()
    expect(screen.getByText("The user prefers pnpm")).toBeTruthy()
    expect(screen.getByTestId("memory-row").textContent).toContain("Importance 7")
    expect(screen.getByTestId("memory-row").textContent).toContain("Fact")
  })

  it("hands the pin callback the desired state, not the current one", () => {
    const { onPinToggle } = setup({ pinned: false })
    fireEvent.click(screen.getByRole("button", { name: "Pin" }))
    expect(onPinToggle).toHaveBeenCalledWith("m1", true)
  })

  it("unpins a pinned row", () => {
    const { onPinToggle } = setup({ pinned: true })
    fireEvent.click(screen.getByRole("button", { name: "Unpin" }))
    expect(onPinToggle).toHaveBeenCalledWith("m1", false)
  })

  it("enters edit mode and saves a changed value", () => {
    const { onSave } = setup()
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    const textarea = screen.getByRole("textbox")
    fireEvent.change(textarea, { target: { value: "The user prefers bun" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith("m1", "The user prefers bun")
  })

  it("does not save an unchanged or empty value", () => {
    const { onSave } = setup()
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("cancels an edit without saving", () => {
    const { onSave } = setup()
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "nope" } })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText("The user prefers pnpm")).toBeTruthy()
  })

  // Archive is the visible destructive action; permanent delete is demoted to
  // the overflow menu because `invalidate` keeps the row restorable.
  it("archives from a visible button", () => {
    const { onArchive, onDelete } = setup()
    fireEvent.click(screen.getByTestId("memory-row-archive"))
    expect(onArchive).toHaveBeenCalledWith("m1")
    expect(onDelete).not.toHaveBeenCalled()
  })

  it("keeps permanent delete behind the overflow menu", async () => {
    const { onDelete } = setup()
    const menu = await openRowMenu()
    await userEvent.click(within(menu).getByText("Delete permanently"))
    expect(onDelete).toHaveBeenCalledWith("m1")
  })

  it("omits permanent delete on surfaces that cannot hard-delete", async () => {
    render(
      <MemoryRow memory={mem()} onPinToggle={jest.fn()} onSave={jest.fn()} onArchive={jest.fn()} />
    )
    const menu = await openRowMenu()
    expect(within(menu).queryByText("Delete permanently")).toBeNull()
  })

  it("hides archive on an already-archived row", () => {
    setup({ status: "invalidated" })
    expect(screen.queryByTestId("memory-row-archive")).toBeNull()
    expect(screen.getByTestId("memory-row").textContent).toContain("archived")
  })

  // Painting a badge on every healthy row trains the eye to skip the one that
  // matters, so only conflict / awaiting-review states render one.
  it("shows a governance badge only for states that need attention", () => {
    const { unmount } = render(
      <MemoryRow
        memory={mem({ reviewStatus: "verified" })}
        onPinToggle={jest.fn()}
        onSave={jest.fn()}
        onDelete={jest.fn()}
      />
    )
    expect(screen.queryByTestId("memory-row-governance")).toBeNull()
    unmount()

    setup({ reviewStatus: "conflict" })
    expect(screen.getByTestId("memory-row-governance").textContent).toBe("Conflict")
  })

  it("labels a pending_instruction row rather than rendering a missing key", () => {
    setup({ reviewStatus: "pending_instruction" })
    expect(screen.getByTestId("memory-row-governance").textContent).toBe("Awaiting review")
  })

  it("caps the visible tags and counts the rest", () => {
    setup({ tags: ["a", "b", "c", "d", "e"] })
    const row = screen.getByTestId("memory-row")
    expect(within(row).getByText("a")).toBeTruthy()
    expect(within(row).queryByText("d")).toBeNull()
    expect(row.textContent).toContain("+2")
  })

  it("reports tag clicks", () => {
    const onTagClick = jest.fn()
    setup({ tags: ["prefs"] }, { onTagClick })
    fireEvent.click(screen.getByText("prefs"))
    expect(onTagClick).toHaveBeenCalledWith("prefs")
  })

  it("opens the detail pane on click and on Enter", () => {
    const onOpenDetail = jest.fn()
    setup({}, { onOpenDetail })
    const row = screen.getByTestId("memory-row")
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: "Enter" })
    expect(onOpenDetail).toHaveBeenCalledTimes(2)
  })

  it("does not open the detail pane while editing", () => {
    const onOpenDetail = jest.fn()
    setup({}, { onOpenDetail })
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.click(screen.getByTestId("memory-row"))
    expect(onOpenDetail).not.toHaveBeenCalled()
  })

  it("exposes selection when selectable", () => {
    const onSelectToggle = jest.fn()
    setup({}, { selectable: true, onSelectToggle })
    fireEvent.click(screen.getByTestId("memory-row-select"))
    expect(onSelectToggle).toHaveBeenCalledWith("m1", true)
  })

  it("marks the density it was rendered at", () => {
    setup({}, { density: "compact" })
    expect(screen.getByTestId("memory-row").dataset.density).toBe("compact")
  })
})
