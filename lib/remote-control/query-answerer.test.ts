import { answerRemoteControlQuery } from "./query-answerer"
import type { RemoteControlQueryEvent } from "@/types/remote-control"

const queryResponse = jest.fn().mockResolvedValue(undefined)
jest.mock("@/lib/tauri/remote-control", () => ({
  remoteControlQueryResponse: (...a: unknown[]) => queryResponse(...a),
}))

const hasNoLeakingPii = jest.fn().mockReturnValue(true)
jest.mock("@cognia/redact", () => ({
  hasNoLeakingPii: (...a: unknown[]) => hasNoLeakingPii(...a),
}))

const getAllTasks = jest.fn()
jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: { getAllTasks: (...a: unknown[]) => getAllTasks(...a) },
}))

const listWorkflowRuns = jest.fn()
const listWorkflows = jest.fn()
jest.mock("@/lib/db/workflows", () => ({
  listWorkflowRuns: (...a: unknown[]) => listWorkflowRuns(...a),
  listWorkflows: (...a: unknown[]) => listWorkflows(...a),
}))

const listGoalsBySession = jest.fn()
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({ listGoalsBySession }),
}))

const isTerminalGoalStatus = jest.fn().mockReturnValue(false)
jest.mock("@/types/goal", () => ({
  isTerminalGoalStatus: (...a: unknown[]) => isTerminalGoalStatus(...a),
}))

const listRemoteControlAudit = jest.fn()
jest.mock("@/lib/db/remote-control-audit", () => ({
  listRemoteControlAudit: (...a: unknown[]) => listRemoteControlAudit(...a),
}))

const workflowRunsGet = jest.fn()
jest.mock("@/lib/db/schema", () => ({
  getDb: () => ({
    workflowRuns: { get: (...a: unknown[]) => workflowRunsGet(...a) },
  }),
}))

const goalsGet = jest.fn()
jest.mock("@/lib/db/goals", () => ({
  getGoal: (...a: unknown[]) => goalsGet(...a),
}))

const getRemoteRunStatus = jest.fn()
const listRemoteRunStatus = jest.fn()
jest.mock("@/lib/db/remote-control-run-status", () => ({
  getRemoteRunStatus: (...a: unknown[]) => getRemoteRunStatus(...a),
  listRemoteRunStatus: (...a: unknown[]) => listRemoteRunStatus(...a),
}))

const teamList = jest.fn()
const teamGet = jest.fn()
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    list: (...a: unknown[]) => teamList(...a),
    get: (...a: unknown[]) => teamGet(...a),
  },
}))

const listPlugins = jest.fn()
jest.mock("@/lib/db/plugins", () => ({
  listPlugins: (...a: unknown[]) => listPlugins(...a),
}))

const listAdapterInstances = jest.fn()
jest.mock("@/lib/db/adapter-instances", () => ({
  listAdapterInstances: (...a: unknown[]) => listAdapterInstances(...a),
}))

const listBackupHistory = jest.fn()
jest.mock("@/lib/db/backup-history", () => ({
  listBackupHistory: (...a: unknown[]) => listBackupHistory(...a),
}))

const ocrCacheStats = jest.fn()
jest.mock("@/lib/db/ocr-results", () => ({
  ocrCacheStats: (...a: unknown[]) => ocrCacheStats(...a),
}))

const listMessages = jest.fn()
jest.mock("@/lib/db/messages", () => ({
  listMessages: (...a: unknown[]) => listMessages(...a),
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

  it("derives `run.status` for goal.create from the live goals table", async () => {
    workflowRunsGet.mockResolvedValueOnce(undefined)
    getRemoteRunStatus.mockResolvedValueOnce({
      runId: "run_g",
      target: "goal.create",
      status: "running",
      correlationId: "g_77",
      startedAt: 5,
      updatedAt: 5,
    })
    goalsGet.mockResolvedValueOnce({ id: "g_77", status: "completed" })
    isTerminalGoalStatus.mockReturnValueOnce(true)
    await answerRemoteControlQuery(ev({ kind: "run.status", params: { runId: "run_g" } }))
    expect(goalsGet).toHaveBeenCalledWith("g_77")
    expect(postedPayload().run as Record<string, unknown>).toEqual(
      expect.objectContaining({ runId: "run_g", target: "goal.create", status: "succeeded" })
    )
  })

  it.each([
    ["completed", true, "succeeded"],
    ["stopped", true, "cancelled"],
    ["budget_limited", true, "failed"],
    ["active", false, "running"],
  ] as const)("maps goal status %s → run.status %s", async (goalStatus, terminal, expected) => {
    workflowRunsGet.mockResolvedValueOnce(undefined)
    getRemoteRunStatus.mockResolvedValueOnce({
      runId: "run_g",
      target: "goal.create",
      status: "running",
      correlationId: "g_1",
      startedAt: 5,
      updatedAt: 5,
    })
    goalsGet.mockResolvedValueOnce({ id: "g_1", status: goalStatus })
    isTerminalGoalStatus.mockReturnValueOnce(terminal)
    await answerRemoteControlQuery(ev({ kind: "run.status", params: { runId: "run_g" } }))
    expect((postedPayload().run as Record<string, unknown>).status).toBe(expected)
  })

  it("falls back to the stored projection when the goal row is gone", async () => {
    workflowRunsGet.mockResolvedValueOnce(undefined)
    getRemoteRunStatus.mockResolvedValueOnce({
      runId: "run_g",
      target: "goal.create",
      status: "running",
      correlationId: "g_missing",
      startedAt: 5,
      updatedAt: 7,
    })
    goalsGet.mockResolvedValueOnce(undefined)
    await answerRemoteControlQuery(ev({ kind: "run.status", params: { runId: "run_g" } }))
    expect((postedPayload().run as Record<string, unknown>).status).toBe("running")
  })

  it("answers `teams` with id/name/status (PII-gated name)", async () => {
    teamList.mockReturnValueOnce([{ id: "tm_1", name: "Crew", status: "idle" }])
    await answerRemoteControlQuery(ev({ kind: "teams" }))
    expect((postedPayload().teams as unknown[])[0]).toEqual(
      expect.objectContaining({ id: "tm_1", name: "Crew", status: "idle" })
    )
  })

  it("answers `team` detail, or null when unknown", async () => {
    teamGet.mockReturnValueOnce({
      id: "tm_1",
      name: "Crew",
      status: "idle",
      description: "d",
      task: "t",
    })
    await answerRemoteControlQuery(ev({ kind: "team", params: { teamId: "tm_1" } }))
    expect(postedPayload().team as Record<string, unknown>).toEqual(
      expect.objectContaining({ id: "tm_1", status: "idle" })
    )

    teamGet.mockReturnValueOnce(undefined)
    await answerRemoteControlQuery(ev({ kind: "team", params: { teamId: "missing" } }))
    expect(postedPayload()).toEqual({ team: null })
  })

  it("errors `team` when teamId is missing", async () => {
    await answerRemoteControlQuery(ev({ kind: "team", params: {} }))
    expect(postedPayload()).toEqual({ error: "teamId required" })
  })

  it("answers `workflows` with summaries and a node count", async () => {
    listWorkflows.mockResolvedValueOnce([
      { id: "wf_1", name: "Build", nodes: [{}, {}], isTemplate: false, updatedAt: 9 },
    ])
    await answerRemoteControlQuery(ev({ kind: "workflows" }))
    expect((postedPayload().workflows as unknown[])[0]).toEqual(
      expect.objectContaining({ id: "wf_1", name: "Build", nodeCount: 2 })
    )
  })

  it("answers `plugins` with enabled state", async () => {
    listPlugins.mockResolvedValueOnce([
      {
        id: "p1",
        name: "Computer Use",
        version: "1.0",
        type: "tool",
        source: "builtin",
        enabled: true,
        status: "active",
      },
    ])
    await answerRemoteControlQuery(ev({ kind: "plugins" }))
    expect((postedPayload().plugins as unknown[])[0]).toEqual(
      expect.objectContaining({ id: "p1", enabled: true, source: "builtin" })
    )
  })

  it("answers `connectors` with adapter instances", async () => {
    listAdapterInstances.mockResolvedValueOnce([
      {
        id: "cai_1",
        type: "slack",
        displayName: "Workspace",
        enabled: true,
        transportMode: "socket",
      },
    ])
    await answerRemoteControlQuery(ev({ kind: "connectors" }))
    expect((postedPayload().connectors as unknown[])[0]).toEqual(
      expect.objectContaining({ id: "cai_1", type: "slack", enabled: true })
    )
  })

  it("answers `backups` with history rows", async () => {
    listBackupHistory.mockResolvedValueOnce([
      { id: "bh_1", completedAt: 1, type: "manual", success: true, encryption: "none" },
    ])
    await answerRemoteControlQuery(ev({ kind: "backups" }))
    expect(listBackupHistory).toHaveBeenCalledWith({ limit: 50 })
    expect((postedPayload().backups as unknown[])[0]).toEqual(
      expect.objectContaining({ id: "bh_1", success: true })
    )
  })

  it("answers `ocr.cache` with the cache stats", async () => {
    ocrCacheStats.mockResolvedValueOnce({ count: 3, bytes: 1024 })
    await answerRemoteControlQuery(ev({ kind: "ocr.cache" }))
    expect(postedPayload().ocrCache).toEqual({ count: 3, bytes: 1024 })
  })

  it("answers `runs` with the recent run-status list", async () => {
    listRemoteRunStatus.mockResolvedValueOnce([
      { runId: "run_1", target: "plan.run", status: "succeeded", startedAt: 1, updatedAt: 2 },
    ])
    await answerRemoteControlQuery(ev({ kind: "runs" }))
    expect(listRemoteRunStatus).toHaveBeenCalledWith(50)
    expect((postedPayload().runs as unknown[])[0]).toEqual(
      expect.objectContaining({ runId: "run_1", status: "succeeded" })
    )
  })

  it("answers `messages` PII-gated, dropping unsafe and text-less rows", async () => {
    listMessages.mockResolvedValueOnce([
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      { id: "m2", role: "assistant", parts: [{ type: "text", text: "ssn 123" }] },
      { id: "m3", role: "assistant", parts: [{ type: "tool-call", toolName: "x" }] },
    ])
    // m2 fails the PII gate; m3 has no text — both dropped.
    hasNoLeakingPii.mockImplementation((t: string) => !t.includes("ssn"))
    await answerRemoteControlQuery(ev({ kind: "messages", params: { sessionId: "s1" } }))
    const messages = postedPayload().messages as Array<Record<string, unknown>>
    expect(messages).toEqual([{ id: "m1", role: "user", text: "hi" }])
  })

  it("errors `messages` when sessionId is missing", async () => {
    await answerRemoteControlQuery(ev({ kind: "messages", params: {} }))
    expect(postedPayload()).toEqual({ error: "sessionId required" })
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
