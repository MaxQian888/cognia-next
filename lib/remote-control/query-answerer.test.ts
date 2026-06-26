import { answerRemoteControlQuery } from "./query-answerer"
import type { RemoteControlQueryEvent } from "@/types/remote-control"

const queryResponse = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/remote-control", () => ({
  remoteControlQueryResponse: (...a: unknown[]) => queryResponse(...a),
}))

const hasNoLeakingPii = jest.fn().mockReturnValue(true)
jest.mock("@/lib/twin/ingest/redact", () => ({
  hasNoLeakingPii: (...a: unknown[]) => hasNoLeakingPii(...a),
}))

const getAllTasks = jest.fn()
jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: { getAllTasks: (...a: unknown[]) => getAllTasks(...a) },
}))

const listWorkflowRuns = jest.fn()
jest.mock("@/lib/db/workflows", () => ({
  listWorkflowRuns: (...a: unknown[]) => listWorkflowRuns(...a),
}))

const listGoalsBySession = jest.fn()
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({ listGoalsBySession }),
}))

const listRemoteControlAudit = jest.fn()
jest.mock("@/lib/db/remote-control-audit", () => ({
  listRemoteControlAudit: (...a: unknown[]) => listRemoteControlAudit(...a),
}))

const workflowRunsGet = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({ workflowRuns: { get: (...a: unknown[]) => workflowRunsGet(...a) } }),
}))

const getRemoteRunStatus = jest.fn()
jest.mock("@/lib/db/remote-control-run-status", () => ({
  getRemoteRunStatus: (...a: unknown[]) => getRemoteRunStatus(...a),
}))

function ev(over: Partial<RemoteControlQueryEvent>): RemoteControlQueryEvent {
  return { requestId: "rcq_1", kind: "tasks", params: {}, ...over }
}

/** The payload the answerer posted back for requestId. */
function postedPayload(): Record<string, unknown> {
  const call = queryResponse.mock.calls.at(-1)
  return call?.[1] as Record<string, unknown>
}

describe("answerRemoteControlQuery", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    hasNoLeakingPii.mockReturnValue(true)
  })

  it("answers `tasks` with a summarised, PII-gated task list", async () => {
    getAllTasks.mockResolvedValueOnce([
      {
        id: "t1",
        name: "nightly",
        type: "workflow",
        status: "active",
        runCount: 3,
        successCount: 2,
        failureCount: 1,
        nextRunAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ])
    await answerRemoteControlQuery(ev({ kind: "tasks" }))
    expect(queryResponse).toHaveBeenCalledWith("rcq_1", expect.anything())
    const payload = postedPayload()
    expect(payload.tasks).toEqual([
      expect.objectContaining({ id: "t1", name: "nightly", status: "active", runCount: 3 }),
    ])
  })

  it("drops a task name that fails the PII gate", async () => {
    hasNoLeakingPii.mockReturnValue(false)
    getAllTasks.mockResolvedValueOnce([
      {
        id: "t1",
        name: "ssn 123-45-6789",
        type: "x",
        status: "active",
        runCount: 0,
        successCount: 0,
        failureCount: 0,
      },
    ])
    await answerRemoteControlQuery(ev({ kind: "tasks" }))
    const tasks = postedPayload().tasks as Array<Record<string, unknown>>
    expect(tasks[0].name).toBeUndefined()
  })

  it("answers `workflow.runs` for the requested workflowId", async () => {
    listWorkflowRuns.mockResolvedValueOnce([
      {
        id: "run_1",
        workflowId: "wf_1",
        status: "succeeded",
        triggerKind: "manual",
        startedAt: 1,
        completedAt: 2,
      },
    ])
    await answerRemoteControlQuery(ev({ kind: "workflow.runs", params: { workflowId: "wf_1" } }))
    expect(listWorkflowRuns).toHaveBeenCalledWith({ workflowId: "wf_1", limit: 50 })
    expect((postedPayload().runs as unknown[])[0]).toEqual(
      expect.objectContaining({ id: "run_1", status: "succeeded" })
    )
  })

  it("errors `workflow.runs` when workflowId is missing", async () => {
    await answerRemoteControlQuery(ev({ kind: "workflow.runs", params: {} }))
    expect(listWorkflowRuns).not.toHaveBeenCalled()
    expect(postedPayload()).toEqual({ error: "workflowId required" })
  })

  it("answers `goals` with safeObjective (never rawObjective)", async () => {
    listGoalsBySession.mockResolvedValueOnce([
      {
        id: "g_1",
        sessionId: "s1",
        status: "active",
        turnsUsed: 2,
        tokensUsed: 100,
        rawObjective: "RAW secret",
        safeObjective: "redacted objective",
      },
    ])
    await answerRemoteControlQuery(ev({ kind: "goals", params: { sessionId: "s1" } }))
    const goal = (postedPayload().goals as Array<Record<string, unknown>>)[0]
    expect(goal.objective).toBe("redacted objective")
    expect(JSON.stringify(postedPayload())).not.toContain("RAW secret")
  })

  it("errors `goals` when sessionId is missing", async () => {
    await answerRemoteControlQuery(ev({ kind: "goals", params: {} }))
    expect(postedPayload()).toEqual({ error: "sessionId required" })
  })

  it("answers `audit` and redacts unsafe fields", async () => {
    hasNoLeakingPii.mockReturnValue(false)
    listRemoteControlAudit.mockResolvedValueOnce([
      {
        id: "a1",
        at: 1,
        kind: "inbound.command",
        target: "workflow.run",
        runId: "run_1",
        result: "accepted",
        fields: { secret: "x" },
      },
    ])
    await answerRemoteControlQuery(ev({ kind: "audit" }))
    expect(listRemoteControlAudit).toHaveBeenCalledWith({ direction: "inbound", limit: 50 })
    const entry = (postedPayload().audit as Array<Record<string, unknown>>)[0]
    expect(entry.fields).toEqual({ redacted: true })
  })

  it("answers `run.status` from workflowRuns when the run is a workflow", async () => {
    workflowRunsGet.mockResolvedValueOnce({
      id: "run_1",
      status: "succeeded",
      startedAt: 10,
      completedAt: 20,
    })
    await answerRemoteControlQuery(ev({ kind: "run.status", params: { runId: "run_1" } }))
    expect(postedPayload().run as Record<string, unknown>).toEqual(
      expect.objectContaining({
        runId: "run_1",
        target: "workflow.run",
        status: "succeeded",
        updatedAt: 20,
      })
    )
    expect(getRemoteRunStatus).not.toHaveBeenCalled()
  })

  it("answers `run.status` from the projection when not a workflow run", async () => {
    workflowRunsGet.mockResolvedValueOnce(undefined)
    getRemoteRunStatus.mockResolvedValueOnce({
      runId: "run_2",
      target: "goal.create",
      status: "accepted",
      startedAt: 5,
      updatedAt: 5,
    })
    await answerRemoteControlQuery(ev({ kind: "run.status", params: { runId: "run_2" } }))
    expect(postedPayload().run as Record<string, unknown>).toEqual(
      expect.objectContaining({ runId: "run_2", target: "goal.create", status: "accepted" })
    )
  })

  it("answers `run.status` with null when the run is unknown", async () => {
    workflowRunsGet.mockResolvedValueOnce(undefined)
    getRemoteRunStatus.mockResolvedValueOnce(undefined)
    await answerRemoteControlQuery(ev({ kind: "run.status", params: { runId: "missing" } }))
    expect(postedPayload()).toEqual({ run: null })
  })

  it("errors `run.status` when runId is missing", async () => {
    await answerRemoteControlQuery(ev({ kind: "run.status", params: {} }))
    expect(postedPayload()).toEqual({ error: "runId required" })
  })

  it("answers an unknown kind with an error envelope (no hang)", async () => {
    await answerRemoteControlQuery(ev({ kind: "nope" }))
    expect(postedPayload()).toEqual({ error: "unknown query kind: nope" })
  })

  it("still resolves the oneshot when the Dexie read throws", async () => {
    getAllTasks.mockRejectedValueOnce(new Error("dexie down"))
    await answerRemoteControlQuery(ev({ kind: "tasks" }))
    expect(queryResponse).toHaveBeenCalledWith("rcq_1", { error: "dexie down" })
  })
})
