const getAgentTeamRun = jest.fn(async (_runId: string) => undefined as unknown)
const updateAgentTeamRun = jest.fn(async (_runId: string, _patch: unknown) => true)
jest.mock("@/lib/db/agent-team-runtime", () => ({
  getAgentTeamRun: (runId: string) => getAgentTeamRun(runId),
  updateAgentTeamRun: (runId: string, patch: unknown) => updateAgentTeamRun(runId, patch),
}))
const settleAgentTeamExecutionRun = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/execution/agent-team-bridge", () => ({
  settleAgentTeamExecutionRun: (...args: unknown[]) => settleAgentTeamExecutionRun(...args),
}))
const emitSchedulerEvent = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("@/lib/scheduler/event-integration", () => ({
  emitSchedulerEvent: (...args: unknown[]) => emitSchedulerEvent(...args),
}))
const prepareAndPublishGithubStack = jest.fn(async (..._args: unknown[]) => undefined)
jest.mock("./github-delivery-adapter", () => ({
  prepareAndPublishGithubStack: (...args: unknown[]) => prepareAndPublishGithubStack(...args),
}))
const autoPublishTaskResult = jest.fn()
jest.mock("./shared-memory-orchestrator", () => ({
  autoPublishTaskResult: (...args: unknown[]) => autoPublishTaskResult(...args),
}))
const buildAgentTeamRuntimeDeps = jest.fn((opts?: unknown) => ({
  runLeadPlanning: jest.fn(),
  notifierDeps: { marker: opts ?? "default" },
}))
jest.mock("../agent-team-runtime-deps", () => ({
  buildAgentTeamRuntimeDeps: (opts?: unknown) => buildAgentTeamRuntimeDeps(opts),
}))

import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam, AgentTeammate, AgentTeamTask } from "@/types/agent/agent-team"
import {
  __resetAgentTeamRuntimeForTesting,
  configureAgentTeamRuntime,
  prepareSquadResume,
  resumeTaskFilter,
  runSquadLifecycle,
} from "./squad-lifecycle-runner"

function makeTeam(overrides: Partial<AgentTeam> = {}): AgentTeam {
  return {
    id: "t1",
    name: "Team",
    description: "",
    task: "do",
    status: "idle",
    config: {
      maxTeammates: 5,
      maxConcurrentTeammates: 1,
      executionMode: "coordinated",
      displayMode: "compact",
    },
    leadId: "lead-1",
    teammateIds: ["lead-1"],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(2026, 0, 1),
    ...overrides,
  }
}

function makeTeammate(id: string, overrides: Partial<AgentTeammate> = {}): AgentTeammate {
  return {
    id,
    teamId: "t1",
    name: id,
    description: "",
    role: "teammate",
    status: "idle",
    config: {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
    ...overrides,
  }
}

function makeTask(id: string, overrides: Partial<AgentTeamTask> = {}): AgentTeamTask {
  return {
    id,
    teamId: "t1",
    title: id,
    description: "",
    status: "pending",
    priority: "normal",
    dependencies: [],
    tags: [],
    createdAt: new Date(),
    order: 0,
    ...overrides,
  }
}

beforeEach(() => {
  useAgentTeamStore.getState().reset()
  __resetAgentTeamRuntimeForTesting()
  jest.clearAllMocks()
  getAgentTeamRun.mockResolvedValue({ id: "run-1", teamId: "t1", status: "running" })
})

describe("runSquadLifecycle", () => {
  it("auto-configures default deps (with a warning) when nothing was configured", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    useAgentTeamStore.getState().upsertTeam(makeTeam())
    const run = jest.fn(async () => ({ runId: "run-1", status: "completed" as const }))
    await runSquadLifecycle({ teamId: "t1", runId: "run-1" }, { run })
    expect(buildAgentTeamRuntimeDeps).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("auto-configured"))
    warn.mockRestore()
  })

  it("uses the configured deps and threads every input onto the lifecycle", async () => {
    useAgentTeamStore.getState().upsertTeam(makeTeam())
    const runLeadPlanning = jest.fn()
    configureAgentTeamRuntime({ runLeadPlanning, notifierDeps: { marker: "configured" } as never })
    const run = jest.fn(async () => ({ runId: "run-1", status: "completed" as const }))
    await runSquadLifecycle(
      {
        teamId: "t1",
        runId: "run-1",
        origin: "scheduler",
        triggeredFrom: { source: "ui" },
        ultracode: true,
        requirePlanApprovalFloor: true,
        sessionWorkingDir: "/work",
      },
      { run }
    )
    expect(buildAgentTeamRuntimeDeps).not.toHaveBeenCalled()
    expect(run).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        runId: "run-1",
        runLeadPlanning,
        notifierDeps: { marker: "configured" },
        origin: "scheduler",
        triggeredFrom: { source: "ui" },
        ultracodeOverride: "force",
        requirePlanApprovalFloor: true,
        sessionWorkingDir: "/work",
      })
    )
  })

  it("builds persona-bound deps when the caller enters as a Character", async () => {
    useAgentTeamStore.getState().upsertTeam(makeTeam())
    configureAgentTeamRuntime({ runLeadPlanning: jest.fn(), notifierDeps: {} })
    const run = jest.fn(async () => ({ runId: "run-1", status: "completed" as const }))
    await runSquadLifecycle(
      {
        teamId: "t1",
        runId: "run-1",
        entryPersona: { id: "c1", name: "Ada", systemPrompt: "be Ada" },
      },
      { run }
    )
    expect(buildAgentTeamRuntimeDeps).toHaveBeenCalledWith({
      entryPersona: { id: "c1", name: "Ada", systemPrompt: "be Ada" },
    })
  })

  it("mirrors the durable status, settles the execution row and emits the scheduler event", async () => {
    useAgentTeamStore.getState().upsertTeam(makeTeam())
    const run = jest.fn(async () => ({ runId: "run-1", status: "completed" as const }))
    const statuses: string[] = []
    const unsubscribe = useAgentTeamStore.subscribe((state) => {
      const status = state.teams.t1?.status
      if (status && statuses[statuses.length - 1] !== status) statuses.push(status)
    })
    await runSquadLifecycle({ teamId: "t1", runId: "run-1" }, { run })
    unsubscribe()
    expect(statuses).toEqual(["executing", "completed"])
    expect(settleAgentTeamExecutionRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-1" }),
      "completed"
    )
    expect(emitSchedulerEvent).toHaveBeenCalledWith(
      "agent-team:completed",
      { teamId: "t1", status: "completed" },
      "agent-team"
    )
  })

  /** A paused or parked run keeps the status the control plane wrote. */
  it.each(["needs_input", "paused"] as const)(
    "does not settle over a durable %s status",
    async (durableStatus) => {
      useAgentTeamStore.getState().upsertTeam(makeTeam())
      getAgentTeamRun.mockResolvedValue({ id: "run-1", teamId: "t1", status: durableStatus })
      const run = jest.fn(async () => ({ runId: "run-1", status: "completed" as const }))
      await runSquadLifecycle({ teamId: "t1", runId: "run-1" }, { run })
      expect(useAgentTeamStore.getState().teams.t1?.status).toBe("paused")
      expect(settleAgentTeamExecutionRun).not.toHaveBeenCalled()
      if (durableStatus === "needs_input") expect(emitSchedulerEvent).not.toHaveBeenCalled()
    }
  )

  it("parks the run on a delivery_failed CODE when the GitHub stack cannot publish", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    useAgentTeamStore.getState().upsertTeam(
      makeTeam({
        config: {
          maxTeammates: 5,
          maxConcurrentTeammates: 1,
          executionMode: "coordinated",
          displayMode: "compact",
          githubDeliveryPolicy: {
            enabled: true,
            stackedPullRequests: true,
            minLayers: 1,
            maxLayers: 3,
            mergeMode: "approved-bottom-up",
          },
        },
      })
    )
    configureAgentTeamRuntime({ runLeadPlanning: jest.fn(), notifierDeps: {} })
    prepareAndPublishGithubStack.mockRejectedValueOnce(
      new Error("token for alice@example.com expired")
    )
    const run = jest.fn(async () => ({ runId: "run-1", status: "completed" as const }))
    await runSquadLifecycle({ teamId: "t1", runId: "run-1" }, { run })
    expect(updateAgentTeamRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({ status: "needs_input", recoveryReason: "delivery_failed" })
    )
    const patch = updateAgentTeamRun.mock.calls[0]?.[1] as { recoveryReason: string }
    expect(patch.recoveryReason).not.toContain("alice")
    expect(useAgentTeamStore.getState().teams.t1?.status).toBe("paused")
    expect(emitSchedulerEvent).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe("guardSquadResume", () => {
  it("lets a ready Squad through without parking anything", async () => {
    const { guardSquadResume } = await import("./squad-lifecycle-runner")
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    useAgentTeamStore.setState({
      teams: { t1: { id: "t1", name: "S", config: {} } as never },
      teammates: {},
    } as never)
    const park = jest.fn(async () => undefined)
    const result = await guardSquadResume("t1", "run-1", {
      evaluate: async () => ({ ready: true, blockers: [] }),
      park,
    })
    expect(result).toEqual({ blocked: false, blockers: [] })
    expect(park).not.toHaveBeenCalled()
  })

  it("parks a blocked Squad and reports the blockers", async () => {
    const { guardSquadResume } = await import("./squad-lifecycle-runner")
    const { useAgentTeamStore } = await import("@/stores/agent/agent-team-store")
    useAgentTeamStore.setState({
      teams: { t1: { id: "t1", name: "S", config: {} } as never },
      teammates: {},
    } as never)
    const park = jest.fn(async () => undefined)
    const result = await guardSquadResume("t1", "run-1", {
      evaluate: async () => ({ ready: false, blockers: [{ code: "missing_environment_ref" }] }),
      park,
    })
    expect(result).toEqual({ blocked: true, blockers: [{ code: "missing_environment_ref" }] })
    expect(park).toHaveBeenCalledWith("run-1", "t1")
  })

  it("does nothing for a Squad the store does not hold", async () => {
    const { guardSquadResume } = await import("./squad-lifecycle-runner")
    const evaluate = jest.fn()
    const result = await guardSquadResume("ghost", "run-1", { evaluate })
    expect(result.blocked).toBe(false)
    expect(evaluate).not.toHaveBeenCalled()
  })
})

describe("prepareSquadResume", () => {
  it("unstrands mid-flight tasks and teammates, re-seeds the blackboard, and counts what is left", async () => {
    const store = useAgentTeamStore.getState()
    store.upsertTeam(makeTeam())
    store.upsertTeammate(makeTeammate("lead-1", { role: "lead" }))
    store.upsertTeammate(makeTeammate("w1", { status: "executing", currentTaskId: "t-mid" }))
    store.upsertTeammate(makeTeammate("w2", { status: "awaiting_approval" }))
    store.upsertTask(
      makeTask("t-done", { status: "completed", result: "shipped", claimedBy: "w1" })
    )
    store.upsertTask(
      makeTask("t-mid", { status: "in_progress", claimedBy: "w1", startedAt: new Date() })
    )
    store.upsertTask(makeTask("t-claimed", { status: "claimed", claimedBy: "w2" }))
    store.upsertTask(makeTask("t-review", { status: "review" }))
    store.upsertTask(makeTask("t-todo"))

    const { remaining } = await prepareSquadResume("t1")

    const after = useAgentTeamStore.getState()
    expect(after.tasks["t-mid"]).toMatchObject({ status: "pending", claimedBy: undefined })
    expect(after.tasks["t-claimed"]).toMatchObject({ status: "pending", claimedBy: undefined })
    expect(after.tasks["t-done"]?.status).toBe("completed")
    expect(after.tasks["t-review"]?.status).toBe("review")
    expect(after.teammates.w1).toMatchObject({ status: "idle", currentTaskId: undefined })
    expect(after.teammates.w2?.status).toBe("idle")
    expect(autoPublishTaskResult).toHaveBeenCalledTimes(1)
    expect(autoPublishTaskResult.mock.calls[0]?.[2]).toBe("shipped")
    // t-mid, t-claimed and t-todo remain. Done and review do not re-dispatch.
    expect(remaining).toBe(3)
    expect(resumeTaskFilter(makeTask("x", { status: "review" }))).toBe(false)
    expect(resumeTaskFilter(makeTask("x", { status: "pending" }))).toBe(true)
  })
})
