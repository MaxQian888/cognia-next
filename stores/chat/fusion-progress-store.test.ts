/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react"
import type { RouterFusionRunSummary } from "@cognia/agent-config-types"

import { useFusionProgress, useFusionProgressStore } from "./fusion-progress-store"

const summary = (runId: string, spentMicrousd = 10): RouterFusionRunSummary => ({
  runId,
  mode: "panel",
  actionId: "panel_review",
  ruleId: null,
  status: "running",
  qualityStatus: null,
  roles: {},
  capMicrousd: 2_000_000,
  spentMicrousd,
  modelCalls: 1,
  costStatus: "pending",
  errorCode: null,
  timeline: {
    phases: [],
    calls: { started: 1, finished: 0, unknown: 0 },
    candidates: { members: null, rejected: 0, evidenceRejected: 0 },
    judge: null,
    escalated: null,
    degraded: null,
    verification: null,
    compactions: 0,
  },
})

beforeEach(() => useFusionProgressStore.setState({ bySession: {} }))

describe("fusion progress store", () => {
  it("tracks a session's run from start through its folds to the end", () => {
    const store = useFusionProgressStore.getState()
    store.start("s1", { runId: "r1", mode: "panel", startedAt: 5, capMicrousd: 2_000_000 })
    expect(useFusionProgressStore.getState().bySession.s1).toEqual({
      runId: "r1",
      mode: "panel",
      startedAt: 5,
      capMicrousd: 2_000_000,
      summary: null,
    })
    store.update("s1", summary("r1", 42))
    expect(useFusionProgressStore.getState().bySession.s1?.summary?.spentMicrousd).toBe(42)
    store.clear("s1")
    expect(useFusionProgressStore.getState().bySession).toEqual({})
  })

  it("drops a fold for another run or a session with nothing in flight", () => {
    const store = useFusionProgressStore.getState()
    store.update("s1", summary("r1"))
    expect(useFusionProgressStore.getState().bySession).toEqual({})
    store.start("s1", { runId: "r2", mode: "cascade", startedAt: 1, capMicrousd: 1 })
    const before = useFusionProgressStore.getState().bySession
    store.update("s1", summary("r1"))
    expect(useFusionProgressStore.getState().bySession).toBe(before)
  })

  it("leaves a newer run in place when an older turn clears by its run id", () => {
    const store = useFusionProgressStore.getState()
    store.start("s1", { runId: "r2", mode: "cascade", startedAt: 1, capMicrousd: 1 })
    store.clear("s1", "r1")
    expect(useFusionProgressStore.getState().bySession.s1?.runId).toBe("r2")
    store.clear("s1", "r2")
    expect(useFusionProgressStore.getState().bySession.s1).toBeUndefined()
    store.clear("s9")
  })

  it("re-renders the session's subscriber and nobody without a session", () => {
    const { result } = renderHook(() => useFusionProgress("s1"))
    const none = renderHook(() => useFusionProgress(null))
    expect(result.current).toBeNull()
    act(() =>
      useFusionProgressStore
        .getState()
        .start("s1", { runId: "r1", mode: "panel", startedAt: 1, capMicrousd: 1 })
    )
    expect(result.current?.runId).toBe("r1")
    expect(none.result.current).toBeNull()
  })
})
