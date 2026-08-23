/** @jest-environment jsdom */

import { renderHook } from "@testing-library/react"

import { SESSION_VERIFICATION_RUN_LIMIT, useSessionVerifications } from "./use-session-verifications"
import type { ExecutionRun, RunArtifactSnapshot } from "@/types/execution/run"

const listExecutionRuns = jest.fn()
let liveResult: unknown

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (fn: () => unknown) => {
    fn()
    return liveResult
  },
}))
jest.mock("@/lib/db/execution-runs", () => ({
  listExecutionRuns: (...args: unknown[]) => listExecutionRuns(...args),
}))

function verification(over: Partial<RunArtifactSnapshot> = {}): RunArtifactSnapshot {
  return {
    id: "artifact:1",
    title: "Tests",
    kind: "verification",
    verification: { conclusion: "passed", passed: 12, failed: 0, skipped: 1, total: 13 },
    ...over,
  }
}

function run(over: Partial<ExecutionRun> = {}, artifacts: RunArtifactSnapshot[] = []): ExecutionRun {
  const title = (over.title as string) ?? "Ship it"
  return {
    id: "run:1",
    kind: "agent-turn",
    sourceId: "src",
    sessionId: "s1",
    title,
    status: "completed",
    currentRevision: 4,
    startedAt: 1,
    updatedAt: 9,
    latestSnapshot: {
      runId: "run:1",
      kind: "agent-turn",
      title,
      status: "completed",
      revision: 4,
      startedAt: 1,
      updatedAt: 9,
      progress: { completed: 1, total: 1, trustworthy: true },
      activeSteps: [],
      recentSteps: [],
      pendingSteps: [],
      pendingStepCount: 0,
      elapsedMs: 8,
      artifacts,
      allowedActions: [],
    },
    ...over,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  liveResult = undefined
})

describe("useSessionVerifications", () => {
  it("reports loading while the live query has not answered", () => {
    const { result } = renderHook(() => useSessionVerifications("s1"))
    expect(result.current).toEqual({ loading: true, noRuns: false, runs: [] })
  })

  it("queries only this session's runs, bounded", () => {
    liveResult = []
    renderHook(() => useSessionVerifications("s1"))
    expect(listExecutionRuns).toHaveBeenCalledWith({
      sessionId: "s1",
      limit: SESSION_VERIFICATION_RUN_LIMIT,
    })
  })

  it("separates 'nothing synced here' from 'no tests were run'", () => {
    // Both render as an empty list; conflating them would tell someone their
    // tests reported nothing when in fact nothing reached this device.
    liveResult = []
    const { result: empty } = renderHook(() => useSessionVerifications("s1"))
    expect(empty.current).toMatchObject({ noRuns: true, runs: [] })

    liveResult = [run({}, [])]
    const { result: noTests } = renderHook(() => useSessionVerifications("s1"))
    expect(noTests.current).toMatchObject({ noRuns: false, runs: [] })
  })

  it("projects verification artifacts off the synced snapshot", () => {
    liveResult = [run({}, [verification()])]
    const { result } = renderHook(() => useSessionVerifications("s1"))
    expect(result.current.runs).toEqual([
      expect.objectContaining({
        runId: "run:1",
        title: "Ship it",
        status: "completed",
        verifications: [expect.objectContaining({ id: "artifact:1" })],
      }),
    ])
  })

  it("drops non-verification artifacts and runs left with none", () => {
    liveResult = [
      run({ id: "run:a", title: "A" }, [{ id: "doc", title: "Report", kind: "generic" }]),
      run({ id: "run:b", title: "B" }, [verification({ id: "artifact:b" })]),
    ]
    const { result } = renderHook(() => useSessionVerifications("s1"))
    expect(result.current.runs.map((entry) => entry.runId)).toEqual(["run:b"])
    expect(result.current.noRuns).toBe(false)
  })

  it("ignores an artifact typed as a verification with no counts", () => {
    // `kind: "verification"` without a `verification` payload is a producer
    // bug; showing it as a result would invent a test outcome.
    liveResult = [run({}, [{ id: "half", title: "Tests", kind: "verification" }])]
    const { result } = renderHook(() => useSessionVerifications("s1"))
    expect(result.current.runs).toEqual([])
  })

  it("prefers the snapshot title and carries the end time", () => {
    liveResult = [
      run({ title: "Row title", endedAt: 77 }, [verification()]),
    ]
    const { result } = renderHook(() => useSessionVerifications("s1"))
    expect(result.current.runs[0]).toMatchObject({ title: "Row title", endedAt: 77 })
  })

  it("falls back to the row title when a legacy run carries no snapshot", () => {
    liveResult = [{ ...run({ title: "Legacy" }), latestSnapshot: undefined }]
    const { result } = renderHook(() => useSessionVerifications("s1"))
    expect(result.current).toMatchObject({ noRuns: false, runs: [] })
  })
})
