/**
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { MemoryMobileBody } from "./memory-mobile-body"
import { useLiveQuery } from "dexie-react-hooks"
import type { Memory } from "@/types/memory/memory"

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
jest.mock("@/lib/sync/companion-sync", () => ({ runSyncDown: jest.fn().mockResolvedValue([]) }))
jest.mock("@/lib/db/memories", () => ({
  listMemories: jest.fn(),
  setMemoryPinned: jest.fn(),
  updateMemory: jest.fn(),
  hardDeleteMemory: jest.fn(),
}))
jest.mock("@/components/interactions/pull-to-refresh", () => ({
  PullToRefresh: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))
jest.mock("@/components/memory/memory-row", () => ({
  MemoryRow: ({ memory }: { memory: { id: string; text: string } }) => (
    <div data-testid={`memory-row-${memory.id}`}>{memory.text}</div>
  ),
}))

const liveQuery = useLiveQuery as jest.Mock

function mem(over: Partial<Memory>): Memory {
  return { id: "m1", text: "remember milk", key: "groceries", ...over } as unknown as Memory
}

describe("<MemoryMobileBody />", () => {
  it("renders the memory list", () => {
    liveQuery.mockReturnValue([mem({ id: "m1", text: "remember milk" })])
    render(<MemoryMobileBody />)
    expect(screen.getByTestId("memory-row-m1")).toBeInTheDocument()
  })

  it("filters memories by the search query", async () => {
    liveQuery.mockReturnValue([
      mem({ id: "m1", text: "remember milk" }),
      mem({ id: "m2", text: "buy bread" }),
    ])
    const user = userEvent.setup()
    render(<MemoryMobileBody />)
    await user.type(screen.getByTestId("mobile-memory-search"), "milk")
    expect(screen.getByTestId("memory-row-m1")).toBeInTheDocument()
    expect(screen.queryByTestId("memory-row-m2")).not.toBeInTheDocument()
  })

  it("shows the empty state when there are no memories", () => {
    liveQuery.mockReturnValue([])
    render(<MemoryMobileBody />)
    expect(screen.getByTestId("empty-state")).toBeInTheDocument()
    expect(screen.getByTestId("mobile-spot-icon-memory")).toBeInTheDocument()
  })
})
