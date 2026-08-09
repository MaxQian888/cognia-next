import {
  buildExecutionMonitorModel,
  countRunningRows,
  countExecutionRowsByKind,
  elapsedPartsFrom,
  executionRowFilterKind,
  EXECUTION_FILTER_KINDS,
  mapRunStatus,
  mapExecStatus,
} from "./monitor-model"
import type { UnifiedExecutionRow } from "./monitor-model"
import type { ExecutionLegSnapshot } from "./types"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { TaskExecution } from "@/types/scheduler"
import type { ExecutionRun } from "@/types/execution/run"

const leg = (o: Partial<ExecutionLegSnapshot> = {}): ExecutionLegSnapshot => ({
  id: "leg1",
  kind: "connector",
  resource: "ai-turn",
  label: "WeCom reply",
  weight: 1,
  exempt: false,
  state: "running",
  startedAt: 1000,
  cancelled: false,
  ...o,
})

const run = (o: Partial<WorkflowRunRow> = {}): WorkflowRunRow =>
  ({
    id: "run1",
    workflowId: "wf1",
    status: "running",
    triggerKind: "trigger.manual",
    triggerPayload: {},
    startedAt: 2000,
    workflowSnapshot: { name: "Nightly digest" },
    ...o,
  }) as WorkflowRunRow

const exec = (o: Partial<TaskExecution> = {}): TaskExecution =>
  ({
    id: "ex1",
    taskId: "task1",
    taskName: "Backup",
    taskType: "backup",
    status: "running",
    retryAttempt: 0,
    startedAt: new Date(3000),
    logs: [],
    ...o,
  }) as TaskExecution

describe("buildExecutionMonitorModel", () => {
  it("merges all three sources, newest first", () => {
    const rows = buildExecutionMonitorModel({
      brokerLegs: [leg()],
      workflowRuns: [run()],
      schedulerExecutions: [exec()],
    })
    expect(rows.map((r) => r.source)).toEqual(["scheduled", "workflow", "broker"])
    expect(rows.map((r) => r.rowId)).toEqual(["scheduled:ex1", "workflow:run1", "broker:leg1"])
  })

  it("uses canonical journal rows and suppresses matching legacy workflow rows", () => {
    const executionRun: ExecutionRun = {
      id: "execution:workflow:run1",
      kind: "workflow",
      sourceId: "run1",
      title: "Canonical workflow",
      status: "running",
      currentRevision: 1,
      startedAt: 2500,
      updatedAt: 2500,
    }
    const rows = buildExecutionMonitorModel({
      brokerLegs: [],
      executionRuns: [executionRun],
      workflowRuns: [run()],
    })
    expect(rows).toEqual([
      expect.objectContaining({
        rowId: "journal:execution:workflow:run1",
        source: "journal",
        label: "Canonical workflow",
      }),
    ])
  })

  it("keeps the cancellable broker projection when it matches a canonical live run", () => {
    const executionRun: ExecutionRun = {
      id: "execution:agent:session-1:turn-1",
      kind: "agent-turn",
      sourceId: "turn-1",
      sessionId: "session-1",
      title: "Canonical chat",
      status: "running",
      currentRevision: 1,
      startedAt: 1000,
      updatedAt: 1000,
    }

    const rows = buildExecutionMonitorModel({
      brokerLegs: [leg({ id: "leg-chat", kind: "chat", sessionId: "session-1" })],
      executionRuns: [executionRun],
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      rowId: "broker:leg-chat",
      source: "broker",
      cancellable: true,
    })
  })

  it("maps broker leg state + cancelled into a unified status", () => {
    const [running] = buildExecutionMonitorModel({ brokerLegs: [leg()] })
    expect(running.status).toBe("running")
    expect(running.cancellable).toBe(true)
    expect(running.legId).toBe("leg1")

    const [queued] = buildExecutionMonitorModel({ brokerLegs: [leg({ state: "queued" })] })
    expect(queued.status).toBe("queued")

    const [cancelled] = buildExecutionMonitorModel({ brokerLegs: [leg({ cancelled: true })] })
    expect(cancelled.status).toBe("cancelled")
    expect(cancelled.cancellable).toBe(false)
  })

  it("keeps only active workflow runs", () => {
    const rows = buildExecutionMonitorModel({
      brokerLegs: [],
      workflowRuns: [
        run({ id: "a", status: "running" }),
        run({ id: "b", status: "succeeded" }),
        run({ id: "c", status: "paused" }),
        run({ id: "d", status: "failed" }),
      ],
    })
    expect(rows.map((r) => r.nativeId).sort()).toEqual(["a", "c"])
    expect(rows.find((r) => r.nativeId === "c")?.status).toBe("waiting")
  })

  it("keeps only active scheduler executions and derives the label/kind", () => {
    const rows = buildExecutionMonitorModel({
      brokerLegs: [],
      schedulerExecutions: [
        exec({ id: "a", status: "running", taskName: "Sync", taskType: "sync" }),
        exec({ id: "b", status: "completed" }),
        exec({ id: "c", status: "pending" }),
      ],
    })
    expect(rows.map((r) => r.nativeId).sort()).toEqual(["a", "c"])
    const a = rows.find((r) => r.nativeId === "a")!
    expect(a.label).toBe("Sync")
    expect(a.kind).toBe("sync")
    expect(rows.find((r) => r.nativeId === "c")?.status).toBe("queued")
  })

  it("derives the workflow label from title → snapshot name → id", () => {
    const titled = buildExecutionMonitorModel({
      brokerLegs: [],
      workflowRuns: [run({ title: "T" })],
    })
    expect(titled[0].label).toBe("T")
    const named = buildExecutionMonitorModel({ brokerLegs: [], workflowRuns: [run()] })
    expect(named[0].label).toBe("Nightly digest")
    const bare = buildExecutionMonitorModel({
      brokerLegs: [],
      workflowRuns: [run({ title: undefined, workflowSnapshot: undefined as never })],
    })
    expect(bare[0].label).toBe("wf1")
  })

  it("filters by project (scoped rows must match; unscoped rows always shown)", () => {
    const rows = buildExecutionMonitorModel({
      brokerLegs: [
        leg({ id: "mine", projectId: "p1" }),
        leg({ id: "theirs", projectId: "p2" }),
        leg({ id: "global", projectId: undefined }),
      ],
      workflowRuns: [
        run({ id: "wfMine", projectId: "p1" }),
        run({ id: "wfOther", projectId: "p2" }),
      ],
      projectId: "p1",
    })
    const ids = rows.map((r) => r.nativeId).sort()
    expect(ids).toEqual(["global", "mine", "wfMine"])
  })

  it("handles a numeric startedAt on scheduler executions", () => {
    const rows = buildExecutionMonitorModel({
      brokerLegs: [],
      schedulerExecutions: [exec({ startedAt: 4242 as unknown as Date })],
    })
    expect(rows[0].startedAt).toBe(4242)
  })

  it("countRunningRows counts only running rows", () => {
    const rows = buildExecutionMonitorModel({
      brokerLegs: [leg({ id: "r", state: "running" }), leg({ id: "q", state: "queued" })],
    })
    expect(countRunningRows(rows)).toBe(1)
  })

  it("returns an empty list when no sources have rows", () => {
    expect(buildExecutionMonitorModel({ brokerLegs: [] })).toEqual([])
  })

  it("mapRunStatus covers every RunStatus", () => {
    expect(mapRunStatus("running")).toBe("running")
    expect(mapRunStatus("pending")).toBe("queued")
    expect(mapRunStatus("waiting")).toBe("waiting")
    expect(mapRunStatus("paused")).toBe("waiting")
    expect(mapRunStatus("succeeded")).toBe("done")
    expect(mapRunStatus("failed")).toBe("error")
    expect(mapRunStatus("cancelled")).toBe("cancelled")
  })

  it("mapExecStatus covers every TaskExecutionStatus", () => {
    expect(mapExecStatus("running")).toBe("running")
    expect(mapExecStatus("pending")).toBe("queued")
    expect(mapExecStatus("completed")).toBe("done")
    expect(mapExecStatus("skipped")).toBe("done")
    expect(mapExecStatus("failed")).toBe("error")
    expect(mapExecStatus("cancelled")).toBe("cancelled")
  })
})

const row = (o: Partial<UnifiedExecutionRow> = {}): UnifiedExecutionRow => ({
  rowId: "broker:leg1",
  source: "broker",
  nativeId: "leg1",
  kind: "connector",
  label: "WeCom reply",
  status: "running",
  startedAt: 1,
  cancellable: true,
  ...o,
})

describe("executionRowFilterKind", () => {
  it("normalizes workflow-run and scheduler rows off their source", () => {
    expect(executionRowFilterKind(row({ source: "workflow", kind: "workflow" }))).toBe("workflow")
    // A scheduler row's display kind is the raw taskType — still filters as "scheduled".
    expect(executionRowFilterKind(row({ source: "scheduled", kind: "backup" }))).toBe("scheduled")
  })

  it("uses the leg kind for broker rows", () => {
    expect(executionRowFilterKind(row({ source: "broker", kind: "team" }))).toBe("team")
    expect(executionRowFilterKind(row({ source: "broker", kind: "workflow-step" }))).toBe(
      "workflow-step"
    )
  })
})

describe("countExecutionRowsByKind", () => {
  it("tallies rows by filterable kind with every kind present", () => {
    const counts = countExecutionRowsByKind([
      row({ rowId: "a", source: "broker", kind: "chat" }),
      row({ rowId: "b", source: "broker", kind: "chat" }),
      row({ rowId: "c", source: "workflow", kind: "workflow" }),
      row({ rowId: "d", source: "scheduled", kind: "backup" }),
    ])
    expect(counts.chat).toBe(2)
    expect(counts.workflow).toBe(1)
    expect(counts.scheduled).toBe(1)
    expect(counts.team).toBe(0)
    // Keyed by exactly the known filter kinds.
    expect(Object.keys(counts).sort()).toEqual([...EXECUTION_FILTER_KINDS].sort())
  })
})

describe("elapsedPartsFrom", () => {
  it("splits elapsed seconds into h/m/s", () => {
    expect(elapsedPartsFrom(0, 5_000)).toEqual({ hours: 0, minutes: 0, seconds: 5 })
    expect(elapsedPartsFrom(0, 90_000)).toEqual({ hours: 0, minutes: 1, seconds: 30 })
    expect(elapsedPartsFrom(0, 3_661_000)).toEqual({ hours: 1, minutes: 1, seconds: 1 })
  })

  it("clamps negative skew to zero", () => {
    expect(elapsedPartsFrom(10_000, 5_000)).toEqual({ hours: 0, minutes: 0, seconds: 0 })
  })
})
