"use client"

/**
 * Live fan-in for the task cockpit.
 *
 * The canonical source is the run journal — `listExecutionRuns()` with no kind
 * filter, so chat turns, workflows, delegations and background jobs are in the
 * list rather than structurally excluded from it. The old shape asked five
 * questions of four private stores and mapped them through `AgentRun`, whose
 * kind union has four members and whose canonical mapper returns `null` for
 * `agent-turn`, `workflow` and `delegation`; between them that is most of what
 * actually runs, so the panel could not show it.
 *
 * The three other sources are still read, each for a specific reason:
 *  - **broker legs** are in-memory and admitted-but-not-yet-journalled, so they
 *    are the only place a just-started turn exists;
 *  - **`workflowRuns` / scheduler executions** cover rows written before their
 *    bridges existed;
 *  - **`chatGoals` / `agentPlans`** likewise, and `buildCockpitRows` suppresses
 *    every one of them the moment a canonical run for the same source appears.
 *
 * Paging raises a ceiling instead of walking an offset. The list reorders on
 * every journal append, so `offset += 50` would skip rows and repeat others;
 * a growing limit cannot.
 */

import { useCallback, useMemo, useState, useSyncExternalStore } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { getDb } from "@/lib/db/schema"
import { listAllGoals } from "@/lib/db/goals"
import { getExecutionRun, listExecutionRuns } from "@/lib/db/execution-runs"
import { schedulerDb } from "@/lib/scheduler/scheduler-db"
import { getExecutionBroker } from "@/lib/execution/broker"
import {
  COCKPIT_PAGE_SIZE,
  buildCockpitRows,
  cockpitHasMore,
  countCockpitRowsByStatus,
  filterCockpitRows,
  type CockpitStatusGroup,
} from "@/lib/execution/cockpit-model"
import {
  countExecutionRowsByKind,
  journalRunRow,
  type ExecutionFilterKind,
  type UnifiedExecutionRow,
} from "@/lib/execution/monitor-model"
import type { ExecutionLegSnapshot } from "@/lib/execution/types"
import type { ExecutionRun } from "@/types/execution/run"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { TaskExecution } from "@/types/scheduler"
import type { Goal } from "@/types/goal"
import type { AgentPlan } from "@/types/agent/plan"

export interface UseExecutionCockpitOptions {
  statusGroup?: CockpitStatusGroup
  kind?: ExecutionFilterKind
  query?: string
  /** Only this Squad's runs. See `CockpitFilter.teamId`. */
  teamId?: string
  projectId?: string
  /** Run id carried by a deep link; fetched independently of the page ceiling. */
  selectedId?: string
}

export interface UseExecutionCockpitResult {
  /** Rows after the status / kind / query filter. */
  rows: UnifiedExecutionRow[]
  /**
   * Rows before filtering.
   *
   * The chip counts are computed from this, not from `rows`: a count derived
   * from the filtered list would read "Failed 0" the moment you selected
   * Running, which is the opposite of what a filter count is for.
   */
  allRows: UnifiedExecutionRow[]
  statusCounts: Record<CockpitStatusGroup, number>
  kindCounts: Record<ExecutionFilterKind, number>
  /** Canonical row for a deep link that is outside the currently loaded page. */
  selectedRow?: UnifiedExecutionRow
  isLoading: boolean
  hasMore: boolean
  loadMore(): void
}

const EMPTY_LEGS: ExecutionLegSnapshot[] = []

interface PersistedSources {
  executionRuns: ExecutionRun[]
  workflowRuns: WorkflowRunRow[]
  schedulerExecutions: TaskExecution[]
  goals: Goal[]
  plans: AgentPlan[]
  selectedRun?: ExecutionRun
  limit: number
}

async function resolveSelectedRun(
  selectedId: string | undefined
): Promise<ExecutionRun | undefined> {
  if (!selectedId) return undefined
  const direct = await getExecutionRun(selectedId)
  if (direct) return direct
  const matches = await getDb().executionRuns.where("sourceId").equals(selectedId).toArray()
  return matches.sort((left, right) => right.updatedAt - left.updatedAt)[0]
}

export function useExecutionCockpit(
  options: UseExecutionCockpitOptions = {}
): UseExecutionCockpitResult {
  const [limit, setLimit] = useState(COCKPIT_PAGE_SIZE)

  const broker = getExecutionBroker()
  const brokerLegs = useSyncExternalStore(
    broker.subscribe,
    broker.getSnapshot,
    // Static export / SSR: no live broker.
    () => EMPTY_LEGS as never
  )

  const persisted = useLiveQuery<PersistedSources>(async () => {
    const [executionRuns, workflowRuns, schedulerExecutions, goals, plans, selectedRun] =
      await Promise.all([
        listExecutionRuns({ limit }),
        getDb().workflowRuns.orderBy("startedAt").reverse().limit(limit).toArray(),
        schedulerDb.getRecentExecutions(limit),
        listAllGoals(limit),
        getDb().agentPlans.orderBy("createdAt").reverse().limit(limit).toArray(),
        resolveSelectedRun(options.selectedId),
      ])
    return {
      executionRuns,
      workflowRuns,
      schedulerExecutions,
      goals,
      plans,
      ...(selectedRun ? { selectedRun } : {}),
      limit,
    }
  }, [limit, options.selectedId])

  const allRows = useMemo(
    () =>
      buildCockpitRows({
        brokerLegs,
        executionRuns: persisted?.executionRuns ?? [],
        workflowRuns: persisted?.workflowRuns ?? [],
        schedulerExecutions: persisted?.schedulerExecutions ?? [],
        goals: persisted?.goals ?? [],
        plans: persisted?.plans ?? [],
        ...(options.projectId ? { projectId: options.projectId } : {}),
      }),
    [brokerLegs, persisted, options.projectId]
  )

  const rows = useMemo(
    () =>
      filterCockpitRows(allRows, {
        ...(options.statusGroup ? { statusGroup: options.statusGroup } : {}),
        ...(options.kind ? { kind: options.kind } : {}),
        ...(options.query ? { query: options.query } : {}),
        ...(options.teamId ? { teamId: options.teamId } : {}),
      }),
    [allRows, options.statusGroup, options.kind, options.query, options.teamId]
  )

  const loadMore = useCallback(() => setLimit((current) => current + COCKPIT_PAGE_SIZE), [])
  const selectedRow = useMemo(
    () => (persisted?.selectedRun ? journalRunRow(persisted.selectedRun) : undefined),
    [persisted]
  )

  /**
   * More is offered when ANY source filled its ceiling. Asking only the journal
   * would strand legacy rows: a user whose goals all predate the bridge has a
   * full `chatGoals` page and an empty journal one.
   */
  const hasMore = useMemo(() => {
    if (!persisted) return false
    const { limit: fetchedAt } = persisted
    return [
      persisted.executionRuns.length,
      persisted.workflowRuns.length,
      persisted.schedulerExecutions.length,
      persisted.goals.length,
      persisted.plans.length,
    ].some((count) => cockpitHasMore(count, fetchedAt))
  }, [persisted])

  return {
    rows,
    allRows,
    statusCounts: useMemo(() => countCockpitRowsByStatus(allRows), [allRows]),
    kindCounts: useMemo(() => countExecutionRowsByKind(allRows), [allRows]),
    ...(selectedRow ? { selectedRow } : {}),
    isLoading: persisted === undefined,
    hasMore,
    loadMore,
  }
}
