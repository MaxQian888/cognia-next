import { renderHook, waitFor, act } from "@testing-library/react"

import { useExecutionRunDetail } from "./use-execution-run-detail"
import type { ExecutionRun, RunEvent } from "@/types/execution/run"

let mockPairing = 0
jest.mock("@/lib/tauri/transport-companion", () => ({
  getCompanionConfigGeneration: () => mockPairing,
}))
let sources: unknown
let mockProfile = "desktop"
let mockTarget: { call: jest.Mock } | null = null
const mockRead = jest.fn()
jest.mock("@/hooks/use-host-profile", () => ({ useHostProfile: () => mockProfile }))
jest.mock("@/lib/tauri", () => ({ transport: { call: (...args: unknown[]) => mockRead(...args) } }))
jest.mock("@/lib/tauri/transport-routing", () => ({
  getActiveRemoteTransport: () => mockTarget,
  subscribeActiveRemoteTransport: () => () => {},
}))
jest.mock("@/lib/execution/run-detail-source", () => ({ readExecutionRunDetailSources: jest.fn() }))
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => sources,
}))

jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))
jest.mock("@/lib/db/execution-runs", () => ({
  getExecutionRun: jest.fn(),
  listVisibleExecutionRunEvents: jest.fn(),
}))

function run(over: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id: "run-1",
    kind: "agent-turn",
    sourceId: "turn-1",
    title: "Chat run",
    status: "running",
    currentRevision: 5,
    startedAt: 1,
    updatedAt: 2,
    latestSnapshot: {
      runId: "run-1",
      kind: "agent-turn",
      title: "Chat run",
      status: "running",
      revision: 5,
      startedAt: 1,
      updatedAt: 2,
      progress: { completed: 0, total: 0, trustworthy: false },
      activeSteps: [],
      recentSteps: [],
      pendingSteps: [],
      pendingStepCount: 0,
      elapsedMs: 1,
      artifacts: [
        {
          id: "v1",
          title: "Tests",
          kind: "verification",
          verification: { conclusion: "passed", passed: 9, failed: 0, skipped: 1, total: 10 },
        },
      ],
      allowedActions: ["stop"],
    },
    ...over,
  }
}

function changeEvent(path: string): RunEvent {
  return {
    id: `e-${path}`,
    runId: "run-1",
    seq: 1,
    ts: 1,
    type: "resource.changed",
    visibility: "private",
    payload: { path, kind: "modified" },
  }
}

beforeEach(() => {
  mockPairing = 0
  sources = undefined
  mockProfile = "desktop"
  mockTarget = null
  mockRead.mockReset()
})

describe("useExecutionRunDetail", () => {
  it("reports no work and no loading when nothing is selected", () => {
    const { result } = renderHook(() => useExecutionRunDetail(undefined))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.run).toBeUndefined()
    expect(result.current.detail.changes).toEqual([])
  })

  it("is loading until the query resolves", () => {
    const { result } = renderHook(() => useExecutionRunDetail("run-1"))
    expect(result.current.isLoading).toBe(true)
  })

  it("projects verification artifacts and private changes together", () => {
    sources = { run: run(), events: [changeEvent("src/a.ts")], interrupts: [] }
    const { result } = renderHook(() => useExecutionRunDetail("run-1"))
    expect(result.current.detail.verifications).toHaveLength(1)
    expect(result.current.detail.changes.map((c) => c.path)).toEqual(["src/a.ts"])
    expect(result.current.journalAvailable).toBe(true)
  })

  /**
   * The mobile companion case: `executionRuns` syncs, `executionRunEvents` does
   * not. "No files changed" and "the journal is not on this device" are
   * different claims and must not be collapsed.
   */
  it("flags the journal as unavailable when a live run's events did not travel", () => {
    sources = { run: run({ currentRevision: 5 }), events: [], interrupts: [] }
    const { result } = renderHook(() => useExecutionRunDetail("run-1"))
    expect(result.current.journalAvailable).toBe(false)
    expect(result.current.detail.changes).toEqual([])
  })

  it("does not cry unavailable for a run that has genuinely journalled nothing yet", () => {
    sources = { run: run({ currentRevision: 0 }), events: [], interrupts: [] }
    const { result } = renderHook(() => useExecutionRunDetail("run-1"))
    expect(result.current.journalAvailable).toBe(true)
  })

  it("orders approvals newest first", () => {
    sources = {
      run: run(),
      events: [changeEvent("a")],
      interrupts: [
        { id: "i2", runId: "run-1", createdAt: 200, status: "pending" },
        { id: "i1", runId: "run-1", createdAt: 100, status: "approved" },
      ],
    }
    const { result } = renderHook(() => useExecutionRunDetail("run-1"))
    expect(result.current.interrupts.map((i) => i.id)).toEqual(["i2", "i1"])
  })

  it("handles a run id that no longer resolves", () => {
    sources = { run: undefined, events: [], interrupts: [] }
    const { result } = renderHook(() => useExecutionRunDetail("gone"))
    expect(result.current.run).toBeUndefined()
    expect(result.current.isLoading).toBe(false)
    expect(result.current.journalAvailable).toBe(true)
  })
  it("reads exact approval details from the selected host without local interrupt sync", async () => {
    mockProfile = "cloud-companion"
    sources = { run: run({ kind: "bot" }), events: [], interrupts: [] }
    const approval = {
      id: "approval",
      runId: "run-1",
      status: "pending",
      approvalDetail: { snapshot: { id: "sha", diff: "exact diff" } },
    }
    mockRead.mockResolvedValue({
      run: run({ kind: "bot" }),
      events: [],
      interrupts: [approval],
      botResult: { status: "completed", output: { review: "review" } },
    })
    const { result } = renderHook(() => useExecutionRunDetail("run-1"))
    await waitFor(() => expect(result.current.interrupts).toEqual([approval]))
    expect(mockRead).toHaveBeenCalledWith("execution_run_detail", { runId: "run-1" })
    expect(result.current.botResult).toEqual({ status: "completed", output: { review: "review" } })
    expect(result.current.journalAvailable).toBe(true)
  })

  it("does not display stale approvals from another host or failed host reads", async () => {
    sources = { run: run(), events: [], interrupts: [{ id: "local-stale" }] }
    const first = {
      call: jest
        .fn()
        .mockResolvedValue({ run: run(), events: [], interrupts: [{ id: "host-one" }] }),
    }
    mockTarget = first
    const { result, rerender } = renderHook(() => useExecutionRunDetail("run-1"))
    await waitFor(() => expect(result.current.interrupts).toEqual([{ id: "host-one" }]))
    mockTarget = { call: jest.fn().mockRejectedValue(new Error("offline")) }
    rerender()
    expect(result.current.interrupts).toEqual([])
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.journalAvailable).toBe(false)
  })

  it("drops an old response after a selected run changes", async () => {
    mockProfile = "mobile-companion"
    let resolveOld!: (value: unknown) => void
    mockRead
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve
          })
      )
      .mockResolvedValueOnce({ run: run({ id: "run-2" }), events: [], interrupts: [{ id: "new" }] })
    const { result, rerender } = renderHook(({ id }) => useExecutionRunDetail(id), {
      initialProps: { id: "run-1" },
    })
    rerender({ id: "run-2" })
    await waitFor(() => expect(result.current.interrupts).toEqual([{ id: "new" }]))
    await act(async () => resolveOld({ run: run(), events: [], interrupts: [{ id: "old" }] }))
    expect(result.current.interrupts).toEqual([{ id: "new" }])
  })
})

it("clears approval artifacts when a companion pairing changes without replacing transport", async () => {
  mockProfile = "cloud-companion"
  mockRead
    .mockResolvedValueOnce({ run: run(), events: [], interrupts: [{ id: "old-approval" }] })
    .mockRejectedValue(new Error("new pairing offline"))
  const { result } = renderHook(() => useExecutionRunDetail("run-1"))
  await waitFor(() => expect(result.current.interrupts).toHaveLength(1))
  act(() => {
    mockPairing += 1
    window.dispatchEvent(new Event("cognia:companion-config-changed"))
  })
  expect(result.current.interrupts).toEqual([])
  await waitFor(() => expect(result.current.isLoading).toBe(false))
})
