import { renderHook } from "@testing-library/react"
import { useAgentRuns } from "./use-agent-runs"
import type { Goal } from "@/types/goal"
import type { AgentPlan } from "@/types/agent/plan"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { TaskExecution } from "@/types/scheduler"
import type { ExecutionRun } from "@/types/execution/run"

// useLiveQuery is called 5× per render in a fixed order:
// canonical runs, goals, plans, teamRuns, taskExecutions. Cycle the queued datasets mod 5 so
// any number of re-renders returns consistent values per source.
let liveQueryResults: unknown[] = []
let callIdx = 0
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: () => liveQueryResults[callIdx++ % 5],
}))

let mockTeams: Record<string, { status: string }> = {}
jest.mock("@/stores/agent/agent-team-store/store", () => ({
  useAgentTeamStore: (sel: (s: { teams: unknown }) => unknown) => sel({ teams: mockTeams }),
}))

// The Dexie querier closures never run (useLiveQuery is mocked), but the module
// imports must still resolve — stub the data sources to inert no-ops.
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))
jest.mock("@/lib/db/goals", () => ({ listAllGoals: jest.fn() }))
jest.mock("@/lib/db/execution-runs", () => ({ listExecutionRuns: jest.fn() }))
jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: { getRecentExecutions: jest.fn() },
}))

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: "g1",
    safeObjective: "goal one",
    status: "active",
    tokensUsed: 0,
    createdAt: 300,
    updatedAt: 300,
    ...over,
  } as Goal
}
function plan(over: Partial<AgentPlan> = {}): AgentPlan {
  return {
    id: "p1",
    title: "plan one",
    status: "completed",
    totalSteps: 2,
    completedSteps: 2,
    createdAt: 200,
    updatedAt: 250,
    ...over,
  } as AgentPlan
}
function teamRow(over: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: "wr1",
    workflowId: "__team__:teamA:nonce",
    status: "succeeded",
    startedAt: 100,
    completedAt: 150,
    workflowSnapshot: { name: "Team A" },
    ...over,
  } as unknown as WorkflowRunRow
}
function exec(over: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id: "e1",
    taskName: "sched goal",
    taskType: "goal",
    status: "completed",
    startedAt: new Date(50),
    completedAt: new Date(60),
    ...over,
  } as unknown as TaskExecution
}
function canonical(over: Partial<ExecutionRun> = {}): ExecutionRun {
  return {
    id: "execution:goal:g1",
    kind: "goal",
    sourceId: "g1",
    title: "canonical goal",
    status: "running",
    currentRevision: 1,
    startedAt: 300,
    updatedAt: 300,
    ...over,
  }
}

function setSources(opts: {
  canonicalRuns?: ExecutionRun[]
  goals?: Goal[]
  plans?: AgentPlan[]
  teamRuns?: WorkflowRunRow[]
  execs?: TaskExecution[]
}) {
  liveQueryResults = [opts.canonicalRuns, opts.goals, opts.plans, opts.teamRuns, opts.execs]
  callIdx = 0
}

beforeEach(() => {
  mockTeams = {}
  callIdx = 0
})

describe("useAgentRuns", () => {
  it("fans in all four kinds newest-first", () => {
    setSources({
      canonicalRuns: [],
      goals: [goal()],
      plans: [plan()],
      teamRuns: [teamRow()],
      execs: [exec()],
    })
    const { result } = renderHook(() => useAgentRuns())
    expect(result.current.isLoading).toBe(false)
    expect(result.current.runs.map((r) => r.kind)).toEqual([
      "goal",
      "plan",
      "team",
      "scheduled-task",
    ])
  })

  it("reports loading while any source is undefined", () => {
    setSources({ canonicalRuns: [], goals: undefined, plans: [], teamRuns: [], execs: [] })
    const { result } = renderHook(() => useAgentRuns())
    expect(result.current.isLoading).toBe(true)
  })

  it("filters by kind", () => {
    setSources({
      canonicalRuns: [],
      goals: [goal()],
      plans: [plan()],
      teamRuns: [teamRow()],
      execs: [exec()],
    })
    const { result } = renderHook(() => useAgentRuns({ filterKind: "team" }))
    expect(result.current.runs.map((r) => r.kind)).toEqual(["team"])
  })

  it("filters by title query (case-insensitive)", () => {
    setSources({
      canonicalRuns: [],
      goals: [goal({ safeObjective: "Ship It" })],
      plans: [plan({ title: "other" })],
    })
    const { result } = renderHook(() => useAgentRuns({ query: "ship" }))
    expect(result.current.runs.map((r) => r.title)).toEqual(["Ship It"])
  })

  it("excludes non-team workflow runs", () => {
    setSources({
      canonicalRuns: [],
      teamRuns: [teamRow({ id: "wr2", workflowId: "wf_plain" }), teamRow()],
    })
    const { result } = renderHook(() => useAgentRuns())
    expect(result.current.runs.map((r) => r.origin.nativeId)).toEqual(["wr1"])
  })

  it("only includes agent-kind scheduled executions", () => {
    setSources({
      canonicalRuns: [],
      execs: [exec({ taskType: "chat" }), exec({ id: "e2", taskType: "plan" })],
    })
    const { result } = renderHook(() => useAgentRuns())
    expect(result.current.runs.map((r) => r.origin.nativeId)).toEqual(["e2"])
  })

  it("annotates the newest team run with a live store status", () => {
    mockTeams = { teamA: { status: "executing" } }
    setSources({
      canonicalRuns: [],
      teamRuns: [
        teamRow({ id: "new", startedAt: 200 }),
        teamRow({ id: "old", startedAt: 100, status: "succeeded" }),
      ],
    })
    const { result } = renderHook(() => useAgentRuns())
    const byId = Object.fromEntries(result.current.runs.map((r) => [r.origin.nativeId, r]))
    expect(byId.new.status).toBe("running")
    expect(byId.new.isLive).toBe(true)
    // The older completed run is NOT re-annotated as live.
    expect(byId.old.status).toBe("succeeded")
    expect(byId.old.isLive).toBe(false)
  })

  it("prefers the canonical journal row over the matching legacy source", () => {
    setSources({
      canonicalRuns: [canonical({ title: "canonical title" })],
      goals: [goal({ safeObjective: "legacy title" })],
      plans: [],
      teamRuns: [],
      execs: [],
    })
    const { result } = renderHook(() => useAgentRuns())
    expect(result.current.runs).toHaveLength(1)
    expect(result.current.runs[0]).toMatchObject({
      title: "canonical title",
      origin: { tableName: "executionRuns" },
    })
  })

  it("keeps legacy source control identifiers when the canonical team row wins", () => {
    setSources({
      canonicalRuns: [
        canonical({
          id: "execution:workflow:wr1",
          kind: "team",
          sourceId: "wr1",
          title: "canonical team",
        }),
      ],
      goals: [],
      plans: [],
      teamRuns: [teamRow()],
      execs: [],
    })

    const { result } = renderHook(() => useAgentRuns())

    expect(result.current.runs).toHaveLength(1)
    expect(result.current.runs[0]).toMatchObject({
      title: "canonical team",
      origin: {
        tableName: "executionRuns",
        nativeId: "wr1",
        executionRunId: "execution:workflow:wr1",
        teamId: "teamA",
      },
    })
  })
})
