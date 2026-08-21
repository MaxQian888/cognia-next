/** @jest-environment jsdom */
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { MemoryConflictResolver } from "./memory-conflict-resolver"
import { manageMemory } from "@/lib/memory/control-plane/manage"
import { toast } from "sonner"
import type { Memory } from "@/types/memory/memory"

jest.mock("@/lib/memory/control-plane/manage", () => ({
  manageMemory: jest.fn(async () => ({ ok: true })),
}))
jest.mock("sonner", () => ({ toast: { error: jest.fn(), success: jest.fn() } }))

const mockManage = manageMemory as jest.Mock

function mem(over: Partial<Memory> = {}): Memory {
  const now = 1_700_000_000_000
  return {
    id: "a",
    scope: "global",
    type: "semantic",
    text: "uses npm",
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
    reviewStatus: "conflict",
    conflictWithIds: ["b"],
    ...over,
  }
}

const other = mem({ id: "b", text: "uses pnpm", conflictWithIds: ["a"], provenance: "explicit" })

function setup(props: Partial<Parameters<typeof MemoryConflictResolver>[0]> = {}) {
  const onOpenChange = jest.fn()
  const onResolved = jest.fn()
  render(
    <MemoryConflictResolver
      open
      onOpenChange={onOpenChange}
      memory={mem()}
      resolveMemory={(id) => (id === "b" ? other : undefined)}
      onResolved={onResolved}
      {...props}
    />
  )
  return { onOpenChange, onResolved }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockManage.mockResolvedValue({ ok: true })
})

describe("MemoryConflictResolver", () => {
  it("shows both sides with text and provenance", () => {
    setup()
    expect(screen.getByText("Resolve conflicting memories")).toBeInTheDocument()
    expect(screen.getByText("uses npm")).toBeInTheDocument()
    expect(screen.getByText("uses pnpm")).toBeInTheDocument()
  })

  it("keep-this on side A drops side B", async () => {
    const user = userEvent.setup()
    const { onOpenChange, onResolved } = setup()
    const sideA = screen.getByTestId("conflict-side-a")
    await user.click(within(sideA).getByRole("button", { name: "Keep this one" }))
    expect(mockManage).toHaveBeenCalledWith({
      kind: "resolve-conflict",
      keepId: "a",
      dropId: "b",
      mode: "keep",
    })
    expect(onResolved).toHaveBeenCalledWith("a")
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("keep-this on side B swaps the winner", async () => {
    const user = userEvent.setup()
    setup()
    const sideB = screen.getByTestId("conflict-side-b")
    await user.click(within(sideB).getByRole("button", { name: "Keep this one" }))
    expect(mockManage).toHaveBeenCalledWith({
      kind: "resolve-conflict",
      keepId: "b",
      dropId: "a",
      mode: "keep",
    })
  })

  it("keep-both clears the conflict without dropping either", async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole("button", { name: "Keep both" }))
    expect(mockManage).toHaveBeenCalledWith({
      kind: "resolve-conflict",
      keepId: "a",
      dropId: "b",
      mode: "keep-both",
    })
  })

  it("merge reveals a textarea prefilled with side A and saves the merged text", async () => {
    const user = userEvent.setup()
    setup()
    await user.click(screen.getByRole("button", { name: "Merge by hand…" }))
    const textarea = screen.getByRole("textbox", { name: "Merged memory text" })
    expect(textarea).toHaveValue("uses npm")
    await user.clear(textarea)
    await user.type(textarea, "migrated from npm to pnpm")
    await user.click(screen.getByRole("button", { name: "Save merge" }))
    expect(mockManage).toHaveBeenCalledWith({
      kind: "resolve-conflict",
      keepId: "a",
      dropId: "b",
      mode: "merge",
      mergedText: "migrated from npm to pnpm",
    })
  })

  it("surfaces a toast and stays open when the mutation is rejected", async () => {
    const user = userEvent.setup()
    mockManage.mockResolvedValue({ ok: false, reason: "pii_blocked" })
    const { onOpenChange } = setup()
    await user.click(screen.getByRole("button", { name: "Keep both" }))
    expect(toast.error).toHaveBeenCalledWith("Blocked: the text contains personal information")
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it("offers to clear a stale conflict when the counterpart is gone", async () => {
    const user = userEvent.setup()
    const { onOpenChange } = setup({ resolveMemory: () => undefined })
    expect(
      screen.getByText(
        "The conflicting memory no longer exists. Clear the stale conflict flag so this memory rejoins recall."
      )
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Mark as verified" }))
    expect(mockManage).toHaveBeenCalledWith({ kind: "review", id: "a", status: "verified" })
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })
})

describe("MemoryConflictResolver — thrown failures", () => {
  // A rejected command already toasted, but a *thrown* one left the dialog
  // stuck in its busy state with no feedback at all.
  it("recovers and toasts when the command throws rather than rejecting", async () => {
    const user = userEvent.setup()
    mockManage.mockRejectedValueOnce(new Error("dexie is down"))
    setup()
    const sideA = screen.getByTestId("conflict-side-a")
    const keep = within(sideA).getByRole("button", { name: "Keep this one" })
    await user.click(keep)
    expect(toast.error).toHaveBeenCalledWith("The memory operation failed — please try again")
    expect(keep.hasAttribute("disabled")).toBe(false)
  })
})
