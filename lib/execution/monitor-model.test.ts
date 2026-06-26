import {
  buildExecutionMonitorModel,
  countRunningRows,
  mapRunStatus,
  mapExecStatus,
} from "./monitor-model"
import type { ExecutionLegSnapshot } from "./types"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { TaskExecution } from "@/types/scheduler"

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
