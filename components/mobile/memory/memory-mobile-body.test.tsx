/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"

import { MemoryMobileBody } from "./memory-mobile-body"
import { useLiveQuery } from "dexie-react-hooks"
import type { Memory } from "@/types/memory/memory"

const enqueueMock = jest.fn()
const pinMock = jest.fn()
const updateMock = jest.fn()
const invalidateMock = jest.fn()

jest.mock("dexie-react-hooks", () => ({ useLiveQuery: jest.fn() }))
// jsdom has no layout — render every item so count/text assertions hold.
const scrollToIndexMock = jest.fn()
jest.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 104,
        size: 104,
        end: (index + 1) * 104,
        lane: 0,
      })),
    getTotalSize: () => count * 104,
    measureElement: jest.fn(),
    scrollToIndex: (...args: unknown[]) => scrollToIndexMock(...args),
  }),
}))
const mobileToastError = jest.fn()
jest.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => mobileToastError(...args), success: jest.fn() },
}))
jest.mock("@/lib/sync/companion-sync", () => ({ runSyncDown: jest.fn().mockResolvedValue([]) }))
jest.mock("@/lib/db/memories", () => ({
  listMemories: jest.fn(),
  setMemoryPinned: (...args: unknown[]) => pinMock(...args),
  updateMemory: (...args: unknown[]) => updateMock(...args),
  invalidateMemory: (...args: unknown[]) => invalidateMock(...args),
}))
jest.mock("@/lib/db/mobile-outbound-queue", () => ({
  enqueue: (...args: unknown[]) => enqueueMock(...args),
}))
jest.mock("@/components/interactions/pull-to-refresh", () => ({
  PullToRefresh: ({
    children,
    onRefresh,
  }: {
    children: React.ReactNode
    onRefresh: () => Promise<void> | void
  }) => (
    <div>
      <button onClick={() => void onRefresh()}>refresh</button>
      {children}
    </div>
  ),
}))
jest.mock("@/components/memory/memory-row", () => ({
  MemoryRow: ({
    memory,
    onPinToggle,
    onSave,
    onArchive,
  }: {
    memory: { id: string; text: string }
    onPinToggle: (id: string, pinned: boolean) => void
    onSave: (id: string, text: string) => void
    onArchive: (id: string) => void
  }) => (
    <div data-testid={`memory-row-${memory.id}`}>
      {memory.text}
      <button onClick={() => onPinToggle(memory.id, true)}>pin</button>
      <button onClick={() => onSave(memory.id, "updated")}>save</button>
      <button onClick={() => onArchive(memory.id)}>forget</button>
    </div>
  ),
}))

const liveQuery = useLiveQuery as jest.Mock

function mem(over: Partial<Memory>): Memory {
  return { id: "m1", text: "remember milk", key: "groceries", ...over } as unknown as Memory
}

describe("<MemoryMobileBody />", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    enqueueMock.mockResolvedValue({ id: "job-1" })
    pinMock.mockResolvedValue(undefined)
    updateMock.mockResolvedValue(undefined)
    invalidateMock.mockResolvedValue(undefined)
  })

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

  it("queues desktop-authoritative edits before updating the local mirror", async () => {
    liveQuery.mockReturnValue([mem({ id: "m1" })])
    const user = userEvent.setup()
    render(<MemoryMobileBody />)

    await user.click(screen.getByRole("button", { name: "pin" }))
    await user.click(screen.getByRole("button", { name: "save" }))
    await user.click(screen.getByRole("button", { name: "forget" }))

    expect(enqueueMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: "memory_update", payload: { id: "m1", pinned: true } })
    )
    expect(enqueueMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: "memory_update", payload: { id: "m1", text: "updated" } })
    )
    expect(enqueueMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ command: "memory_forget", payload: { id: "m1" } })
    )
    expect(pinMock).toHaveBeenCalledWith("m1", true)
    expect(updateMock).toHaveBeenCalledWith("m1", { text: "updated", bumpVersion: true })
    expect(invalidateMock).toHaveBeenCalledWith("m1")
  })

  it("pull-to-refresh syncs memories down and swallows sync failures", async () => {
    const { runSyncDown } = jest.requireMock("@/lib/sync/companion-sync") as {
      runSyncDown: jest.Mock
    }
    liveQuery.mockReturnValue([mem({ id: "m1" })])
    render(<MemoryMobileBody />)
    fireEvent.click(screen.getByText("refresh"))
    await waitFor(() => expect(runSyncDown).toHaveBeenCalledWith({ only: ["memories"] }))
    runSyncDown.mockRejectedValueOnce(new Error("offline"))
    fireEvent.click(screen.getByText("refresh"))
    await waitFor(() => expect(runSyncDown).toHaveBeenCalledTimes(2))
  })

  it("scrolls the deep-linked memory into view once", () => {
    liveQuery.mockReturnValue([mem({ id: "m1" }), mem({ id: "m2", text: "second" })])
    render(<MemoryMobileBody initialSelectedId="m2" />)
    expect(scrollToIndexMock).toHaveBeenCalledWith(1)
  })

  it("surfaces a toast when the outbound enqueue fails", async () => {
    liveQuery.mockReturnValue([mem({ id: "m1" })])
    enqueueMock.mockRejectedValueOnce(new Error("queue full"))
    render(<MemoryMobileBody />)
    fireEvent.click(screen.getByText("pin"))
    await waitFor(() =>
      expect(mobileToastError).toHaveBeenCalledWith("The memory operation failed — please try again")
    )
    // The optimistic local write must not run when the enqueue failed.
    expect(pinMock).not.toHaveBeenCalled()
  })
})
