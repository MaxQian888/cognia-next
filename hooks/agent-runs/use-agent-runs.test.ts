import { act, renderHook } from "@testing-library/react"

import { useExecutionCockpit } from "./use-agent-runs"
import { COCKPIT_PAGE_SIZE } from "@/lib/execution/cockpit-model"
import type { ExecutionRun, ExecutionRunKind, ExecutionRunStatus } from "@/types/execution/run"
import type { Goal } from "@/types/goal"

let persisted: unknown
let capturedDeps: unknown[] = []
jest.mock("dexie-react-hooks", () => ({
  useLiveQuery: (_fn: unknown, deps: unknown[]) => {
    capturedDeps = deps
    return persisted
  },
}))

let brokerLegs: unknown[] = []
jest.mock("@/lib/execution/broker", () => ({
  getExecutionBroker: () => ({
    subscribe: () => () => {},
    getSnapshot: () => brokerLegs,
  }),
}))

// The Dexie closures never run (useLiveQuery is mocked) but must still resolve.
jest.mock("@/lib/db/schema", () => ({ getDb: () => ({}) }))
jest.mock("@/lib/db/goals", () => ({ listAllGoals: jest.fn() }))
jest.mock("@/lib/db/execution-runs", () => ({ listExecutionRuns: jest.fn() }))
jest.mock("@/lib/scheduler/scheduler-db", () => ({
  schedulerDb: { getRecentExecutions: jest.fn() },
}))

function run(
  id: string,
  kind: ExecutionRunKind,
  status: ExecutionRunStatus,
  over: Partial<ExecutionRun> = {}
): ExecutionRun {
  return {
    id,
    kind,
    sourceId: id,
    title: id,
    status,
    currentRevision: 1,
    startedAt: 1_000,
    updatedAt: 1_000,
    latestSnapshot: {
      runId: id,
      kind,
      title: id,
      status,
      revision: 1,
      startedAt: 1_000,
      updatedAt: 1_000,
      progress: { completed: 0, total: 0, trustworthy: false },
      activeSteps: [],
      recentSteps: [],
      pendingSteps: [],
      pendingStepCount: 0,
      elapsedMs: 1,
      artifacts: [],
      allowedActions: ["stop", "open_details"],
    },
    ...over,
  }
}

function sources(over: Record<string, unknown> = {}) {
  return {
    executionRuns: [],
    workflowRuns: [],
    schedulerExecutions: [],
    goals: [],
    plans: [],
    limit: COCKPIT_PAGE_SIZE,
    ...over,
  }
}

beforeEach(() => {
  persisted = undefined
  brokerLegs = []
  capturedDeps = []
})

describe("useExecutionCockpit", () => {
  it("is loading until the persisted sources resolve", () => {
    const { result } = renderHook(() => useExecutionCockpit())
    expect(result.current.isLoading).toBe(true)
    expect(result.current.rows).toEqual([])
  })

  /**
   * The defect that motivated the rewrite: `toAgentRunFromExecutionRun` returns
   * null for these three kinds, so the old panel structurally could not show a
   * chat turn, a workflow or a delegation.
   */
  it("shows chat turns, workflows, delegations and jobs — not just goal/team/plan", () => {
    persisted = sources({
      executionRuns: [
        run("r-chat", "agent-turn", "running"),
        run("r-wf", "workflow", "running"),
        run("r-del", "delegation", "waiting"),
        run("r-job", "job", "running"),
        run("r-goal", "goal", "running"),
      ],
    })
    const { result } = renderHook(() => useExecutionCockpit())
    expect(result.current.rows.map((r) => r.kind).sort()).toEqual([
      "agent-turn",
      "delegation",
      "goal",
      "job",
      "workflow",
    ])
  })

  it("keeps settled runs — the cockpit is a history view, not a live monitor", () => {
    persisted = sources({
      executionRuns: [run("r-ok", "goal", "completed"), run("r-bad", "team", "failed")],
    })
    const { result } = renderHook(() => useExecutionCockpit())
    expect(result.current.rows).toHaveLength(2)
    expect(result.current.statusCounts).toEqual({
      running: 0,
      waiting: 0,
      failed: 1,
      finished: 1,
    })
  })

  it("returns a directly selected run even when it is outside the loaded page", () => {
    persisted = sources({
      executionRuns: [run("newest", "agent-turn", "running")],
      selectedRun: run("older-deep-link", "goal", "completed"),
    })

    const { result } = renderHook(() => useExecutionCockpit({ selectedId: "older-deep-link" }))

    expect(result.current.selectedRow?.runId).toBe("older-deep-link")
  })

  /**
   * A count derived from the filtered list would read "Failed 0" once you pick
   * Running, so the status axis is released for its own counts. Every OTHER
   * axis stays applied, which is what makes a count the size of the result of
   * picking it rather than a tally of a list this page cannot render.
   */
  it("releases only the axis it is counting, and holds every other one", () => {
    persisted = sources({
      executionRuns: [run("r1", "goal", "running"), run("r2", "goal", "failed")],
    })
    const { result } = renderHook(() => useExecutionCockpit({ statusGroup: "running" }))
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.allRows).toHaveLength(2)
    // Released: picking Failed would render one row.
    expect(result.current.statusCounts.failed).toBe(1)
    expect(result.current.statusTotal).toBe(2)
    // Held: picking the Goal kind while Running is selected renders one row,
    // not two. It used to read 2 — a number the list could not produce.
    expect(result.current.kindCounts.goal).toBe(1)
    expect(result.current.kindTotal).toBe(1)
  })

  /**
   * The `/squads` Runs tab pins `kind: "team"`. The chips counted `allRows`
   * and advertised every run in the journal over a list that rendered none.
   */
  it("counts inside a pinned kind, not across the whole journal", () => {
    persisted = sources({
      executionRuns: [
        run("r1", "goal", "running"),
        run("r2", "goal", "failed"),
        run("r3", "agent-turn", "completed"),
      ],
    })
    const { result } = renderHook(() => useExecutionCockpit({ kind: "team" }))
    expect(result.current.allRows).toHaveLength(3)
    expect(result.current.rows).toHaveLength(0)
    expect(result.current.statusTotal).toBe(0)
    expect(result.current.statusCounts).toEqual({
      running: 0,
      waiting: 0,
      failed: 0,
      finished: 0,
    })
  })

  it("filters by kind and by label query", () => {
    persisted = sources({
      executionRuns: [run("ship-it", "goal", "running"), run("flake-fix", "agent-turn", "running")],
    })
    const byKind = renderHook(() => useExecutionCockpit({ kind: "chat" }))
    expect(byKind.result.current.rows.map((r) => r.nativeId)).toEqual(["flake-fix"])

    const byQuery = renderHook(() => useExecutionCockpit({ query: "SHIP" }))
    expect(byQuery.result.current.rows.map((r) => r.nativeId)).toEqual(["ship-it"])
  })

  it("filters by where the run was asked for", () => {
    persisted = sources({
      executionRuns: [
        run("api-run", "fusion", "running", {
          origin: "gateway-api",
          originActor: { keyId: "key-a", keyName: "CI robot" },
        }),
        run("here", "agent-turn", "running"),
      ],
    })
    const remote = renderHook(() => useExecutionCockpit({ origin: "gateway-api" }))
    expect(remote.result.current.rows.map((r) => r.nativeId)).toEqual(["api-run"])

    // A run with no origin came from this device, which is what it means.
    const local = renderHook(() => useExecutionCockpit({ origin: "local" }))
    expect(local.result.current.rows.map((r) => r.nativeId)).toEqual(["here"])
  })

  it("suppresses a legacy goal once its canonical run exists", () => {
    const legacyGoal = {
      id: "g1",
      safeObjective: "goal one",
      status: "active",
      createdAt: 300,
      updatedAt: 300,
    } as Goal
    persisted = sources({
      executionRuns: [run("g1", "goal", "running")],
      goals: [legacyGoal],
    })
    const { result } = renderHook(() => useExecutionCockpit())
    expect(result.current.rows).toHaveLength(1)
    expect(result.current.rows[0].source).toBe("journal")
  })

  it("raises the ceiling rather than walking an offset", () => {
    persisted = sources()
    const { result } = renderHook(() => useExecutionCockpit())
    expect(capturedDeps).toEqual([COCKPIT_PAGE_SIZE])

    act(() => result.current.loadMore())
    expect(capturedDeps).toEqual([COCKPIT_PAGE_SIZE * 2])
  })

  it("offers more when ANY source filled its page, not only the journal", () => {
    // A user whose goals all predate the bridge: full legacy page, empty journal.
    persisted = sources({
      goals: Array.from({ length: COCKPIT_PAGE_SIZE }, (_, i) => ({
        id: `g${i}`,
        safeObjective: `goal ${i}`,
        status: "active",
        createdAt: i,
        updatedAt: i,
      })) as Goal[],
    })
    const { result } = renderHook(() => useExecutionCockpit())
    expect(result.current.hasMore).toBe(true)
  })

  it("does not offer more when every source came back short", () => {
    persisted = sources({ executionRuns: [run("r1", "goal", "running")] })
    const { result } = renderHook(() => useExecutionCockpit())
    expect(result.current.hasMore).toBe(false)
  })
})
