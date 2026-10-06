/**
 * @jest-environment jsdom
 */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import type { Memory } from "@/types/memory/memory"
import { MemoryRevisionHistory } from "./memory-revision-history"

const NOW = 1_700_000_000_000

function revision(over: Partial<Memory> = {}): Memory {
  return {
    id: "r1",
    scope: "global",
    type: "semantic",
    text: "The user prefers npm",
    tags: [],
    importance: 5,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 5_000,
    lastAccessedAt: NOW,
    accessCount: 0,
    version: 1,
    status: "invalidated",
    pinned: false,
    provenance: "user",
    revisionOf: "m1",
    ...over,
  }
}

const iso = (ts: number) => new Date(ts).toISOString()

describe("MemoryRevisionHistory", () => {
  it("says so when there are no earlier versions", () => {
    render(<MemoryRevisionHistory revisions={[]} onRestore={jest.fn()} />)
    expect(screen.getByText("No earlier versions.")).toBeInTheDocument()
    expect(screen.queryByTestId("memory-revision-history")).toBeNull()
  })

  it("renders each revision's reason, live window and text in the given order", () => {
    render(
      <MemoryRevisionHistory
        revisions={[
          revision({
            id: "r2",
            text: "newest text",
            revisionReason: "compaction",
            revisedAt: NOW - 3_000,
            invalidatedAt: NOW - 1_000,
          }),
          revision({ id: "r1", text: "oldest text", revisionReason: "dedup-merge" }),
        ]}
      />
    )
    const items = screen.getAllByTestId("memory-revision")
    expect(items.map((item) => item.dataset.revisionId)).toEqual(["r2", "r1"])
    expect(within(items[0]!).getByText("Compacted")).toBeInTheDocument()
    expect(within(items[0]!).getByText("newest text")).toBeInTheDocument()
    expect(items[0]!.textContent).toContain(`${iso(NOW - 3_000)} – ${iso(NOW - 1_000)}`)
    expect(within(items[1]!).getByText("Duplicates folded in")).toBeInTheDocument()
  })

  it("falls back to createdAt/updatedAt for the window and 'Edited' for a missing reason", () => {
    render(<MemoryRevisionHistory revisions={[revision()]} />)
    const item = screen.getByTestId("memory-revision")
    expect(within(item).getByText("Edited")).toBeInTheDocument()
    expect(item.textContent).toContain(`${iso(NOW - 10_000)} – ${iso(NOW - 5_000)}`)
  })

  it("is read-only when no restore handler is given", () => {
    render(<MemoryRevisionHistory revisions={[revision()]} />)
    expect(screen.queryByTestId("memory-revision-restore")).toBeNull()
  })

  it("confirms before restoring and hands back the revision id", async () => {
    const user = userEvent.setup()
    const onRestore = jest.fn()
    render(
      <MemoryRevisionHistory
        revisions={[revision({ id: "r2" }), revision({ id: "r1" })]}
        onRestore={onRestore}
      />
    )
    await user.click(screen.getAllByTestId("memory-revision-restore")[1]!)
    expect(onRestore).not.toHaveBeenCalled()
    const dialog = screen.getByRole("alertdialog")
    expect(within(dialog).getByText("Restore this version?")).toBeInTheDocument()
    await user.click(within(dialog).getByRole("button", { name: "Restore" }))
    expect(onRestore).toHaveBeenCalledTimes(1)
    expect(onRestore).toHaveBeenCalledWith("r1")
  })

  it("does nothing when the confirmation is cancelled", async () => {
    const user = userEvent.setup()
    const onRestore = jest.fn()
    render(<MemoryRevisionHistory revisions={[revision()]} onRestore={onRestore} />)
    await user.click(screen.getByTestId("memory-revision-restore"))
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Cancel" })
    )
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(onRestore).not.toHaveBeenCalled()
  })
})

it("wraps unbroken revision text while retaining the line limit", () => {
  const text = "revision".repeat(100)
  render(<MemoryRevisionHistory revisions={[revision({ text })]} />)
  expect(screen.getByText(text)).toHaveClass("break-words", "line-clamp-4")
})
