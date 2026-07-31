import { renderHook } from "@testing-library/react"
import { useAgentRunActions } from "./use-agent-run-actions"
import type { AgentRun } from "@/types/agent-runs/agent-run"

const stopGoal = jest.fn()
const pauseGoal = jest.fn()
const resumeGoal = jest.fn()
jest.mock("@/lib/goal/runtime", () => ({
  getGoalRuntime: () => ({ stopGoal, pauseGoal, resumeGoal }),
}))

const cancelPlan = jest.fn()
const pausePlan = jest.fn()
const resumePlan = jest.fn()
jest.mock("@/lib/agent/plan/runtime", () => ({
  getPlanRuntime: () => ({ cancelPlan, pausePlan, resumePlan }),
}))

const abortTeam = jest.fn()
jest.mock("@/lib/ai/agent/agent-team-runtime", () => ({
  abortTeam: (...a: unknown[]) => abortTeam(...a),
}))

const teamPause = jest.fn()
jest.mock("@/lib/ai/agent/agent-team", () => ({
  agentTeamManager: { pause: (...a: unknown[]) => teamPause(...a) },
}))

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    unifiedId: "goal:g1",
    kind: "goal",
    title: "t",
    status: "running",
    startedAt: 0,
    isLive: true,
    origin: { tableName: "chatGoals", nativeId: "g1", goalId: "g1" },
    ...over,
  } as AgentRun
}

beforeEach(() => {
  ;[
    stopGoal,
    pauseGoal,
    resumeGoal,
    cancelPlan,
    pausePlan,
    resumePlan,
    abortTeam,
    teamPause,
  ].forEach((m) => m.mockReset())
})

describe("useAgentRunActions — capabilities", () => {
  it("gates abort/pause/resume by kind + status", () => {
    const { result } = renderHook(() => useAgentRunActions())
    const a = result.current
    expect(a.canAbort(run({ isLive: true }))).toBe(true)
    expect(a.canAbort(run({ kind: "scheduled-task", isLive: true }))).toBe(false)
    expect(a.canPause(run({ status: "running" }))).toBe(true)
    expect(a.canPause(run({ status: "paused" }))).toBe(false)
    expect(a.canResume(run({ kind: "goal", status: "paused" }))).toBe(true)
    expect(a.canResume(run({ kind: "team", status: "paused" }))).toBe(false)
  })
})

describe("useAgentRunActions — routing", () => {
  it("routes goal actions to the goal runtime", async () => {
    const { result } = renderHook(() => useAgentRunActions())
    await result.current.abort(run({ kind: "goal" }))
    await result.current.pause(run({ kind: "goal" }))
    await result.current.resume(run({ kind: "goal", status: "paused" }))
    expect(stopGoal).toHaveBeenCalledWith("g1")
    expect(pauseGoal).toHaveBeenCalledWith("g1")
    expect(resumeGoal).toHaveBeenCalledWith("g1")
  })

  it("routes plan actions to the plan runtime", async () => {
    const { result } = renderHook(() => useAgentRunActions())
    const p = run({
      kind: "plan",
      origin: { tableName: "agentPlans", nativeId: "p1", planId: "p1" },
    })
    await result.current.abort(p)
    await result.current.pause(p)
    await result.current.resume({ ...p, status: "paused" })
    expect(cancelPlan).toHaveBeenCalledWith("p1")
    expect(pausePlan).toHaveBeenCalledWith("p1")
    expect(resumePlan).toHaveBeenCalledWith("p1")
  })

  it("routes team abort + pause to the team runtime", async () => {
    const { result } = renderHook(() => useAgentRunActions())
    const t = run({
      kind: "team",
      origin: { tableName: "workflowRuns", nativeId: "wr1", teamId: "teamA" },
    })
    await result.current.abort(t)
    await result.current.pause(t)
    expect(abortTeam).toHaveBeenCalledWith("teamA", expect.any(String))
    expect(teamPause).toHaveBeenCalledWith("teamA")
  })

  it("is a no-op for a team without a resolvable teamId", async () => {
    const { result } = renderHook(() => useAgentRunActions())
    await result.current.abort(
      run({ kind: "team", origin: { tableName: "workflowRuns", nativeId: "x" } })
    )
    expect(abortTeam).not.toHaveBeenCalled()
  })

  it("does not act on scheduled-task runs", async () => {
    const { result } = renderHook(() => useAgentRunActions())
    await result.current.abort(run({ kind: "scheduled-task" }))
    expect(stopGoal).not.toHaveBeenCalled()
    expect(abortTeam).not.toHaveBeenCalled()
  })
})
