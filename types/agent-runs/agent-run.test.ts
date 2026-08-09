import type { Goal } from "@/types/goal"
import type { AgentPlan } from "@/types/agent/plan"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { TaskExecution } from "@/types/scheduler"
import {
  compareAgentRuns,
  isTeamWorkflowId,
  isTerminalAgentRunStatus,
  makeAgentRunId,
  mapGoalStatus,
  mapExecutionRunStatus,
  mapPlanStatus,
  mapTaskExecStatus,
  mapTeamStatus,
  mapWorkflowRunStatus,
  parseAgentRunId,
  parseTeamWorkflowId,
  toAgentRunFromGoal,
  toAgentRunFromExecutionRun,
  toAgentRunFromPlan,
  toAgentRunFromTaskExecution,
  toAgentRunFromTeamRun,
  type AgentRun,
} from "./agent-run"

describe("id helpers + comparator", () => {
  it("round-trips a unified id", () => {
    const id = makeAgentRunId("team", "abc:def")
    expect(id).toBe("team:abc:def")
    expect(parseAgentRunId(id)).toEqual({ kind: "team", nativeId: "abc:def" })
  })
  it("rejects malformed ids", () => {
    expect(parseAgentRunId("nope")).toBeNull()
    expect(parseAgentRunId("goal:")).toBeNull()
  })
  it("sorts newest-first", () => {
    const a = { startedAt: 1 } as AgentRun
    const b = { startedAt: 2 } as AgentRun
    expect([a, b].sort(compareAgentRuns)[0]).toBe(b)
  })
  it("knows terminal statuses", () => {
    expect(isTerminalAgentRunStatus("succeeded")).toBe(true)
    expect(isTerminalAgentRunStatus("running")).toBe(false)
    expect(isTerminalAgentRunStatus("paused")).toBe(false)
  })
})

describe("team workflow-id contract", () => {
  it("detects + parses the __team__: prefix", () => {
    expect(isTeamWorkflowId("__team__:t1:nonce")).toBe(true)
    expect(isTeamWorkflowId("wf_plain")).toBe(false)
    expect(parseTeamWorkflowId("__team__:t1:nonce")).toEqual({ teamId: "t1" })
    expect(parseTeamWorkflowId("__team__:t1")).toEqual({ teamId: "t1" })
    expect(parseTeamWorkflowId("plain")).toBeNull()
    expect(parseTeamWorkflowId("__team__:")).toBeNull()
  })
})

describe("status mappers", () => {
  it("maps goal statuses", () => {
    expect(mapGoalStatus("active")).toBe("running")
    expect(mapGoalStatus("paused")).toBe("paused")
    expect(mapGoalStatus("completed")).toBe("succeeded")
    expect(mapGoalStatus("stopped")).toBe("cancelled")
    expect(mapGoalStatus("preempted")).toBe("cancelled")
    expect(mapGoalStatus("budget_limited")).toBe("failed")
    expect(mapGoalStatus("turn_limited")).toBe("failed")
    expect(mapGoalStatus("timed_out")).toBe("failed")
  })
  it("maps plan statuses", () => {
    expect(mapPlanStatus("executing")).toBe("running")
    expect(mapPlanStatus("approved")).toBe("running")
    expect(mapPlanStatus("draft")).toBe("running")
    expect(mapPlanStatus("awaiting_approval")).toBe("running")
    expect(mapPlanStatus("paused")).toBe("paused")
    expect(mapPlanStatus("completed")).toBe("succeeded")
    expect(mapPlanStatus("failed")).toBe("failed")
    expect(mapPlanStatus("cancelled")).toBe("cancelled")
  })
  it("maps team statuses", () => {
    expect(mapTeamStatus("planning")).toBe("running")
    expect(mapTeamStatus("executing")).toBe("running")
    expect(mapTeamStatus("paused")).toBe("paused")
    expect(mapTeamStatus("completed")).toBe("succeeded")
    expect(mapTeamStatus("failed")).toBe("failed")
    expect(mapTeamStatus("cancelled")).toBe("cancelled")
    expect(mapTeamStatus("idle")).toBe("succeeded")
  })
  it("maps workflow-run statuses", () => {
    expect(mapWorkflowRunStatus("running")).toBe("running")
    expect(mapWorkflowRunStatus("waiting")).toBe("running")
    expect(mapWorkflowRunStatus("paused")).toBe("paused")
    expect(mapWorkflowRunStatus("succeeded")).toBe("succeeded")
    expect(mapWorkflowRunStatus("failed")).toBe("failed")
    expect(mapWorkflowRunStatus("cancelled")).toBe("cancelled")
  })
  it("maps task-execution statuses", () => {
    expect(mapTaskExecStatus("running")).toBe("running")
    expect(mapTaskExecStatus("completed")).toBe("succeeded")
    expect(mapTaskExecStatus("failed")).toBe("failed")
    expect(mapTaskExecStatus("cancelled")).toBe("cancelled")
    expect(mapTaskExecStatus("skipped")).toBe("cancelled")
  })
  it("maps durable execution statuses", () => {
    expect(mapExecutionRunStatus("waiting")).toBe("running")
    expect(mapExecutionRunStatus("recovery_required")).toBe("paused")
    expect(mapExecutionRunStatus("completed")).toBe("succeeded")
  })
})

describe("row mappers", () => {
  it("maps a goal (terminal sets finishedAt)", () => {
    const goal = {
      id: "g1",
      safeObjective: "ship it",
      status: "completed",
      tokensUsed: 42,
      createdAt: 100,
      updatedAt: 200,
    } as Goal
    const run = toAgentRunFromGoal(goal)
    expect(run).toMatchObject({
      unifiedId: "goal:g1",
      kind: "goal",
      title: "ship it",
      status: "succeeded",
      startedAt: 100,
      finishedAt: 200,
      tokensUsed: 42,
      isLive: false,
    })
    expect(run.origin.goalId).toBe("g1")
  })
  it("maps a live goal (non-terminal → isLive, no finishedAt)", () => {
    const run = toAgentRunFromGoal({
      id: "g2",
      safeObjective: "",
      status: "active",
      tokensUsed: 0,
      createdAt: 1,
      updatedAt: 2,
    } as Goal)
    expect(run.isLive).toBe(true)
    expect(run.finishedAt).toBeUndefined()
    expect(run.title).toBe("Goal")
  })
  it("maps a plan with progress", () => {
    const plan = {
      id: "p1",
      title: "Migration",
      status: "executing",
      totalSteps: 4,
      completedSteps: 1,
      createdAt: 10,
      updatedAt: 20,
    } as AgentPlan
    const run = toAgentRunFromPlan(plan)
    expect(run).toMatchObject({
      unifiedId: "plan:p1",
      kind: "plan",
      status: "running",
      progress: 0.25,
    })
    expect(run.origin.planId).toBe("p1")
  })
  it("maps a team run and prefers the live team status when supplied", () => {
    const row = {
      id: "wr1",
      workflowId: "__team__:team9:nonce",
      status: "succeeded",
      startedAt: 5,
      completedAt: 9,
      workflowSnapshot: { name: "Review Team" },
      output: { ok: 1 },
    } as unknown as WorkflowRunRow
    const historical = toAgentRunFromTeamRun(row)
    expect(historical).toMatchObject({
      kind: "team",
      title: "Review Team",
      status: "succeeded",
      isLive: false,
    })
    expect(historical.origin.teamId).toBe("team9")

    const live = toAgentRunFromTeamRun(row, "executing")
    expect(live.status).toBe("running")
    expect(live.isLive).toBe(true)
    expect(live.finishedAt).toBeUndefined()
  })
  it("maps a scheduled-task execution with error", () => {
    const exec = {
      id: "e1",
      taskName: "Nightly goal",
      status: "failed",
      startedAt: new Date(1000),
      completedAt: new Date(2000),
      error: "boom",
    } as unknown as TaskExecution
    const run = toAgentRunFromTaskExecution(exec)
    expect(run).toMatchObject({
      unifiedId: "scheduled-task:e1",
      kind: "scheduled-task",
      title: "Nightly goal",
      status: "failed",
      startedAt: 1000,
      finishedAt: 2000,
    })
    expect(run.error).toEqual({ message: "boom" })
  })
  it("maps a canonical durable run without changing its legacy deep-link identity", () => {
    const run = toAgentRunFromExecutionRun({
      id: "execution:goal:g1",
      kind: "goal",
      sourceId: "g1",
      title: "Canonical goal",
      status: "completed",
      currentRevision: 2,
      startedAt: 100,
      updatedAt: 200,
      endedAt: 200,
    })
    expect(run).toMatchObject({
      unifiedId: "goal:g1",
      status: "succeeded",
      origin: { tableName: "executionRuns", nativeId: "g1", executionRunId: "execution:goal:g1" },
    })
  })
})
