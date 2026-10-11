/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Memory } from "@/types/memory/memory"
import { useProjectStore } from "@/stores/project/project-store"

jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => [] }))
jest.mock("@/lib/db/characters", () => ({ listCharacters: async () => [] }))

import { MemoryMoveDialog } from "./memory-move-dialog"

function mem(over: Partial<Memory> = {}): Memory {
  return {
    id: "m1",
    scope: "global",
    type: "semantic",
    text: "likes tea",
    tags: [],
    importance: 5,
    createdAt: 1,
    updatedAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
    version: 1,
    status: "active",
    pinned: false,
    provenance: "user",
    ...over,
  }
}

beforeEach(() => {
  useProjectStore.setState({ projects: [{ id: "p1", name: "Cognia" }] as never })
})

describe("MemoryMoveDialog", () => {
  it("is closed without a memory", () => {
    render(<MemoryMoveDialog memory={undefined} onOpenChange={jest.fn()} onMove={jest.fn()} />)
    expect(screen.queryByTestId("memory-move-dialog")).toBeNull()
  })

  it("will not move a memory to where it already is", () => {
    render(<MemoryMoveDialog memory={mem()} onOpenChange={jest.fn()} onMove={jest.fn()} />)
    expect(screen.getByTestId("memory-move-confirm")).toBeDisabled()
  })

  it("moves to a workspace picked by name and closes once it lands", async () => {
    const onMove = jest.fn(async () => true)
    const onOpenChange = jest.fn()
    render(<MemoryMoveDialog memory={mem()} onOpenChange={onOpenChange} onMove={onMove} />)
    fireEvent.click(screen.getByLabelText("Scope"))
    fireEvent.click(screen.getByRole("option", { name: "Workspace" }))
    // A workspace scope needs a workspace before it can move.
    expect(screen.getByTestId("memory-move-confirm")).toBeDisabled()
    expect(screen.getByText("Recalled only in this workspace's conversations.")).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText("Workspace"))
    fireEvent.click(screen.getByRole("option", { name: "Cognia" }))
    fireEvent.click(screen.getByTestId("memory-move-confirm"))
    await waitFor(() =>
      expect(onMove).toHaveBeenCalledWith("m1", { scope: "workspace", projectId: "p1" })
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("stays open when the move is refused", async () => {
    const onMove = jest.fn(async () => false)
    const onOpenChange = jest.fn()
    render(
      <MemoryMoveDialog
        memory={mem({ scope: "workspace", projectId: "p1" })}
        onOpenChange={onOpenChange}
        onMove={onMove}
      />
    )
    fireEvent.click(screen.getByLabelText("Scope"))
    fireEvent.click(screen.getByRole("option", { name: "Global" }))
    fireEvent.click(screen.getByTestId("memory-move-confirm"))
    await waitFor(() => expect(onMove).toHaveBeenCalledWith("m1", { scope: "global" }))
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })
})
