import { act, renderHook } from "@testing-library/react"
import type { TaskExecution } from "@/types/scheduler"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { ExecutionRun } from "@/types/execution/run"

// Controlled liveQuery value — set per test before render.
let liveValue:
  | {
      executionRuns: ExecutionRun[]
      workflowRuns: WorkflowRunRow[]
      schedulerExecutions: TaskExecution[]
    }
  | undefined

jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveValue,
}))
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))
jest.mock("@/lib/db/execution-runs", () => ({ listExecutionRuns: jest.fn() }))
jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: { getRecentExecutions: jest.fn() },
}))

import { useExecutionMonitor } from "./use-execution-monitor"
import {
  ExecutionBroker,
  __resetExecutionBrokerForTesting,
  getExecutionBroker,
} from "@/lib/execution/broker"
import type { ExecutionLease } from "@/lib/execution/types"

const run = (o: Partial<WorkflowRunRow>): WorkflowRunRow =>
  ({
    id: "run1",
    workflowId: "wf1",
    status: "running",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 5000,
    workflowSnapshot: { name: "WF" },
    ...o,
  }) as WorkflowRunRow

beforeEach(() => {
  liveValue = undefined
  __resetExecutionBrokerForTesting(new ExecutionBroker({ limits: { "ai-turn": 5 } }))
})
afterEach(() => __resetExecutionBrokerForTesting())

describe("useExecutionMonitor", () => {
  it("is loading until the persisted sources resolve", () => {
    const { result } = renderHook(() => useExecutionMonitor())
    expect(result.current.isLoading).toBe(true)
    expect(result.current.rows).toEqual([])
  })

  it("merges broker legs with the persisted sources and reacts to broker changes", async () => {
    liveValue = {
      executionRuns: [],
      workflowRuns: [run({ status: "running" })],
      schedulerExecutions: [],
    }
    const broker = getExecutionBroker()
    const { result } = renderHook(() => useExecutionMonitor())
    expect(result.current.isLoading).toBe(false)
    // Only the workflow run so far.
    expect(result.current.rows.map((r) => r.source)).toEqual(["workflow"])

    let lease: ExecutionLease
    await act(async () => {
      lease = await broker.acquire({ kind: "connector", label: "live leg", sessionId: "s" })
    })
    expect(result.current.rows.map((r) => r.source)).toEqual(["broker", "workflow"])
    expect(result.current.runningCount).toBe(2)

    act(() => lease.release("ok"))
    expect(result.current.rows.map((r) => r.source)).toEqual(["workflow"])
  })

  it("passes the projectId filter through to the model", async () => {
    liveValue = {
      executionRuns: [],
      workflowRuns: [run({ id: "mine", projectId: "p1" }), run({ id: "theirs", projectId: "p2" })],
      schedulerExecutions: [],
    }
    const { result } = renderHook(() => useExecutionMonitor("p1"))
    expect(result.current.rows.map((r) => r.nativeId)).toEqual(["mine"])
  })
})
