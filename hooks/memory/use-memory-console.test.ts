/** @jest-environment jsdom */
import { act, renderHook, waitFor } from "@testing-library/react"
import type { Memory } from "@/types/memory/memory"

let mockData: Memory[] | undefined = []
jest.mock("@/hooks/ui", () => ({
  useLiveQueryState: () => ({ data: mockData, isLoading: mockData === undefined, isEmpty: false }),
}))
jest.mock("@/hooks/data", () => ({ useClientLiveQuery: () => [] }))

const mockToast = { error: jest.fn(), success: jest.fn(), warning: jest.fn() }
jest.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToast.error(...args),
    warning: (...args: unknown[]) => mockToast.warning(...args),
    success: (...args: unknown[]) => mockToast.success(...args),
  },
}))

const mockRun = jest.fn()
jest.mock("@/hooks/memory/use-memory-command", () => ({
  useMemoryCommand: () => ({ run: mockRun, authority: "local" }),
}))
jest.mock("@/lib/db/memories", () => ({
  listMemories: jest.fn(),
  listMemoryRevisions: jest.fn(),
}))
jest.mock("@/lib/db/memory-governance", () => ({
  listMemoryEvidence: jest.fn(),
  listMemoryAuditEvents: jest.fn(),
}))

import { useMemoryConsole } from "./use-memory-console"

let seq = 0
function mem(over: Partial<Memory> = {}): Memory {
  seq += 1
  return {
    id: over.id ?? `m${seq}`,
    scope: "global",
    type: "semantic",
    text: `memory ${seq}`,
    tags: [],
    importance: 5,
    createdAt: 1,
    updatedAt: seq,
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
  jest.clearAllMocks()
  seq = 0
  mockData = []
  mockRun.mockResolvedValue(true)
  window.history.replaceState({}, "", "/memory")
})

describe("useMemoryConsole", () => {
  it("opens a deep-linked memory and mirrors the selection into ?id=", async () => {
    mockData = [mem({ id: "a" })]
    const { result } = renderHook(() => useMemoryConsole({ initialSelectedId: "a" }))
    expect(result.current.selectedMemory?.id).toBe("a")
    await waitFor(() => expect(window.location.search).toBe("?id=a"))
    act(() => result.current.close())
    await waitFor(() => expect(window.location.search).toBe(""))
  })

  it("opens into the editor only when asked", () => {
    mockData = [mem({ id: "a" })]
    const { result } = renderHook(() => useMemoryConsole())
    act(() => result.current.open("a", { edit: true }))
    expect(result.current.editRequested).toBe(true)
    act(() => result.current.navigate(1))
    expect(result.current.editRequested).toBe(false)
  })

  it("archives without asking and offers an undo that restores exactly what landed", async () => {
    mockData = [mem({ id: "a" }), mem({ id: "b" })]
    mockRun.mockImplementation(async (command: { id: string }) => command.id === "a")
    const { result } = renderHook(() => useMemoryConsole())
    await act(async () => {
      await result.current.archive(["a", "b"])
    })
    const [message, options] = mockToast.success.mock.calls[0] as [
      string,
      { action: { onClick: () => void } },
    ]
    expect(message).toContain("1")
    // The failed row stays selected for a retry.
    expect([...result.current.selectedIds]).toEqual(["b"])
    mockRun.mockClear()
    await act(async () => options.action.onClick())
    await waitFor(() => expect(mockRun).toHaveBeenCalledWith({ kind: "restore", id: "a" }))
    expect(mockRun).not.toHaveBeenCalledWith({ kind: "restore", id: "b" })
  })

  it("never deletes without the confirmation", async () => {
    mockData = [mem({ id: "a" })]
    const { result } = renderHook(() => useMemoryConsole())
    act(() => result.current.requestDelete(["a"]))
    expect(result.current.pendingDelete).toEqual(["a"])
    expect(mockRun).not.toHaveBeenCalled()
    await act(async () => {
      await result.current.confirmDelete()
    })
    expect(mockRun).toHaveBeenCalledWith({ kind: "delete", id: "a" })
    expect(result.current.pendingDelete).toBeNull()
  })

  it("clears the selection when the view changes", () => {
    mockData = [mem({ id: "a" })]
    const { result } = renderHook(() => useMemoryConsole())
    act(() => result.current.startSelecting("a"))
    expect(result.current.selecting).toBe(true)
    act(() => result.current.setView("archived"))
    expect(result.current.selectedIds.size).toBe(0)
    expect(result.current.selecting).toBe(false)
    expect(result.current.archivedView).toBe(true)
  })

  it("moves a memory and says so", async () => {
    mockData = [mem({ id: "a" })]
    const { result } = renderHook(() => useMemoryConsole())
    act(() => result.current.setMoveId("a"))
    expect(result.current.moveMemory?.id).toBe("a")
    await act(async () => {
      await result.current.relocate("a", { scope: "workspace", projectId: "p1" })
    })
    expect(mockRun).toHaveBeenCalledWith({
      kind: "relocate",
      id: "a",
      target: { scope: "workspace", projectId: "p1" },
    })
    expect(mockToast.success).toHaveBeenCalled()
  })

  it("filters to the deep-linked workspace and toggles tag filters", () => {
    mockData = [
      mem({ id: "a", scope: "workspace", projectId: "p1", tags: ["x"] }),
      mem({ id: "b", scope: "workspace", projectId: "p2" }),
    ]
    const { result } = renderHook(() => useMemoryConsole({ initialProjectId: "p1" }))
    expect(result.current.rows.map((row) => row.id)).toEqual(["a"])
    act(() => result.current.toggleTag("x"))
    expect(result.current.filter.tags).toEqual(["x"])
    act(() => result.current.toggleTag("x"))
    expect(result.current.filter.tags).toEqual([])
  })
})
