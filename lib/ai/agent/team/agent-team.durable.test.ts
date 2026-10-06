import type { AgentTeam } from "@/types/agent/agent-team"

const recover = jest.fn(async () => [{ runId: "run-1", status: "needs_input" as const }])
const retryChild = jest.fn(async () => undefined)
const runSquadLifecycle = jest.fn<Promise<{ runId: string; status: "failed" }>, [unknown]>(
  async () => ({ runId: "run-1", status: "failed" })
)
const prepareSquadResume = jest.fn(async () => ({ remaining: 1 }))
const restoredInput = {
  teamId: "team-1",
  runId: "run-1",
  origin: "scheduler" as const,
  requirePlanApprovalFloor: true,
  sessionWorkingDir: "/original-workspace",
}
const restoreSquadRunInput = jest.fn<
  ReturnType<typeof import("./squad/squad-lifecycle-runner").restoreSquadRunInput>,
  Parameters<typeof import("./squad/squad-lifecycle-runner").restoreSquadRunInput>
>(async () => restoredInput)
const parkSquadRecovery = jest.fn<
  ReturnType<typeof import("./squad/squad-lifecycle-runner").parkSquadRecovery>,
  Parameters<typeof import("./squad/squad-lifecycle-runner").parkSquadRecovery>
>(async () => undefined)
const controlSquadTeam = jest.fn(async (_teamId: string, _action: string) => ({
  ok: true,
  status: "paused",
}))
const getAgentTeamRun = jest.fn(async () => ({
  id: "run-1",
  teamId: "team-1",
  status: "recovering",
}))
const getAgentTeamChildRun = jest.fn(async () => ({
  id: "child-1",
  runId: "run-1",
  teamId: "team-1",
  taskId: "task-1",
}))
const setTeamStatus = jest.fn()
const updateTask = jest.fn()
const listPendingSquadReviews = jest.fn(
  async () =>
    [] as Array<{
      id: string
      reviewKind: string
    }>
)
const openSquadReview = jest.fn()
jest.mock("./gates/squad-review-gate", () => ({
  listPendingSquadReviews: () => listPendingSquadReviews(),
  openSquadReview: (...args: unknown[]) => openSquadReview(...args),
  squadReviewRequestIdFromInterrupt: () => ({
    runId: "run-1",
    kind: "budget_extension",
    instance: "crossing-1",
  }),
}))

const team = { id: "team-1", status: "executing", config: {} } as AgentTeam

const storeState = {
  teams: { "team-1": team },
  tasks: {},
  teammates: {},
  getTeam: (id: string) => (id === team.id ? team : undefined),
  setTeamStatus,
  updateTask,
}

jest.mock("@/stores/agent/agent-team-store", () => ({
  useAgentTeamStore: { getState: () => storeState },
}))

jest.mock("./durable/durable-runtime", () => ({
  getDurableTeamCoordinator: () => ({ recover, retryChild }),
}))

jest.mock("@/lib/db/agent-team-runtime", () => ({
  getAgentTeamRun: () => getAgentTeamRun(),
  getAgentTeamChildRun: () => getAgentTeamChildRun(),
}))

const guardSquadResume = jest.fn<
  ReturnType<typeof import("./squad/squad-lifecycle-runner").guardSquadResume>,
  Parameters<typeof import("./squad/squad-lifecycle-runner").guardSquadResume>
>(async () => ({ blocked: false, blockers: [] }))
jest.mock("./squad/squad-lifecycle-runner", () => ({
  runSquadLifecycle: (input: unknown) => runSquadLifecycle(input),
  prepareSquadResume: () => prepareSquadResume(),
  restoreSquadRunInput: (teamId: string, runId: string) => restoreSquadRunInput(teamId, runId),
  parkSquadRecovery: (...args: Parameters<typeof parkSquadRecovery>) => parkSquadRecovery(...args),
  guardSquadResume: (teamId: string, runId: string) => guardSquadResume(teamId, runId),
  resumeTaskFilter: () => true,
  configureAgentTeamRuntime: jest.fn(),
  __resetAgentTeamRuntimeForTesting: jest.fn(),
}))

jest.mock("./squad/squad-control", () => ({
  controlSquadTeam: (teamId: string, action: string) => controlSquadTeam(teamId, action),
  controlSquadRun: (runId: string, action: string) => controlSquadTeam(runId, action),
}))

import { agentTeamManager, recoverDurableAgentTeams } from "./agent-team"

describe("durable AgentTeam manager", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    listPendingSquadReviews.mockResolvedValue([])
    getAgentTeamRun.mockResolvedValue({ id: "run-1", teamId: "team-1", status: "recovering" })
  })

  it("keeps startup ready while a restored review waits, then checks readiness after approval", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    listPendingSquadReviews.mockResolvedValueOnce([
      { id: "review-1", reviewKind: "budget_extension" },
    ])
    let approve!: (value: unknown) => void
    openSquadReview.mockReturnValueOnce(
      new Promise((resolve) => {
        approve = resolve
      })
    )
    await recoverDurableAgentTeams()
    expect(openSquadReview).toHaveBeenCalled()
    expect(guardSquadResume).not.toHaveBeenCalled()
    expect(runSquadLifecycle).not.toHaveBeenCalled()

    approve({ kind: "budget_extension", outcome: "approve", extraTokens: 25000 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(guardSquadResume).toHaveBeenCalledWith("team-1", "run-1")
    expect(runSquadLifecycle).toHaveBeenCalledWith(expect.objectContaining(restoredInput))
  })

  it("pauses a refused restored review without re-entering work", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    listPendingSquadReviews.mockResolvedValueOnce([
      { id: "review-1", reviewKind: "budget_extension" },
    ])
    openSquadReview.mockResolvedValueOnce({ kind: "budget_extension", outcome: "deny" })
    await recoverDurableAgentTeams()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(controlSquadTeam).toHaveBeenCalledWith("run-1", "pause")
    expect(guardSquadResume).not.toHaveBeenCalled()
    expect(runSquadLifecycle).not.toHaveBeenCalled()
  })

  it("honors a pause during the restored run's readiness check", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    listPendingSquadReviews.mockResolvedValueOnce([
      { id: "review-1", reviewKind: "budget_extension" },
    ])
    openSquadReview.mockResolvedValueOnce({ kind: "budget_extension", outcome: "approve" })
    let finishGuard!: (result: { blocked: boolean; blockers: Array<{ code: string }> }) => void
    guardSquadResume.mockReturnValueOnce(
      new Promise((resolve) => {
        finishGuard = resolve
      })
    )
    await recoverDurableAgentTeams()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(guardSquadResume).toHaveBeenCalled()
    getAgentTeamRun.mockResolvedValue({ id: "run-1", teamId: "team-1", status: "paused" })
    finishGuard({ blocked: false, blockers: [] })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runSquadLifecycle).not.toHaveBeenCalled()
    expect(parkSquadRecovery).not.toHaveBeenCalled()
  })

  it.each(["review", "guard"])(
    "parks unexpected %s failures instead of stranding recovery",
    async (failure) => {
      recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
      listPendingSquadReviews.mockResolvedValueOnce([
        { id: "review-1", reviewKind: "budget_extension" },
      ])
      if (failure === "review")
        openSquadReview.mockRejectedValueOnce(new Error("review read failed"))
      else {
        openSquadReview.mockResolvedValueOnce({ kind: "budget_extension", outcome: "approve" })
        guardSquadResume.mockRejectedValueOnce(new Error("readiness read failed"))
      }
      await recoverDurableAgentTeams()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(parkSquadRecovery).toHaveBeenCalledWith("run-1", "team-1", "reentry_failed")
      expect(runSquadLifecycle).not.toHaveBeenCalled()
    }
  )

  it.each(["aborted", "cancelled", "paused"])(
    "does not resume a %s run when its old review settles",
    async (state) => {
      recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
      listPendingSquadReviews.mockResolvedValueOnce([
        { id: "review-1", reviewKind: "budget_extension" },
      ])
      let approve!: (value: unknown) => void
      openSquadReview.mockReturnValueOnce(
        new Promise((resolve) => {
          approve = resolve
        })
      )
      const controller = new AbortController()
      await recoverDurableAgentTeams({ signal: controller.signal })
      expect(openSquadReview).toHaveBeenCalledWith(
        expect.objectContaining({ signal: controller.signal })
      )
      if (state === "aborted") controller.abort()
      else getAgentTeamRun.mockResolvedValueOnce({ id: "run-1", teamId: "team-1", status: state })
      approve({ kind: "budget_extension", outcome: "approve", extraTokens: 25000 })
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(guardSquadResume).not.toHaveBeenCalled()
      expect(runSquadLifecycle).not.toHaveBeenCalled()
      expect(controlSquadTeam).not.toHaveBeenCalled()
    }
  )

  it("projects uncertain recovery as an operator input gate without replaying work", async () => {
    await expect(recoverDurableAgentTeams()).resolves.toEqual([
      { runId: "run-1", status: "needs_input" },
    ])
    expect(setTeamStatus).toHaveBeenCalledWith("team-1", "paused")
    expect(runSquadLifecycle).not.toHaveBeenCalled()
  })

  it("re-enters a safely recoverable run over its remaining work", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    await recoverDurableAgentTeams()
    expect(restoreSquadRunInput).toHaveBeenCalledWith("team-1", "run-1")
    expect(prepareSquadResume).toHaveBeenCalledTimes(1)
    expect(runSquadLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        ...restoredInput,
        taskFilter: expect.any(Function),
      })
    )
  })

  it("does not re-enter a run whose Squad is no longer ready", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    guardSquadResume.mockResolvedValueOnce({
      blocked: true,
      blockers: [{ code: "missing_environment_ref" }],
    })
    const outcomes = await recoverDurableAgentTeams()
    expect(prepareSquadResume).not.toHaveBeenCalled()
    expect(runSquadLifecycle).not.toHaveBeenCalled()
    expect(restoreSquadRunInput).not.toHaveBeenCalled()
    expect(outcomes.map((o) => o.status)).toContain("needs_input")
  })

  it("requires operator input when the original run constraints cannot be restored", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    restoreSquadRunInput.mockResolvedValueOnce(undefined)

    await expect(recoverDurableAgentTeams()).resolves.toEqual([
      { runId: "run-1", status: "needs_input" },
    ])
    expect(prepareSquadResume).not.toHaveBeenCalled()
    expect(runSquadLifecycle).not.toHaveBeenCalled()
  })

  it("parks a recovered run when lifecycle re-entry rejects", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    runSquadLifecycle.mockRejectedValueOnce(new Error("re-entry failed"))

    await recoverDurableAgentTeams()

    expect(parkSquadRecovery).toHaveBeenCalledWith("run-1", "team-1", "reentry_failed")
  })

  it("parks a lifecycle failure after it has claimed the recovering run", async () => {
    recover.mockResolvedValueOnce([{ runId: "run-1", status: "recovering" as never }])
    runSquadLifecycle.mockImplementationOnce(async () => {
      getAgentTeamRun.mockResolvedValue({ id: "run-1", teamId: "team-1", status: "running" })
      throw new Error("execution failed")
    })
    await recoverDurableAgentTeams()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(parkSquadRecovery).toHaveBeenCalledWith("run-1", "team-1", "reentry_failed")
  })

  /** Team-addressed verbs are adapters onto the one control state machine. */
  it.each([
    ["pause", "pause"],
    ["resume", "resume"],
    ["shutdown", "stop"],
  ] as const)("routes %s through controlSquadTeam as %s", async (verb, action) => {
    await agentTeamManager[verb]("team-1")
    expect(controlSquadTeam).toHaveBeenCalledWith("team-1", action)
  })

  it("retries one child through the durable coordinator and re-enters only that task", async () => {
    await agentTeamManager.retryChild("child-1", "device:worker-b")

    expect(retryChild).toHaveBeenCalledWith("child-1", "device:worker-b")
    expect(updateTask).toHaveBeenCalledWith("task-1", {
      status: "pending",
      error: undefined,
      completedAt: undefined,
    })
    const input = runSquadLifecycle.mock.calls[0]?.[0] as {
      teamId: string
      runId: string
      taskFilter: (task: { id: string }) => boolean
    }
    expect(input).toMatchObject(restoredInput)
    expect(input.taskFilter({ id: "task-1" })).toBe(true)
    expect(input.taskFilter({ id: "task-2" })).toBe(false)
  })
})
