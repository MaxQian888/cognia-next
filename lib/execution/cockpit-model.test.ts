import {
  COCKPIT_PAGE_SIZE,
  COCKPIT_STATUS_GROUPS,
  buildCockpitFacets,
  buildCockpitRows,
  cockpitHasMore,
  cockpitStatusGroup,
  countCockpitRowsByStatus,
  filterCockpitRows,
  legacyAgentRunRow,
  type CockpitFilter,
} from "./cockpit-model"
import { EXECUTION_FILTER_KINDS, type UnifiedExecutionRow } from "./monitor-model"
import type { ExecutionLegSnapshot } from "./types"
import type { ExecutionRun, ExecutionRunStatus, RunControlAction } from "@/types/execution/run"
import type { Goal } from "@/types/goal"

function execRun(over: Partial<ExecutionRun> = {}): ExecutionRun {
  const status: ExecutionRunStatus = over.status ?? "running"
  const allowedActions: RunControlAction[] = ["stop", "open_details"]
  // The label comes off `latestSnapshot.title` — the live projection wins over
  // the row's creation-time title — so the helper has to thread it through both.
  const title = over.title ?? "Ship the release"
  return {
    id: `execution:goal:${over.sourceId ?? "g1"}`,
    kind: "goal",
    sourceId: "g1",
    title,
    status,
    currentRevision: 3,
    startedAt: 1_000,
    updatedAt: 2_000,
    latestSnapshot: {
      runId: `execution:goal:${over.sourceId ?? "g1"}`,
      kind: "goal",
      title,
      status,
      revision: 3,
      startedAt: 1_000,
      updatedAt: 2_000,
      progress: { completed: 2, total: 4, ratio: 0.5, trustworthy: true },
      activeSteps: [],
      recentSteps: [],
      pendingSteps: [],
      pendingStepCount: 0,
      elapsedMs: 1_000,
      artifacts: [],
      allowedActions,
    },
    ...over,
  }
}

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: "g-legacy",
    sessionId: "s1",
    safeObjective: "Old goal",
    status: "active",
    createdAt: 500,
    updatedAt: 600,
    generationId: 1,
    ...over,
  } as Goal
}

function leg(over: Partial<ExecutionLegSnapshot> = {}): ExecutionLegSnapshot {
  return {
    id: "leg-1",
    kind: "chat",
    label: "Chat",
    state: "running",
    startedAt: 3_000,
    cancelled: false,
    ...over,
  } as ExecutionLegSnapshot
}

describe("cockpit status groups", () => {
  it("buckets queued and waiting together — both answer 'why is nothing happening'", () => {
    expect(cockpitStatusGroup({ status: "queued" } as never)).toBe("waiting")
    expect(cockpitStatusGroup({ status: "waiting" } as never)).toBe("waiting")
  })

  /**
   * The reason the bucket is not called "completed": a cancelled run is
   * finished, but reporting it as completed would claim it succeeded.
   */
  it("puts cancelled in `finished`, never in `failed` or `completed`", () => {
    expect(cockpitStatusGroup({ status: "cancelled" } as never)).toBe("finished")
    expect(cockpitStatusGroup({ status: "done" } as never)).toBe("finished")
    expect(cockpitStatusGroup({ status: "error" } as never)).toBe("failed")
  })

  it("counts every row exactly once", () => {
    const rows = [
      { status: "running" },
      { status: "queued" },
      { status: "error" },
      { status: "cancelled" },
      { status: "done" },
    ] as never[]
    const counts = countCockpitRowsByStatus(rows)
    expect(counts).toEqual({ running: 1, waiting: 1, failed: 1, finished: 2 })
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(rows.length)
  })
})

describe("buildCockpitRows", () => {
  /** The whole difference from the live monitor. */
  it("KEEPS settled runs — history is most of what the cockpit is for", () => {
    const rows = buildCockpitRows({
      brokerLegs: [],
      executionRuns: [
        execRun({ id: "r-done", sourceId: "a", status: "completed" }),
        execRun({ id: "r-failed", sourceId: "b", status: "failed" }),
      ],
    })
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.status).sort()).toEqual(["done", "error"])
  })

  it("carries allowedActions off the projection so controls are not derived from the kind", () => {
    const [row] = buildCockpitRows({ brokerLegs: [], executionRuns: [execRun()] })
    expect(row.allowedActions).toEqual(["stop", "open_details"])
    expect(row.progressRatio).toBe(0.5)
    expect(row.sourceId).toBe("g1")
  })

  it("drops an untrustworthy progress ratio rather than showing a made-up percentage", () => {
    const run = execRun()
    const [row] = buildCockpitRows({
      brokerLegs: [],
      executionRuns: [
        {
          ...run,
          latestSnapshot: {
            ...run.latestSnapshot!,
            progress: { completed: 2, total: 4, ratio: 0.5, trustworthy: false },
          },
        },
      ],
    })
    expect(row.progressRatio).toBeUndefined()
  })

  it("suppresses a legacy goal once its canonical run exists", () => {
    const rows = buildCockpitRows({
      brokerLegs: [],
      executionRuns: [execRun({ sourceId: "g-legacy" })],
      goals: [goal({ id: "g-legacy" })],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe("journal")
  })

  it("keeps a legacy goal that has no canonical run — and gives it no controls", () => {
    const rows = buildCockpitRows({ brokerLegs: [], executionRuns: [], goals: [goal()] })
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe("legacy")
    expect(rows[0].allowedActions).toBeUndefined()
    expect(rows[0].cancellable).toBe(false)
  })

  it("lets a live broker leg win over the journal row for the same work", () => {
    const rows = buildCockpitRows({
      brokerLegs: [leg({ runId: "execution:goal:g1" })],
      executionRuns: [execRun()],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].source).toBe("broker")
    expect(rows[0].cancellable).toBe(true)
  })

  it("sorts newest-first across sources", () => {
    const rows = buildCockpitRows({
      brokerLegs: [leg({ startedAt: 9_000 })],
      executionRuns: [execRun({ id: "r-old", sourceId: "old", startedAt: 100 })],
      goals: [goal({ id: "g-mid", createdAt: 5_000 })],
    })
    expect(rows.map((r) => r.startedAt)).toEqual([9_000, 5_000, 100])
  })

  it("keeps unscoped rows when a project filter is set", () => {
    const rows = buildCockpitRows({
      brokerLegs: [],
      executionRuns: [
        execRun({ id: "r-mine", sourceId: "mine", projectId: "p1" }),
        execRun({ id: "r-other", sourceId: "other", projectId: "p2" }),
        execRun({ id: "r-global", sourceId: "global" }),
      ],
      projectId: "p1",
    })
    expect(rows.map((r) => r.sourceId).sort()).toEqual(["global", "mine"])
  })
})

describe("filterCockpitRows", () => {
  const rows = buildCockpitRows({
    brokerLegs: [],
    executionRuns: [
      execRun({ id: "r1", sourceId: "a", title: "Ship the release", status: "running" }),
      execRun({ id: "r2", sourceId: "b", title: "Fix the flake", status: "failed" }),
    ],
  })

  it("filters by status group", () => {
    expect(filterCockpitRows(rows, { statusGroup: "failed" })).toHaveLength(1)
  })

  it("filters by kind", () => {
    expect(filterCockpitRows(rows, { kind: "goal" })).toHaveLength(2)
    expect(filterCockpitRows(rows, { kind: "chat" })).toHaveLength(0)
  })

  it("matches the label case-insensitively", () => {
    expect(filterCockpitRows(rows, { query: "FLAKE" })).toHaveLength(1)
    expect(filterCockpitRows(rows, { query: "   " })).toHaveLength(2)
  })
})

describe("buildCockpitFacets", () => {
  // Six runs; two of them belong to a Squad. This is the `/squads` Runs tab's
  // shape, where the chips read "All 6 / Failed 1 / Finished 5" over a list
  // that rendered "No runs match these filters".
  function unified(
    over: Partial<UnifiedExecutionRow> & Pick<UnifiedExecutionRow, "rowId" | "status">
  ): UnifiedExecutionRow {
    return {
      source: "journal",
      nativeId: over.rowId,
      runId: over.rowId,
      kind: "agent-turn",
      label: over.rowId,
      startedAt: 1_000,
      cancellable: false,
      ...over,
    }
  }

  const rows: UnifiedExecutionRow[] = [
    unified({ rowId: "chat-run", status: "running" }),
    unified({ rowId: "chat-failed", status: "error" }),
    unified({ rowId: "goal-one", kind: "goal", status: "done" }),
    unified({ rowId: "goal-two", kind: "goal", status: "done" }),
    unified({ rowId: "squad-build", kind: "team", status: "running", teamId: "team_1" }),
    unified({ rowId: "squad-ship", kind: "team", status: "error", teamId: "team_1" }),
  ]

  /**
   * The whole point. Whatever a chip says, that is how many rows come back
   * when you pick it — under EVERY pinned axis, not just the unpinned ones.
   */
  it("makes every count the size of the result of picking it", () => {
    const pinned: CockpitFilter[] = [
      {},
      { kind: "team" },
      { teamId: "team_1" },
      { kind: "team", teamId: "team_1" },
      { query: "squad-" },
    ]
    for (const base of pinned) {
      const facets = buildCockpitFacets(rows, base)
      expect(facets.statusTotal).toBe(filterCockpitRows(rows, base).length)
      for (const group of COCKPIT_STATUS_GROUPS) {
        const picked = buildCockpitFacets(rows, { ...base, statusGroup: group })
        expect(picked.rows).toHaveLength(facets.statusCounts[group])
      }
      for (const kind of EXECUTION_FILTER_KINDS) {
        const picked = buildCockpitFacets(rows, { ...base, kind })
        expect(picked.rows).toHaveLength(facets.kindCounts[kind])
      }
    }
  })

  /** The reported bug, pinned as a number. */
  it("counts the Squad's universe, not the journal's, under a pinned kind", () => {
    const everything = buildCockpitFacets(rows)
    expect(everything.statusTotal).toBe(6)

    const squadTab = buildCockpitFacets(rows, { kind: "team" })
    expect(squadTab.statusTotal).toBe(2)
    expect(squadTab.rows).toHaveLength(2)
    expect(squadTab.statusCounts).toEqual({ running: 1, waiting: 0, failed: 1, finished: 0 })
  })

  /** No Squads yet: the chips say nothing rather than advertising six runs. */
  it("reads zero everywhere when the pinned scope is empty", () => {
    const facets = buildCockpitFacets(rows, { teamId: "team_missing" })
    expect(facets.rows).toHaveLength(0)
    expect(facets.statusTotal).toBe(0)
    expect(Object.values(facets.statusCounts)).toEqual([0, 0, 0, 0])
  })

  /**
   * The other half of a filter count: it must not collapse to the list either.
   * "Failed 1" has to survive selecting Running, or the chips stop being a way
   * to move between buckets.
   */
  it("keeps the other buckets visible while one is selected", () => {
    const facets = buildCockpitFacets(rows, { kind: "team", statusGroup: "running" })
    expect(facets.rows).toHaveLength(1)
    expect(facets.statusCounts.failed).toBe(1)
    expect(facets.statusTotal).toBe(2)
  })

  /** A kind count is read while a status is selected, so it obeys it too. */
  it("counts kinds under the selected status, not across all of them", () => {
    const facets = buildCockpitFacets(rows, { statusGroup: "failed" })
    expect(facets.kindTotal).toBe(2)
    expect(facets.kindCounts.team).toBe(1)
    expect(facets.kindCounts.chat).toBe(1)
    expect(facets.kindCounts.goal).toBe(0)
  })
})

describe("paging", () => {
  it("reports more only when the source query filled its ceiling", () => {
    expect(cockpitHasMore(COCKPIT_PAGE_SIZE, COCKPIT_PAGE_SIZE)).toBe(true)
    expect(cockpitHasMore(COCKPIT_PAGE_SIZE - 1, COCKPIT_PAGE_SIZE)).toBe(false)
  })
})

describe("legacyAgentRunRow", () => {
  it("maps a paused legacy run to `waiting`, not to a made-up running state", () => {
    const row = legacyAgentRunRow({
      unifiedId: "goal:g1",
      kind: "goal",
      title: "Paused goal",
      status: "paused",
      startedAt: 1,
      isLive: true,
      origin: { tableName: "chatGoals", nativeId: "g1" },
    })
    expect(row.status).toBe("waiting")
    expect(row.source).toBe("legacy")
    expect(row.rowId).toBe("legacy:goal:g1")
  })
})
