/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, within } from "@testing-library/react"
import type { Memory } from "@/types/memory/memory"
import { MemoryDetailPanel } from "./memory-detail-panel"

let seq = 0
function mem(over: Partial<Memory> = {}): Memory {
  seq += 1
  const now = 1_700_000_000_000
  return {
    id: over.id ?? `m${seq}`,
    scope: "global",
    type: "semantic",
    text: `memory ${seq}`,
    tags: [],
    importance: 5,
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

function setup(
  over: Partial<Memory> = {},
  props: Partial<Parameters<typeof MemoryDetailPanel>[0]> = {}
) {
  const onClose = jest.fn()
  const onSave = jest.fn()
  const onPinToggle = jest.fn()
  const onDelete = jest.fn()
  const onNavigate = jest.fn()
  const onSelectMemory = jest.fn()
  render(
    <MemoryDetailPanel
      memory={mem(over)}
      onClose={onClose}
      onSave={onSave}
      onPinToggle={onPinToggle}
      onDelete={onDelete}
      onNavigate={onNavigate}
      onSelectMemory={onSelectMemory}
      navPosition={{ index: 2, total: 3 }}
      {...props}
    />
  )
  return { onClose, onSave, onPinToggle, onDelete, onNavigate, onSelectMemory }
}

beforeEach(() => {
  seq = 0
})

describe("MemoryDetailPanel", () => {
  it("shows the text, type/scope/provenance badges and metadata", () => {
    setup({
      text: "prefers pnpm",
      type: "procedural",
      scope: "character",
      provenance: "explicit",
      version: 4,
      accessCount: 9,
    })
    expect(screen.getByTestId("memory-detail-text").textContent).toBe("prefers pnpm")
    expect(screen.getByText("Preference")).toBeTruthy() // procedural label
    expect(screen.getByText("Character")).toBeTruthy()
    expect(screen.getByText("Explicit")).toBeTruthy()
    expect(screen.getByText("v4")).toBeTruthy()
    expect(screen.getByText("9")).toBeTruthy() // access count
  })

  it("renders tags and the stable key", () => {
    setup({ tags: ["work", "urgent"], key: "always-pnpm" })
    const tags = within(screen.getByTestId("memory-detail-tags"))
    expect(tags.getByText("#work")).toBeTruthy()
    expect(tags.getByText("#urgent")).toBeTruthy()
    expect(screen.getByText("always-pnpm")).toBeTruthy()
  })

  it("closes via the close button", () => {
    const { onClose } = setup()
    fireEvent.click(screen.getByRole("button", { name: /close/i }))
    expect(onClose).toHaveBeenCalled()
  })

  it("navigates prev/next and disables at the ends", () => {
    const { onNavigate } = setup({}, { navPosition: { index: 2, total: 3 } })
    fireEvent.click(screen.getByRole("button", { name: /next memory/i }))
    expect(onNavigate).toHaveBeenCalledWith(1)
    fireEvent.click(screen.getByRole("button", { name: /previous memory/i }))
    expect(onNavigate).toHaveBeenCalledWith(-1)
  })

  it("disables prev at the first item and next at the last", () => {
    const { rerender } = renderPanel({ navPosition: { index: 1, total: 3 } })
    expect(
      (screen.getByRole("button", { name: /previous memory/i }) as HTMLButtonElement).disabled
    ).toBe(true)
    rerender({ navPosition: { index: 3, total: 3 } })
    expect(
      (screen.getByRole("button", { name: /next memory/i }) as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it("edits text and saves only the changed field", () => {
    const { onSave } = setup({ id: "m1", text: "old", importance: 5, tags: [] })
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    const textarea = screen.getByLabelText("Text") as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: "new text" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith("m1", { text: "new text" })
  })

  it("edits tags and saves the parsed set", () => {
    const { onSave } = setup({ id: "m1", tags: ["a"] })
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.change(screen.getByLabelText("Tags"), { target: { value: "x, y ,x" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith("m1", { tags: ["x", "y"] })
  })

  it("edits importance via the slider and saves it", () => {
    const { onSave } = setup({ id: "m1", importance: 5 })
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).toHaveBeenCalledWith("m1", { importance: 6 })
  })

  it("does not call onSave when nothing changed", () => {
    const { onSave } = setup({ id: "m1", text: "same" })
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.click(screen.getByRole("button", { name: "Save" }))
    expect(onSave).not.toHaveBeenCalled()
  })

  it("cancels edit without saving", () => {
    const { onSave } = setup({ text: "keep" })
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.change(screen.getByLabelText("Text"), { target: { value: "discard" } })
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByTestId("memory-detail-text").textContent).toBe("keep")
  })

  it("toggles pin", () => {
    const { onPinToggle } = setup({ id: "m1", pinned: false })
    fireEvent.click(screen.getByRole("button", { name: /^pin$/i }))
    expect(onPinToggle).toHaveBeenCalledWith("m1", true)
  })

  it("deletes after confirming and then closes", () => {
    const { onDelete, onClose } = setup({ id: "m1" })
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }))
    const dialog = screen.getByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    expect(onDelete).toHaveBeenCalledWith("m1")
    expect(onClose).toHaveBeenCalled()
  })

  it("links to the source session", () => {
    setup({ sourceSessionId: "ses_9" })
    const link = screen.getByTestId("memory-detail-source-link") as HTMLAnchorElement
    expect(link.getAttribute("href")).toContain("ses_9")
  })

  it("shows the replacement link and follows it", () => {
    const replacement = mem({ id: "m2", text: "the newer fact" })
    const { onSelectMemory } = setup(
      { id: "m1", supersededById: "m2" },
      { resolveMemory: (id) => (id === "m2" ? replacement : undefined) }
    )
    const link = screen.getByTestId("memory-detail-superseded-link")
    expect(link.textContent).toBe("the newer fact")
    fireEvent.click(link)
    expect(onSelectMemory).toHaveBeenCalledWith("m2")
  })

  it("notes when the replacement is gone", () => {
    setup({ id: "m1", supersededById: "m2" }, { resolveMemory: () => undefined })
    expect(screen.getByText(/replacement was deleted/i)).toBeTruthy()
  })

  it("shows an archived badge and archived-at for invalidated rows", () => {
    setup({ status: "invalidated", invalidatedAt: 1_700_000_500_000 })
    expect(screen.getByText("archived")).toBeTruthy()
  })
})

// Helper for the disabled-ends test that needs to re-render with new props.
function renderPanel(props: Partial<Parameters<typeof MemoryDetailPanel>[0]>) {
  const base = {
    memory: mem({ id: "mx" }),
    onClose: jest.fn(),
    onSave: jest.fn(),
    onPinToggle: jest.fn(),
    onDelete: jest.fn(),
    onNavigate: jest.fn(),
  }
  const utils = render(<MemoryDetailPanel {...base} {...props} />)
  return {
    rerender: (next: Partial<Parameters<typeof MemoryDetailPanel>[0]>) =>
      utils.rerender(<MemoryDetailPanel {...base} {...props} {...next} />),
  }
}
