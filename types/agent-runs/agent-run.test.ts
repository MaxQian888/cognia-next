import {
  isTerminalAgentRunStatus,
  makeAgentRunId,
  mapGoalStatus,
  mapPlanStatus,
  toAgentRunFromGoal,
  toAgentRunFromPlan,
} from "./agent-run"
import type { Goal } from "@/types/goal"
import type { AgentPlan } from "@/types/agent/plan"

const goal = (over: Partial<Goal> = {}): Goal =>
  ({
    id: "g1",
    safeObjective: "Ship the release",
    status: "active",
    tokensUsed: 42,
    createdAt: 100,
    updatedAt: 300,
    ...over,
  }) as Goal

const plan = (over: Partial<AgentPlan> = {}): AgentPlan =>
  ({
    id: "p1",
    title: "Migration plan",
    status: "executing",
    totalSteps: 4,
    completedSteps: 1,
    createdAt: 200,
    updatedAt: 400,
    ...over,
  }) as AgentPlan

describe("terminal status", () => {
  it("treats only settled statuses as terminal", () => {
    expect(isTerminalAgentRunStatus("succeeded")).toBe(true)
    expect(isTerminalAgentRunStatus("failed")).toBe(true)
    expect(isTerminalAgentRunStatus("cancelled")).toBe(true)
    expect(isTerminalAgentRunStatus("running")).toBe(false)
    expect(isTerminalAgentRunStatus("paused")).toBe(false)
  })
})

describe("makeAgentRunId", () => {
  it("prefixes the native id with its kind", () => {
    expect(makeAgentRunId("goal", "g1")).toBe("goal:g1")
  })
})

describe("status mappers", () => {
  it("maps goal statuses", () => {
    expect(mapGoalStatus("active")).toBe("running")
    expect(mapGoalStatus("paused")).toBe("paused")
    expect(mapGoalStatus("completed")).toBe("succeeded")
    expect(mapGoalStatus("stopped")).toBe("cancelled")
    expect(mapGoalStatus("preempted")).toBe("cancelled")
  })

  /** A goal stopped by a limit did not succeed, and must not be reported as one. */
  it("maps every limit outcome to failed, never to succeeded", () => {
    expect(mapGoalStatus("budget_limited")).toBe("failed")
    expect(mapGoalStatus("turn_limited")).toBe("failed")
    expect(mapGoalStatus("timed_out")).toBe("failed")
  })

  it("maps plan statuses", () => {
    expect(mapPlanStatus("executing")).toBe("running")
    expect(mapPlanStatus("completed")).toBe("succeeded")
    expect(mapPlanStatus("failed")).toBe("failed")
    expect(mapPlanStatus("cancelled")).toBe("cancelled")
  })
})

describe("legacy source mappers", () => {
  it("maps a live goal without stamping a finish time on it", () => {
    const run = toAgentRunFromGoal(goal())
    expect(run).toMatchObject({
      unifiedId: "goal:g1",
      kind: "goal",
      title: "Ship the release",
      status: "running",
      startedAt: 100,
      tokensUsed: 42,
      isLive: true,
      origin: { tableName: "chatGoals", nativeId: "g1", goalId: "g1" },
    })
    expect(run.finishedAt).toBeUndefined()
  })

  it("stamps a settled goal's finish time from its last update", () => {
    const run = toAgentRunFromGoal(goal({ status: "completed" }))
    expect(run).toMatchObject({ status: "succeeded", isLive: false, finishedAt: 300 })
  })

  it("falls back to a label when the objective is empty", () => {
    expect(toAgentRunFromGoal(goal({ safeObjective: "" })).title).toBe("Goal")
  })

  it("derives a plan's progress from its step counts", () => {
    expect(toAgentRunFromPlan(plan()).progress).toBe(0.25)
  })

  it("omits progress rather than dividing by zero on a plan with no steps", () => {
    expect(toAgentRunFromPlan(plan({ totalSteps: 0, completedSteps: 0 })).progress).toBeUndefined()
  })

  it("clamps an over-counted plan at 100%", () => {
    expect(toAgentRunFromPlan(plan({ totalSteps: 2, completedSteps: 5 })).progress).toBe(1)
  })
})
