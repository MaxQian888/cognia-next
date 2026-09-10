jest.mock("@/lib/task-workspace/client", () => ({ settleTaskWorkspaceTurn: jest.fn() }))
jest.mock("./client", () => ({
  endCodeAdoptionTurn: jest.fn(),
  consumeCodeAdoptionTrackingAttempt: jest.fn(),
}))
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

import { consumeCodeAdoptionTrackingAttempt, endCodeAdoptionTurn } from "./client"
import { persistCodeAdoptionTurn, pruneCodeAdoptionTurns } from "./persist"
import {
  isSettleEdge,
  markTaskWorkspaceTurnCancelled,
  markTaskWorkspaceTurnUnowned,
  startCodeAdoptionTracker,
} from "./turn-tracker"

const mockSettleTaskWorkspace = settleTaskWorkspaceTurn as jest.Mock
const mockSubscribe = useChatStore.subscribe as unknown as jest.Mock
const mockEnd = endCodeAdoptionTurn as jest.Mock
const mockAttempt = consumeCodeAdoptionTrackingAttempt as jest.Mock
const mockPersist = persistCodeAdoptionTurn as jest.Mock
const mockPrune = pruneCodeAdoptionTurns as jest.Mock

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  jest.clearAllMocks()
  mockAttempt.mockReturnValue(undefined)
})

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
  /** Releases handed out by `wire`, so one test's subscription cannot leak. */
  const held: Array<() => void> = []

  afterEach(() => {
    while (held.length) held.pop()?.()
  })

  function wire() {
    const storeUnsub = jest.fn()
    mockSubscribe.mockReturnValue(storeUnsub)
    const ret = startCodeAdoptionTracker()
    held.push(ret)
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
    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({ id: row.id, measurement: "legacyFingerprint" })
    )
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

  it("settles a user-aborted turn as cancelled", async () => {
    mockEnd.mockResolvedValue(null)
    const { fn } = wire()
    markTaskWorkspaceTurnCancelled("s1", 5)
    fn(
      { sessions: { s1: { status: "idle", runId: 5 } } },
      { sessions: { s1: { status: "streaming", runId: 5 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 5, "cancelled")
  })

  it("detaches the store subscription when its last holder releases", () => {
    const { ret, storeUnsub } = wire()
    ret()
    expect(storeUnsub).toHaveBeenCalledTimes(1)
    // Releasing twice must not detach a subscription a later start reopened.
    ret()
    expect(storeUnsub).toHaveBeenCalledTimes(1)
  })

  /**
   * Two chunks mount the initializer — the core-chat one and the
   * workflow-automation one — and outside development the eager boot profile
   * requests both, so this runs twice. Two listeners meant `settleTurn` ran
   * twice per edge, and every mark it consumes is a `Set.delete`: the first
   * subscriber took the mark and the second, seeing none, did the exact thing
   * the mark exists to prevent.
   */
  describe("mounted by more than one boot chunk", () => {
    it("subscribes once and settles once per edge", async () => {
      mockEnd.mockResolvedValue(null)
      const { fn } = wire()
      wire()

      expect(mockSubscribe).toHaveBeenCalledTimes(1)
      fn(
        { sessions: { s1: { status: "idle", runId: 3 } } },
        { sessions: { s1: { status: "streaming", runId: 3 } } }
      )
      await flush()
      expect(mockSettleTaskWorkspace).toHaveBeenCalledTimes(1)
    })

    it("keeps the store attached until the last holder releases", () => {
      const { storeUnsub, ret } = wire()
      const second = wire()

      ret()
      expect(storeUnsub).not.toHaveBeenCalled()
      second.ret()
      expect(storeUnsub).toHaveBeenCalledTimes(1)
    })

    // The mark is consumed by a `Set.delete`, so a second subscriber saw no
    // mark and settled the previous, still-live turn's working copy.
    it("does not let a second mount defeat the unowned mark", async () => {
      mockEnd.mockResolvedValue(null)
      const { fn } = wire()
      wire()
      markTaskWorkspaceTurnUnowned("s1", 9)

      fn(
        { sessions: { s1: { status: "idle", runId: 9 } } },
        { sessions: { s1: { status: "streaming", runId: 9 } } }
      )
      await flush()

      expect(mockSettleTaskWorkspace).not.toHaveBeenCalled()
    })

    // Same hole, older mark: an interrupted turn was settled once as
    // `cancelled` and once as `ready`.
    it("does not let a second mount defeat the cancelled mark", async () => {
      mockEnd.mockResolvedValue(null)
      const { fn } = wire()
      wire()
      markTaskWorkspaceTurnCancelled("s1", 10)

      fn(
        { sessions: { s1: { status: "idle", runId: 10 } } },
        { sessions: { s1: { status: "streaming", runId: 10 } } }
      )
      await flush()

      expect(mockSettleTaskWorkspace).toHaveBeenCalledTimes(1)
      expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 10, "cancelled")
    })
  })

  /**
   * A turn refused the working copy never opened a run of its own, so
   * `activeBySession` still holds the PREVIOUS turn's — very often the live one
   * that caused the refusal. Settling it here tore the working copy out from
   * under a turn whose agent was still streaming.
   */
  it("settles nothing for a turn that never owned the workspace run", async () => {
    mockEnd.mockResolvedValue(null)
    const { fn } = wire()
    markTaskWorkspaceTurnUnowned("s1", 6)
    fn(
      { sessions: { s1: { status: "idle", runId: 6 } } },
      { sessions: { s1: { status: "streaming", runId: 6 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).not.toHaveBeenCalled()
  })

  // The mark names one turn, not the conversation: the next turn does own its
  // run and must settle it.
  it("only skips the turn that was marked", async () => {
    mockEnd.mockResolvedValue(null)
    const { fn } = wire()
    markTaskWorkspaceTurnUnowned("s1", 6)
    fn(
      { sessions: { s1: { status: "idle", runId: 6 } } },
      { sessions: { s1: { status: "streaming", runId: 6 } } }
    )
    await flush()
    fn(
      { sessions: { s1: { status: "idle", runId: 7 } } },
      { sessions: { s1: { status: "streaming", runId: 7 } } }
    )
    await flush()
    expect(mockSettleTaskWorkspace).toHaveBeenCalledTimes(1)
    expect(mockSettleTaskWorkspace).toHaveBeenCalledWith("s1", 7, "ready")
  })

  // The only subscriber to this edge, so a throw here is the last chance
  // anything hears that a turn did not close out.
  it("reports a settle that throws instead of swallowing it", async () => {
    const reported: unknown[][] = []
    const spy = jest
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => void reported.push(args))
    mockSettleTaskWorkspace.mockRejectedValue(new Error("host unreachable"))
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 8 } } },
      { sessions: { s1: { status: "streaming", runId: 8 } } }
    )
    await flush()
    expect(reported).toHaveLength(1)
    expect(reported[0][0]).toBe("code adoption turn settle failed")
    expect(reported[0][1]).toMatchObject({ sessionId: "s1", runId: 8 })
    spy.mockRestore()
  })

  it("projects agent-only adoption metrics from the authoritative task ledger", async () => {
    mockSettleTaskWorkspace.mockResolvedValue([
      {
        path: "agent.ts",
        origin: "agent",
        kind: "modified",
        captureClass: "source",
        insertions: 4,
        deletions: 1,
      },
      {
        path: "dist/bundle.js",
        origin: "agent",
        kind: "created",
        captureClass: "generated",
        insertions: null,
        deletions: null,
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
        measurement: "taskWorkspace",
        adoptionState: "pending",
        proposedAdded: 4,
        acceptedAdded: 0,
      })
    )
  })

  it("persists an unavailable coverage row instead of silently dropping a skipped turn", async () => {
    mockSettleTaskWorkspace.mockResolvedValue(null)
    mockEnd.mockResolvedValue(null)
    mockAttempt.mockReturnValue({
      cwd: "/repo",
      sessionId: "s1",
      runId: 4,
      model: "opus",
      agentKind: "in-app",
      status: "unavailable",
      reason: "concurrent",
    })
    const { fn } = wire()
    fn(
      { sessions: { s1: { status: "idle", runId: 4 } } },
      { sessions: { s1: { status: "streaming", runId: 4 } } }
    )
    await flush()
    expect(mockPersist).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "s1:4",
        trackingState: "unavailable",
        trackingReason: "concurrent",
      })
    )
  })
})
