jest.mock("@/lib/task-workspace/client", () => ({ settleTaskWorkspaceTurn: jest.fn() }))
jest.mock("./client", () => ({ endCodeAdoptionTurn: jest.fn() }))
jest.mock("./persist", () => ({
  persistCodeAdoptionTurn: jest.fn(),
  pruneCodeAdoptionTurns: jest.fn(),
}))
jest.mock("@/stores/chat/chat-store", () => ({ useChatStore: { subscribe: jest.fn() } }))
jest.mock("@/stores/task-workspace-store", () => ({
  useTaskWorkspaceStore: {
    getState: () => ({ activeBySession: { s1: { workspaceRoot: "/repo" } } }),
  },
}))

import { settleTaskWorkspaceTurn } from "@/lib/task-workspace/client"
import { useChatStore } from "@/stores/chat/chat-store"

import { endCodeAdoptionTurn } from "./client"
import { persistCodeAdoptionTurn, pruneCodeAdoptionTurns } from "./persist"
import { isSettleEdge, startCodeAdoptionTracker } from "./turn-tracker"

const mockSettleTaskWorkspace = settleTaskWorkspaceTurn as jest.Mock
const mockSubscribe = useChatStore.subscribe as unknown as jest.Mock
const mockEnd = endCodeAdoptionTurn as jest.Mock
const mockPersist = persistCodeAdoptionTurn as jest.Mock
const mockPrune = pruneCodeAdoptionTurns as jest.Mock

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => jest.clearAllMocks())

describe("isSettleEdge", () => {
  it.each([
    ["streaming", "idle", true],
    ["streaming", "error", true],
    ["awaiting_approval", "idle", true],
    ["awaiting_approval", "error", true],
    ["streaming", "awaiting_approval", false],
    ["idle", "streaming", false],
    [undefined, "idle", false],
  ])("%s -> %s = %s", (before, now, expected) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(isSettleEdge(before as any, now as any)).toBe(expected)
  })
})

describe("startCodeAdoptionTracker", () => {
  function wire() {
    const storeUnsub = jest.fn()
    mockSubscribe.mockReturnValue(storeUnsub)
    const ret = startCodeAdoptionTracker()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = mockSubscribe.mock.calls[0][0] as (s: any, p: any) => void
    return { fn, storeUnsub, ret }
  }

  it("ends and persists on a settle edge", async () => {
    const row = { id: "s1:3" }
    mockEnd.mockResolvedValue(row)
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 3 } } },
      { sessions: { s1: { status: "streaming", runId: 3 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 3, "ready")
    expect(mockEnd).toHaveBeenCalledWith("s1:3")
    expect(mockPersist).toHaveBeenCalledWith(row)
    expect(mockPrune).toHaveBeenCalled()
  })

  it("does nothing without a settle edge", async () => {
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "awaiting_approval", runId: 3 } } },
      { sessions: { s1: { status: "streaming", runId: 3 } } }
    )
    await flush()
    expect(mockEnd).not.toHaveBeenCalled()
  })

  it("skips persist when the turn was not tracked", async () => {
    mockEnd.mockResolvedValue(null)
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "error", runId: 1 } } },
      { sessions: { s1: { status: "streaming", runId: 1 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 1, "failed")
    expect(mockEnd).toHaveBeenCalledWith("s1:1")
    expect(mockPersist).not.toHaveBeenCalled()
    expect(mockPrune).not.toHaveBeenCalled()
  })

  it("returns the store unsubscribe", () => {
    const { ret, storeUnsub } = wire()
    expect(ret).toBe(storeUnsub)
  })

  it("projects agent-only adoption metrics from the authoritative task ledger", async () => {
    mockSettleTaskWorkspace.mockResolvedValue([
      {
        path: "agent.ts",
        origin: "agent",
        kind: "modified",
        insertions: 4,
        deletions: 1,
      },
      { path: "notes.txt", origin: "user", kind: "created", insertions: 2, deletions: 0 },
    ])
    mockEnd.mockResolvedValue(null)
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 3 } } },
      { sessions: { s1: { status: "streaming", runId: 3 } } }
    )
    await flush()
    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "s1:3",
        workspaceRoot: "/repo",
        totalFiles: 1,
        totalAdded: 4,
        totalRemoved: 1,
      })
    )
  })
})
