/** @jest-environment jsdom */
import "fake-indexeddb/auto"

import {
  installExecutionRunControlHandlers,
  registerAgentRunController,
  registerSecurityScanRunController,
} from "./control-handlers"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import {
  createExecutionRun,
  getExecutionRun,
  listExecutionRunEvents,
  runEventJournal,
} from "@/lib/db/execution-runs"
import { executeRunControlCommand } from "./run-control"

const mockCancelRendererBackgroundRun = jest.fn((_runId: string) => true)
jest.mock("@/lib/background-tasks/renderer-subagent-registry", () => ({
  cancelRendererBackgroundRun: (...args: unknown[]) =>
    mockCancelRendererBackgroundRun(...(args as [string])),
}))

const mockCancelWorkflowRun = jest.fn(async (_runId: string) => ({
  cancelled: true,
  live: true,
  mode: "aborted" as string,
}))
jest.mock("@/lib/workflow/runtime/cancel-run", () => ({
  cancelWorkflowRun: (...args: unknown[]) =>
    mockCancelWorkflowRun(...(args as Parameters<typeof mockCancelWorkflowRun>)),
}))

// A legacy-runtime team run writes no `agentTeamRuns` record, so the durable
// branch cannot see it. The live run-context registry is what names its team.
const mockGetTeamRunContext = jest.fn((_runId: string) => undefined as unknown)
jest.mock("@/lib/ai/agent/team/team-run-context", () => ({
  getTeamRunContext: (...args: unknown[]) => mockGetTeamRunContext(...(args as [string])),
}))

const mockTeamPause = jest.fn(async (_teamId: string) => undefined)
const mockTeamShutdown = jest.fn(async (_teamId: string) => undefined)
const mockTeamResume = jest.fn(
  async (_teamId: string, _opts?: unknown, _runId?: string) => undefined
)
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: {
    pause: (...args: unknown[]) => mockTeamPause(...(args as [string])),
    shutdown: (...args: unknown[]) => mockTeamShutdown(...(args as [string])),
    resume: (...args: unknown[]) =>
      mockTeamResume(...(args as [string, unknown | undefined, string | undefined])),
  },
}))

const mockGetAgentTeamRun = jest.fn(async (_id: string) => undefined as unknown)
jest.mock("@/lib/db/agent-team-runtime", () => ({
  getAgentTeamRun: (...args: unknown[]) =>
    mockGetAgentTeamRun(...(args as Parameters<typeof mockGetAgentTeamRun>)),
}))

const mockControlDurableRun = jest.fn(async (_runId: string, _action: string) => undefined)
const mockSteerDurableRun = jest.fn(async (_runId: string, _message: string) => ({
  receiptIds: ["receipt-1"],
  childCount: 1,
}))
jest.mock("@/lib/ai/agent/team/durable-control", () => ({
  controlDurableRun: (...args: unknown[]) =>
    mockControlDurableRun(...(args as Parameters<typeof mockControlDurableRun>)),
  steerDurableRun: (...args: unknown[]) =>
    mockSteerDurableRun(...(args as Parameters<typeof mockSteerDurableRun>)),
}))

const mockSteerSession = jest.fn(async (_sessionId: string, _prompt: unknown) => ({
  accepted: true as const,
}))
jest.mock("@/lib/claude/ipc", () => ({
  steerSession: (...args: unknown[]) =>
    mockSteerSession(...(args as Parameters<typeof mockSteerSession>)),
}))

const mockPauseGoal = jest.fn(async (id: string) => ({ id, status: "paused" }))
const mockResumeGoal = jest.fn(async (id: string) => ({ id, status: "active" }))
const mockStopGoal = jest.fn(async (id: string) => ({ id, status: "stopped" }))
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({
    pauseGoal: mockPauseGoal,
    resumeGoal: mockResumeGoal,
    stopGoal: mockStopGoal,
  }),
}))

const mockRetryWorkflowRun = jest.fn(
  async (_input: {
    runId: string
    mode: string
    operatedBy: string
    triggeredBy?: unknown
    onAdmitted?: (runId: string) => void
  }) => {
    _input.onAdmitted?.("wf-run-2")
    // Deliberately never settles: `executeDeployedWorkflow` resolves at
    // COMPLETION, and a control command that waited for that would hold the
    // gate's per-run lock for the length of the workflow.
    return new Promise<{ runId: string }>(() => undefined)
  }
)
jest.mock("@/lib/workflow/runtime/execution-authority", () => ({
  retryWorkflowRun: (...args: unknown[]) =>
    mockRetryWorkflowRun(...(args as Parameters<typeof mockRetryWorkflowRun>)),
}))

const mockPausePlan = jest.fn(async (id: string) => ({ id, status: "paused" }))
const mockResumePlan = jest.fn(async (id: string) => ({ id, status: "executing" }))
const mockCancelPlan = jest.fn(async (id: string) => ({ id, status: "cancelled" }))
const mockApprovePlan = jest.fn(async (id: string) => ({ id, status: "approved" }))
const mockRejectPlan = jest.fn(async (id: string) => ({ id, status: "cancelled" }))
const mockStartPlan = jest.fn(async () => ({ strategy: "in_session", status: "executing" }))
const mockRunPlan = jest.fn(async () => ({ status: "completed" }))
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({
    pausePlan: mockPausePlan,
    resumePlan: mockResumePlan,
    cancelPlan: mockCancelPlan,
    approvePlan: mockApprovePlan,
    rejectPlan: mockRejectPlan,
    startPlan: mockStartPlan,
    runPlan: mockRunPlan,
  }),
}))

describe("execution source control handlers", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    jest.clearAllMocks()
  })

  it("stops only the addressed agent run", async () => {
    const first = new AbortController()
    const second = new AbortController()
    const unregisterFirst = registerAgentRunController("run-1", first)
    const unregisterSecond = registerAgentRunController("run-2", second)
    const installed = installExecutionRunControlHandlers()

    await installed.agent({
      runId: "run-1",
      action: "stop",
      idempotencyKey: "stop-1",
      expectedRevision: 0,
      actor: {},
    })

    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)
    unregisterFirst()
    unregisterSecond()
    installed.dispose()
  })

  it("routes agent resume through the canonical crashed-run recovery entry", async () => {
    const resumeAgentRun = jest.fn(async () => ({ resumed: true as const }))
    const installed = installExecutionRunControlHandlers({ resumeAgentRun })

    await installed.agent({
      runId: "run-recovery",
      action: "resume",
      idempotencyKey: "resume-1",
      expectedRevision: 0,
      actor: {},
    })

    expect(resumeAgentRun).toHaveBeenCalledWith("run-recovery")
    installed.dispose()
  })

  it("routes Goal and Plan lifecycle controls to their canonical runtimes", async () => {
    const installed = installExecutionRunControlHandlers()
    await createExecutionRun({
      id: "goal-run",
      kind: "goal",
      sourceId: "goal-source",
      title: "Goal",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    await createExecutionRun({
      id: "plan-run",
      kind: "plan",
      sourceId: "plan-source",
      title: "Plan",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })

    await installed.goal({
      runId: "goal-run",
      action: "pause",
      idempotencyKey: "goal-pause",
      expectedRevision: 0,
      actor: {},
    })
    await installed.goal({
      runId: "goal-run",
      action: "resume",
      idempotencyKey: "goal-resume",
      expectedRevision: 0,
      actor: {},
    })
    await installed.plan({
      runId: "plan-run",
      action: "stop",
      idempotencyKey: "plan-stop",
      expectedRevision: 0,
      actor: {},
    })

    expect(mockPauseGoal).toHaveBeenCalledWith("goal-source")
    expect(mockResumeGoal).toHaveBeenCalledWith("goal-source")
    expect(mockCancelPlan).toHaveBeenCalledWith("plan-source")
    installed.dispose()
  })

  it.each(["team", "scheduled"] as const)(
    "registers %s runs with the workflow cancellation handler",
    async (kind) => {
      const installed = installExecutionRunControlHandlers()
      await createExecutionRun({
        id: `${kind}-run`,
        kind,
        sourceId: `${kind}-source`,
        title: "Workflow",
        status: "running",
        initiator: { remoteUserId: "operator-1" },
        currentRevision: 0,
        startedAt: 1,
        updatedAt: 1,
      })

      const result = await executeRunControlCommand({
        runId: `${kind}-run`,
        action: "stop",
        idempotencyKey: `${kind}-stop`,
        expectedRevision: 0,
        actor: { remoteUserId: "operator-1" },
      })

      expect(result.accepted).toBe(true)
      expect(mockCancelWorkflowRun).toHaveBeenCalledWith(`${kind}-source`, "im_control")
      installed.dispose()
    }
  )
})

// A companion mirrors plan rows read-only, so approving from the phone has to
// travel back as a control command; a local write would be overwritten by the
// next sync pull.
describe("plan approval over run control", () => {
  // Own the reset: this block sits outside the suite-level beforeEach, so each
  // case seeds its own run id rather than colliding on a shared one.
  let seq = 0
  async function seedPlanRun(): Promise<string> {
    const id = `plan-approval-run-${(seq += 1)}`
    await createExecutionRun({
      id,
      kind: "plan",
      sourceId: "plan-source",
      title: "Plan",
      status: "running",
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
    return id
  }

  const command = (runId: string, action: "approve" | "deny") => ({
    runId,
    action,
    idempotencyKey: `${runId}-${action}`,
    expectedRevision: 0,
    actor: {},
  })

  it("approves and hands an in-session plan to the chat surface", async () => {
    const installed = installExecutionRunControlHandlers()
    const runId = await seedPlanRun()
    await installed.plan(command(runId, "approve"))
    expect(mockApprovePlan).toHaveBeenCalledWith("plan-source")
    expect(mockStartPlan).toHaveBeenCalledWith("plan-source")
    // In-session plans are driven by the visible chat turns, not headlessly.
    expect(mockRunPlan).not.toHaveBeenCalled()
    installed.dispose()
  })

  it("starts an orchestrated plan headlessly on approval", async () => {
    mockStartPlan.mockResolvedValueOnce({ strategy: "orchestrated", status: "approved" })
    const installed = installExecutionRunControlHandlers()
    const runId = await seedPlanRun()
    await installed.plan(command(runId, "approve"))
    expect(mockRunPlan).toHaveBeenCalledWith("plan-source")
    installed.dispose()
  })

  it("denies through rejectPlan", async () => {
    const installed = installExecutionRunControlHandlers()
    const runId = await seedPlanRun()
    await installed.plan(command(runId, "deny"))
    expect(mockRejectPlan).toHaveBeenCalledWith("plan-source")
    expect(mockApprovePlan).not.toHaveBeenCalled()
    installed.dispose()
  })
})

describe("team run control", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    jest.clearAllMocks()
    mockGetAgentTeamRun.mockResolvedValue(undefined)
    mockGetTeamRunContext.mockReturnValue(undefined)
    mockCancelWorkflowRun.mockResolvedValue({ cancelled: true, live: true, mode: "aborted" })
  })

  /**
   * Seed a team row, and optionally the opening journal event that names its
   * Squad — the only thing a legacy row carries the team on.
   *
   * Returns the resulting revision, because appending events moves it and a
   * command carries `expectedRevision`.
   */
  async function seedTeamRun(
    sourceId: string,
    opts: { teamId?: string; status?: "running" | "paused" } = {}
  ): Promise<number> {
    const runId = `execution:team:${sourceId}`
    await createExecutionRun({
      id: runId,
      kind: "team",
      sourceId,
      title: "Ship it",
      status: opts.status ?? "running",
      currentRevision: 0,
      // Control is authorized against the run's initiator (or an operator
      // allowlist), so a run with no initiator rejects every command.
      initiator: { remoteUserId: "operator-1" },
      startedAt: 1,
      updatedAt: 1,
    })
    if (!opts.teamId && !opts.status) return 0
    await runEventJournal.append(runId, {
      id: `seed:${sourceId}:started`,
      ts: 1,
      type: "run.started",
      visibility: "summary",
      payload: opts.teamId ? { teamId: opts.teamId } : {},
    })
    const seeded = await getExecutionRun(runId)
    return seeded?.currentRevision ?? 0
  }

  it("stops a durable AgentTeam run through controlDurableRun", async () => {
    // The bug: `team` was registered to the workflow handler, which calls
    // `cancelWorkflowRun(run.sourceId)`. For a durable-v2 run `sourceId` is an
    // AgentTeamRunRecord id, so the lookup found nothing and Stop did nothing.
    const handlers = installExecutionRunControlHandlers()
    mockGetAgentTeamRun.mockResolvedValue({ id: "run_team_1", status: "running" })
    await seedTeamRun("run_team_1")

    await executeRunControlCommand({
      runId: "execution:team:run_team_1",
      action: "stop",
      idempotencyKey: "team-stop",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
    })

    expect(mockControlDurableRun).toHaveBeenCalledWith("run_team_1", "stop")
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled()
    handlers.dispose()
  })

  it("still cancels a trigger.team workflow run through the workflow handler", async () => {
    const handlers = installExecutionRunControlHandlers()
    mockGetAgentTeamRun.mockResolvedValue(undefined)
    await seedTeamRun("wfrun_9")

    await executeRunControlCommand({
      runId: "execution:team:wfrun_9",
      action: "stop",
      idempotencyKey: "team-stop",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
    })

    expect(mockCancelWorkflowRun).toHaveBeenCalledWith("wfrun_9", "im_control")
    expect(mockControlDurableRun).not.toHaveBeenCalled()
    handlers.dispose()
  })

  it("pauses and resumes a durable run", async () => {
    const handlers = installExecutionRunControlHandlers()
    mockGetAgentTeamRun.mockResolvedValue({ id: "run_team_2", status: "running" })
    await seedTeamRun("run_team_2")

    await executeRunControlCommand({
      runId: "execution:team:run_team_2",
      action: "pause",
      idempotencyKey: "team-pause",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
    })
    expect(mockControlDurableRun).toHaveBeenCalledWith("run_team_2", "pause")
    handlers.dispose()
  })

  // `legacy` is the default runtime version, so this is the common team run,
  // not an exotic one. It has no durable record, and its `sourceId` is a
  // lifecycle run id rather than a workflow run id, so it used to fall to
  // `cancelWorkflowRun`, which looked up nothing and reported success.
  it("stops a live legacy run through the manager the Squad console uses", async () => {
    const handlers = installExecutionRunControlHandlers()
    mockGetAgentTeamRun.mockResolvedValue(undefined)
    mockGetTeamRunContext.mockReturnValue({ runId: "run_legacy_1", teamId: "team-7" })
    await seedTeamRun("run_legacy_1")

    await executeRunControlCommand({
      runId: "execution:team:run_legacy_1",
      action: "stop",
      idempotencyKey: "legacy-stop",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
    })

    expect(mockTeamShutdown).toHaveBeenCalledWith("team-7")
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled()
    handlers.dispose()
  })

  it("pauses a live legacy run", async () => {
    const handlers = installExecutionRunControlHandlers()
    mockGetAgentTeamRun.mockResolvedValue(undefined)
    mockGetTeamRunContext.mockReturnValue({ runId: "run_legacy_2", teamId: "team-8" })
    await seedTeamRun("run_legacy_2")

    await executeRunControlCommand({
      runId: "execution:team:run_legacy_2",
      action: "pause",
      idempotencyKey: "legacy-pause",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
    })

    expect(mockTeamPause).toHaveBeenCalledWith("team-8")
    handlers.dispose()
  })

  // "This kind of run cannot take that action" is false about Squads: a
  // durable-v2 one resumes and steers from here. What cannot is the RUNTIME,
  // and the copy for that reason names where the verb does live.
  // Resume addresses a TEAM, the cockpit addresses a RUN, and nothing on the
  // row bridged the two until the Squad was written onto the run's opening
  // event. The run id goes back with it so the work that is left continues
  // under this row rather than stranding it at `paused` under a second one.
  it("resumes a paused legacy run into the row the button was pressed on", async () => {
    const handlers = installExecutionRunControlHandlers()
    mockGetAgentTeamRun.mockResolvedValue(undefined)
    mockGetTeamRunContext.mockReturnValue(undefined)
    const revision = await seedTeamRun("run_legacy_4", { teamId: "team-11", status: "paused" })

    const result = await executeRunControlCommand({
      runId: "execution:team:run_legacy_4",
      action: "resume",
      idempotencyKey: "legacy-resume",
      expectedRevision: revision,
      actor: { remoteUserId: "operator-1" },
    })

    expect(result.accepted).toBe(true)
    expect(mockTeamResume).toHaveBeenCalledWith("team-11", undefined, "run_legacy_4")
    expect(mockCancelWorkflowRun).not.toHaveBeenCalled()
    handlers.dispose()
  })

  it("refuses a resume on a row whose opening event never named a Squad", async () => {
    const handlers = installExecutionRunControlHandlers()
    mockGetAgentTeamRun.mockResolvedValue(undefined)
    mockGetTeamRunContext.mockReturnValue(undefined)
    const revision = await seedTeamRun("run_legacy_5", { status: "paused" })

    const result = await executeRunControlCommand({
      runId: "execution:team:run_legacy_5",
      action: "resume",
      idempotencyKey: "legacy-resume-2",
      expectedRevision: revision,
      actor: { remoteUserId: "operator-1" },
    })

    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("unsupported_for_runtime")
    expect(mockTeamResume).not.toHaveBeenCalled()
    handlers.dispose()
  })

  it("blames the runtime, not the kind, when a legacy run cannot take a verb", async () => {
    const handlers = installExecutionRunControlHandlers()
    mockGetAgentTeamRun.mockResolvedValue(undefined)
    mockGetTeamRunContext.mockReturnValue({ runId: "run_legacy_3", teamId: "team-9" })
    await seedTeamRun("run_legacy_3")

    const result = await executeRunControlCommand({
      runId: "execution:team:run_legacy_3",
      action: "steer",
      steerMessage: "try the other branch",
      idempotencyKey: "legacy-steer",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
    })

    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("unsupported_for_runtime")
    handlers.dispose()
  })

  it("refuses the press when nothing is behind the row, rather than reporting a stop", async () => {
    const handlers = installExecutionRunControlHandlers()
    mockGetAgentTeamRun.mockResolvedValue(undefined)
    mockGetTeamRunContext.mockReturnValue(undefined)
    mockCancelWorkflowRun.mockResolvedValue({ cancelled: false, live: false, mode: "noop" })
    await seedTeamRun("run_stale_1")

    const result = await executeRunControlCommand({
      runId: "execution:team:run_stale_1",
      action: "stop",
      idempotencyKey: "stale-stop",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
    })

    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("source_rejected")
    handlers.dispose()
  })
})

describe("unsupported actions report the kind, not a generic refusal", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    jest.clearAllMocks()
    mockGetAgentTeamRun.mockResolvedValue(undefined)
  })

  it("reports unsupported_for_kind when a kind cannot perform an action", async () => {
    // Every handler used to throw a bare Error, which collapsed into
    // `source_rejected` — indistinguishable from "the engine refused", so a
    // card had no way to tell a permanent capability gap from a transient
    // failure and kept offering a button that could never work.
    const handlers = installExecutionRunControlHandlers()
    await createExecutionRun({
      id: "execution:workflow:w1",
      kind: "workflow",
      sourceId: "w1",
      title: "t",
      status: "running",
      currentRevision: 0,
      initiator: { remoteUserId: "operator-1" },
      startedAt: 1,
      updatedAt: 1,
    })

    const result = await executeRunControlCommand({
      runId: "execution:workflow:w1",
      action: "pause",
      idempotencyKey: "wf-pause",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
    })

    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("unsupported_for_kind")
    handlers.dispose()
  })
})

describe("steering", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    jest.clearAllMocks()
    mockGetAgentTeamRun.mockResolvedValue(undefined)
    mockSteerSession.mockResolvedValue({ accepted: true as const })
    mockSteerDurableRun.mockResolvedValue({ receiptIds: ["receipt-1"], childCount: 1 })
  })

  async function seedRun(input: {
    id: string
    kind: "agent-turn" | "team" | "delegation"
    sourceId: string
    sessionId?: string
    parentRunId?: string
    status?: "running" | "completed"
  }) {
    await createExecutionRun({
      id: input.id,
      kind: input.kind,
      sourceId: input.sourceId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      title: "Work",
      status: input.status ?? "running",
      currentRevision: 0,
      initiator: { remoteUserId: "operator-1" },
      startedAt: 1,
      updatedAt: 1,
    })
  }

  it("hands an agent-turn steer to the session's own live input lane", async () => {
    const handlers = installExecutionRunControlHandlers()
    await seedRun({
      id: "execution:agent-turn:a1",
      kind: "agent-turn",
      sourceId: "a1",
      sessionId: "s-1",
    })

    const result = await executeRunControlCommand({
      runId: "execution:agent-turn:a1",
      action: "steer",
      idempotencyKey: "steer-1",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
      steerMessage: "focus on the migration first",
    })

    expect(result.accepted).toBe(true)
    expect(mockSteerSession).toHaveBeenCalledWith("s-1", "focus on the migration first")
    handlers.dispose()
  })

  it("never writes the steering text into the run journal", async () => {
    // The journal is projected onto twelve platforms' cards. Free user text in
    // it would be one redaction hole in all of them at once, so only the
    // receipt id travels.
    const handlers = installExecutionRunControlHandlers()
    await seedRun({
      id: "execution:agent-turn:a2",
      kind: "agent-turn",
      sourceId: "a2",
      sessionId: "s-2",
    })

    await executeRunControlCommand({
      runId: "execution:agent-turn:a2",
      action: "steer",
      idempotencyKey: "steer-2",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
      steerMessage: "my email is dana@example.com",
    })

    const journal = JSON.stringify(await listExecutionRunEvents("execution:agent-turn:a2"))
    expect(journal).not.toContain("dana@example.com")
    expect(journal).toContain('"action":"steer"')
    handlers.dispose()
  })

  it("reports a degraded steer as degraded, not as a refusal", async () => {
    const handlers = installExecutionRunControlHandlers()
    await seedRun({
      id: "execution:agent-turn:a3",
      kind: "agent-turn",
      sourceId: "a3",
      sessionId: "s-3",
    })
    mockSteerSession.mockRejectedValueOnce(new Error("session has no live input lane"))

    const result = await executeRunControlCommand({
      runId: "execution:agent-turn:a3",
      action: "steer",
      idempotencyKey: "steer-3",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
      steerMessage: "change course",
    })

    expect(result.accepted).toBe(false)
    expect(result.reason).toBe("steer_degraded")
    expect(result.degradedReason).toBe("provider_unsupported")
    // A degradation is a lifecycle fact the card already knows how to say.
    const types = (await listExecutionRunEvents("execution:agent-turn:a3")).map((e) => e.type)
    expect(types).toContain("run.degraded")
    handlers.dispose()
  })

  it("names the PII gate as the reason when the gate is what refused", async () => {
    const handlers = installExecutionRunControlHandlers()
    await seedRun({
      id: "execution:agent-turn:a4",
      kind: "agent-turn",
      sourceId: "a4",
      sessionId: "s-4",
    })
    mockSteerSession.mockRejectedValueOnce(
      new Error("live-steer prompt rejected by the renderer PII gate")
    )

    const result = await executeRunControlCommand({
      runId: "execution:agent-turn:a4",
      action: "steer",
      idempotencyKey: "steer-4",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
      steerMessage: "…",
    })

    expect(result.degradedReason).toBe("pii_blocked")
    handlers.dispose()
  })

  it("returns the team's durable receipts and treats a queued one as success", async () => {
    const handlers = installExecutionRunControlHandlers()
    mockGetAgentTeamRun.mockResolvedValue({ id: "run_team_9", status: "running" })
    await seedRun({ id: "execution:team:run_team_9", kind: "team", sourceId: "run_team_9" })

    const result = await executeRunControlCommand({
      runId: "execution:team:run_team_9",
      action: "steer",
      idempotencyKey: "steer-team",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
      steerMessage: "prefer the smaller diff",
    })

    expect(result.accepted).toBe(true)
    expect(result.steerReceiptIds).toEqual(["receipt-1"])
    expect(mockSteerDurableRun).toHaveBeenCalledWith("run_team_9", "prefer the smaller diff")
    handlers.dispose()
  })

  it("degrades a team steer only when no child can act at all", async () => {
    const handlers = installExecutionRunControlHandlers()
    mockGetAgentTeamRun.mockResolvedValue({ id: "run_team_10", status: "running" })
    await seedRun({ id: "execution:team:run_team_10", kind: "team", sourceId: "run_team_10" })
    mockSteerDurableRun.mockResolvedValueOnce({ receiptIds: [], childCount: 0 })

    const result = await executeRunControlCommand({
      runId: "execution:team:run_team_10",
      action: "steer",
      idempotencyKey: "steer-team-2",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
      steerMessage: "too late",
    })

    expect(result.reason).toBe("steer_degraded")
    expect(result.degradedReason).toBe("no_active_run")
    handlers.dispose()
  })

  it("rejects a steer with no message before it reaches an engine", async () => {
    const handlers = installExecutionRunControlHandlers()
    await seedRun({
      id: "execution:agent-turn:a5",
      kind: "agent-turn",
      sourceId: "a5",
      sessionId: "s-5",
    })

    const result = await executeRunControlCommand({
      runId: "execution:agent-turn:a5",
      action: "steer",
      idempotencyKey: "steer-empty",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
      steerMessage: "   ",
    })

    expect(result.reason).toBe("invalid_command")
    expect(mockSteerSession).not.toHaveBeenCalled()
    handlers.dispose()
  })
})

describe("delegation controls fan out to the runs carrying the work", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    jest.clearAllMocks()
    mockGetAgentTeamRun.mockResolvedValue(undefined)
    mockSteerSession.mockResolvedValue({ accepted: true as const })
  })

  async function seedDelegationWithChild(status: "running" | "completed" = "running") {
    await createExecutionRun({
      id: "execution:delegation:d1",
      kind: "delegation",
      sourceId: "d1",
      title: "Delegated work",
      status: "running",
      currentRevision: 0,
      initiator: { remoteUserId: "operator-1" },
      startedAt: 1,
      updatedAt: 1,
    })
    await createExecutionRun({
      id: "execution:agent-turn:c1",
      parentRunId: "execution:delegation:d1",
      kind: "agent-turn",
      sourceId: "c1",
      sessionId: "s-child",
      title: "The turn",
      status,
      currentRevision: 0,
      startedAt: 1,
      updatedAt: 1,
    })
  }

  it("steers the child, and records the control on the surface the person sees", async () => {
    const handlers = installExecutionRunControlHandlers()
    await seedDelegationWithChild()

    const result = await executeRunControlCommand({
      runId: "execution:delegation:d1",
      action: "steer",
      idempotencyKey: "deleg-steer",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
      steerMessage: "start with the tests",
    })

    expect(result.accepted).toBe(true)
    expect(mockSteerSession).toHaveBeenCalledWith("s-child", "start with the tests")
    // The delegation's own journal carries the control — the child's does not
    // need to, and re-authorizing against a child with no initiator would have
    // rejected every forwarded control as `forbidden`.
    const parentTypes = (await listExecutionRunEvents("execution:delegation:d1")).map((e) => e.type)
    expect(parentTypes).toContain("control.accepted")
    handlers.dispose()
  })

  it("accepts a stop with nothing left to stop — the commitment is what is withdrawn", async () => {
    const handlers = installExecutionRunControlHandlers()
    await seedDelegationWithChild("completed")

    const result = await executeRunControlCommand({
      runId: "execution:delegation:d1",
      action: "stop",
      idempotencyKey: "deleg-stop",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
    })

    expect(result.accepted).toBe(true)
    // Settling here would append a terminal event before the gate appends
    // `control.accepted`, which a terminal journal refuses. The reconciler owns
    // the close.
    expect((await getDb().executionRuns.get("execution:delegation:d1"))?.status).not.toBe(
      "cancelled"
    )
    handlers.dispose()
  })

  it("degrades a steer with no live child rather than pretending it landed", async () => {
    const handlers = installExecutionRunControlHandlers()
    await seedDelegationWithChild("completed")

    const result = await executeRunControlCommand({
      runId: "execution:delegation:d1",
      action: "steer",
      idempotencyKey: "deleg-steer-dead",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
      steerMessage: "too late",
    })

    expect(result.reason).toBe("steer_degraded")
    expect(mockSteerSession).not.toHaveBeenCalled()
    handlers.dispose()
  })
})

describe("retry mints a replacement instead of reopening a settled run", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    jest.clearAllMocks()
  })

  async function seedFailedWorkflow(over: Record<string, unknown> = {}): Promise<void> {
    await getDb().workflowRuns.add({
      id: "wf-run-1",
      workflowId: "wf-1",
      status: "failed",
      triggerKind: "trigger.manual",
      triggerPayload: { message: "publish" },
      triggeredBy: {
        source: "im",
        adapterId: "lark-1",
        conversationKey: "lark:lark-1:chat-1",
      },
      workflowSnapshot: { id: "wf-1", name: "Publish", nodes: [], edges: [] },
      startedAt: 1,
      ...over,
    } as never)
    await createExecutionRun({
      id: "execution:workflow:wf-run-1",
      kind: "workflow",
      sourceId: "wf-run-1",
      title: "Publish",
      status: "failed",
      initiator: { remoteUserId: "operator-1" },
      currentRevision: 2,
      startedAt: 1,
      updatedAt: 5,
      endedAt: 5,
    })
  }

  it("re-dispatches through the existing operator retry and keeps the IM origin", async () => {
    const handlers = installExecutionRunControlHandlers()
    await seedFailedWorkflow()

    const result = await executeRunControlCommand({
      runId: "execution:workflow:wf-run-1",
      action: "retry",
      idempotencyKey: "retry-1",
      expectedRevision: 2,
      actor: { remoteUserId: "operator-1" },
    })

    expect(result).toMatchObject({
      accepted: true,
      retryRunId: "execution:workflow:wf-run-2",
    })
    // Dropping the seed's origin would start a run whose progress fans back to
    // nobody, which the person who asked cannot tell from "nothing happened".
    expect(mockRetryWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "wf-run-1",
        mode: "current-deployment",
        operatedBy: "operator-1",
        triggeredBy: expect.objectContaining({
          source: "im",
          conversationKey: "lark:lark-1:chat-1",
        }),
      })
    )
    // The settled run keeps its history and gains a pointer, not an event.
    expect(await listExecutionRunEvents("execution:workflow:wf-run-1")).toEqual([])
    expect((await getDb().executionRuns.get("execution:workflow:wf-run-1"))?.retry).toMatchObject({
      idempotencyKey: "retry-1",
      runId: "execution:workflow:wf-run-2",
    })
    handlers.dispose()
  })

  it("refuses a run that succeeded", async () => {
    const handlers = installExecutionRunControlHandlers()
    await seedFailedWorkflow()
    await getDb().executionRuns.update("execution:workflow:wf-run-1", { status: "completed" })

    const result = await executeRunControlCommand({
      runId: "execution:workflow:wf-run-1",
      action: "retry",
      idempotencyKey: "retry-completed",
      expectedRevision: 2,
      actor: { remoteUserId: "operator-1" },
    })

    expect(result).toMatchObject({ accepted: false, reason: "unsupported_for_kind" })
    expect(mockRetryWorkflowRun).not.toHaveBeenCalled()
    handlers.dispose()
  })

  it("a delegation retries the child that carried the work and adopts the replacement", async () => {
    // A delegation executes nothing itself, so "try again" means re-dispatching
    // the child that failed the commitment — and the replacement belongs to the
    // COMMITMENT, or the person watching one card would gain a second.
    const handlers = installExecutionRunControlHandlers()
    await seedFailedWorkflow()
    await createExecutionRun({
      id: "execution:delegation:d1",
      kind: "delegation",
      sourceId: "d1",
      title: "The brief",
      status: "failed",
      initiator: { remoteUserId: "operator-1" },
      currentRevision: 4,
      startedAt: 1,
      updatedAt: 6,
      endedAt: 6,
    })
    await getDb().executionRuns.update("execution:workflow:wf-run-1", {
      parentRunId: "execution:delegation:d1",
    })
    // The engine's bridge mints the replacement row; stand in for it.
    await createExecutionRun({
      id: "execution:workflow:wf-run-2",
      kind: "workflow",
      sourceId: "wf-run-2",
      title: "Publish",
      status: "running",
      currentRevision: 0,
      startedAt: 7,
      updatedAt: 7,
    })

    const result = await executeRunControlCommand({
      runId: "execution:delegation:d1",
      action: "retry",
      idempotencyKey: "deleg-retry",
      expectedRevision: 4,
      actor: { remoteUserId: "operator-1" },
    })

    expect(result).toMatchObject({
      accepted: true,
      retryRunId: "execution:workflow:wf-run-2",
    })
    expect(mockRetryWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "wf-run-1" })
    )
    expect((await getDb().executionRuns.get("execution:workflow:wf-run-2"))?.parentRunId).toBe(
      "execution:delegation:d1"
    )
    handlers.dispose()
  })

  it("a delegation with no settled child says so instead of failing opaquely", async () => {
    const handlers = installExecutionRunControlHandlers()
    await createExecutionRun({
      id: "execution:delegation:d2",
      kind: "delegation",
      sourceId: "d2",
      title: "The brief",
      status: "failed",
      initiator: { remoteUserId: "operator-1" },
      currentRevision: 1,
      startedAt: 1,
      updatedAt: 2,
      endedAt: 2,
    })

    const result = await executeRunControlCommand({
      runId: "execution:delegation:d2",
      action: "retry",
      idempotencyKey: "deleg-retry-empty",
      expectedRevision: 1,
      actor: { remoteUserId: "operator-1" },
    })

    expect(result).toMatchObject({ accepted: false, reason: "unsupported_for_kind" })
    handlers.dispose()
  })
})

describe("job control", () => {
  const seedJob = async (id = "job-run") =>
    createExecutionRun({
      id,
      kind: "job",
      // The registry knows the BACKGROUND journal's id, never the projection's.
      sourceId: "bg-run-1",
      title: "code-reviewer",
      status: "running",
      currentRevision: 0,
      startedAt: 1_000,
      updatedAt: 1_000,
    })

  it("cancels the background run by its SOURCE id, not the execution run id", async () => {
    const installed = installExecutionRunControlHandlers()
    await seedJob()

    await installed.job({
      runId: "job-run",
      action: "stop",
      idempotencyKey: "stop-job-1",
      expectedRevision: 0,
      actor: {},
    })

    expect(mockCancelRendererBackgroundRun).toHaveBeenCalledWith("bg-run-1")
    installed.dispose()
  })

  it("reports a task this process is not running rather than claiming success", async () => {
    mockCancelRendererBackgroundRun.mockReturnValueOnce(false)
    const installed = installExecutionRunControlHandlers()
    await seedJob("job-gone")

    await expect(
      installed.job({
        runId: "job-gone",
        action: "stop",
        idempotencyKey: "stop-job-2",
        expectedRevision: 0,
        actor: {},
      })
    ).rejects.toThrow(/not active in this process/)
    installed.dispose()
  })

  it.each(["pause", "resume", "steer"] as const)(
    "refuses %s as unsupported for the kind",
    async (action) => {
      const installed = installExecutionRunControlHandlers()
      await seedJob(`job-${action}`)

      await expect(
        installed.job({
          runId: `job-${action}`,
          action,
          idempotencyKey: `k-${action}`,
          expectedRevision: 0,
          actor: {},
          ...(action === "steer" ? { steerMessage: "hi" } : {}),
        })
      ).rejects.toThrow(/cannot/)
      installed.dispose()
    }
  )

  it("treats open_details as a no-op", async () => {
    const installed = installExecutionRunControlHandlers()
    await seedJob("job-details")
    await expect(
      installed.job({
        runId: "job-details",
        action: "open_details",
        idempotencyKey: "k-details",
        expectedRevision: 0,
        actor: {},
      })
    ).resolves.toBeUndefined()
    expect(mockCancelRendererBackgroundRun).not.toHaveBeenCalled()
    installed.dispose()
  })
})

describe("security scan control", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    jest.clearAllMocks()
  })

  it("stops the addressed live scan through the shared control plane", async () => {
    const controller = new AbortController()
    const unregister = registerSecurityScanRunController(
      "execution:security-scan:scan-1",
      controller
    )
    const installed = installExecutionRunControlHandlers()
    await createExecutionRun({
      id: "execution:security-scan:scan-1",
      kind: "security-scan",
      sourceId: "scan-1",
      title: "https://example.test",
      status: "running",
      currentRevision: 0,
      initiator: { remoteUserId: "operator-1" },
      startedAt: 1_000,
      updatedAt: 1_000,
    })

    const result = await executeRunControlCommand({
      runId: "execution:security-scan:scan-1",
      action: "stop",
      idempotencyKey: "stop-scan-1",
      expectedRevision: 0,
      actor: { remoteUserId: "operator-1" },
    })

    expect(result.accepted).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    unregister()
    installed.dispose()
  })
})
