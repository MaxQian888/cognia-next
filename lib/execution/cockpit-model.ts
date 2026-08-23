/**
 * Task-cockpit view model.
 *
 * The live monitor (`monitor-model.ts`) answers ONE question — "what is running
 * right now" — and drops everything settled. The cockpit answers three: what is
 * running, what is stuck, and what failed. That difference is the only reason
 * this module exists; every row it produces is built by the monitor's own
 * mappers, so a row means the same thing in both surfaces.
 *
 * Two additions over the monitor:
 *
 *  1. **Settled runs are kept.** History is most of the cockpit's value — a
 *     failed run the user needs to retry is by definition not live.
 *  2. **Un-bridged legacy sources are adapted in.** `chatGoals` and `agentPlans`
 *     predate the journal. Their bridge (`agent-state-bridge.ts`) projects new
 *     work, but rows written before it existed have no journal history and must
 *     not be backfilled — `appendInsideTransaction` refuses events on a
 *     terminal run by design, and forging them would break the "a settled run's
 *     history is final" invariant. So they are READ through the adapters in
 *     `types/agent-runs/agent-run.ts` and suppressed the moment a canonical run
 *     for the same source exists.
 *
 * A legacy row carries no `allowedActions`. That is load-bearing, not a gap:
 * the cockpit renders control buttons from `allowedActions`, so a row with no
 * journal behind it offers no button instead of a button that cannot work.
 */

import {
  brokerLegRow,
  hasLiveBrokerLeg,
  journalRunRow,
  journalSourceKey,
  schedulerExecutionRow,
  sortExecutionRowsByRecency,
  workflowRunRow,
  workflowRunSourceKind,
  executionRowFilterKind,
  type ExecutionFilterKind,
  type UnifiedExecutionRow,
  type UnifiedExecutionStatus,
} from "./monitor-model"
import {
  toAgentRunFromGoal,
  toAgentRunFromPlan,
  type AgentRun,
  type AgentRunKind,
  type AgentRunStatus,
} from "@/types/agent-runs/agent-run"
import type { ExecutionLegSnapshot } from "./types"
import type { ExecutionRun, ExecutionRunKind } from "@/types/execution/run"
import type { WorkflowRunRow } from "@/types/workflow/visual"
import type { TaskExecution } from "@/types/scheduler"
import type { Goal } from "@/types/goal"
import type { AgentPlan } from "@/types/agent/plan"

/**
 * The four buckets the status filter offers.
 *
 * `finished` — not "completed" — because it holds cancelled runs as well.
 * Labelling that bucket "Completed" would report a run the user stopped as one
 * that succeeded, and the whole point of the cockpit is that a run's outcome is
 * not guessed at. The per-row pill still shows the exact status.
 */
export type CockpitStatusGroup = "running" | "waiting" | "failed" | "finished"

export const COCKPIT_STATUS_GROUPS: readonly CockpitStatusGroup[] = [
  "running",
  "waiting",
  "failed",
  "finished",
] as const

const STATUS_GROUP: Record<UnifiedExecutionStatus, CockpitStatusGroup> = {
  running: "running",
  // Queued work is waiting on a slot, blocked work on a person. Both answer
  // "why is nothing happening", which is the question this bucket exists for.
  queued: "waiting",
  waiting: "waiting",
  error: "failed",
  done: "finished",
  cancelled: "finished",
}

export function cockpitStatusGroup(row: UnifiedExecutionRow): CockpitStatusGroup {
  return STATUS_GROUP[row.status]
}

function unifiedStatusFromAgentRun(status: AgentRunStatus): UnifiedExecutionStatus {
  switch (status) {
    case "running":
      return "running"
    case "paused":
      return "waiting"
    case "succeeded":
      return "done"
    case "failed":
      return "error"
    case "cancelled":
      return "cancelled"
  }
}

const LEGACY_KIND: Record<AgentRunKind, ExecutionRunKind> = {
  goal: "goal",
  plan: "plan",
  team: "team",
  "scheduled-task": "scheduled",
}

/**
 * Project a legacy `AgentRun` onto the shared row shape.
 *
 * `source: "journal"` would be a lie and `cancellable: true` would be a broken
 * button, so it is neither: the row is tagged `legacy` and carries no control
 * verbs at all.
 */
export function legacyAgentRunRow(run: AgentRun): UnifiedExecutionRow {
  return {
    rowId: `legacy:${run.unifiedId}`,
    source: "legacy",
    nativeId: run.origin.nativeId,
    kind: LEGACY_KIND[run.kind],
    label: run.title,
    status: unifiedStatusFromAgentRun(run.status),
    startedAt: run.startedAt,
    ...(run.finishedAt !== undefined ? { endedAt: run.finishedAt } : {}),
    sourceId: run.origin.nativeId,
    cancellable: false,
    ...(run.progress !== undefined ? { progressRatio: run.progress } : {}),
    ...(run.error ? { error: run.error.message } : {}),
  }
}

export interface BuildCockpitRowsInput {
  brokerLegs: readonly ExecutionLegSnapshot[]
  executionRuns?: readonly ExecutionRun[]
  workflowRuns?: readonly WorkflowRunRow[]
  schedulerExecutions?: readonly TaskExecution[]
  /** Un-bridged legacy sources. */
  goals?: readonly Goal[]
  plans?: readonly AgentPlan[]
  /** When set, keep only rows for this project (plus unscoped rows). */
  projectId?: string
}

function inProject(rowProjectId: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true
  return rowProjectId == null || rowProjectId === filter
}

/**
 * Merge every source into one newest-first row list, settled work included.
 *
 * Precedence is strict and one-way: a live broker leg beats the journal row for
 * the same work, and the journal beats a legacy row for the same source. Each
 * step suppresses the one below it, so a single piece of work is never counted
 * twice — which is the failure the `rowId` prefixes alone would not prevent,
 * because the same run has a different id in every source.
 */
export function buildCockpitRows(input: BuildCockpitRowsInput): UnifiedExecutionRow[] {
  const rows: UnifiedExecutionRow[] = []
  const journalSourceKeys = new Set<string>()

  for (const leg of input.brokerLegs) {
    if (!inProject(leg.projectId, input.projectId)) continue
    rows.push(brokerLegRow(leg))
  }

  for (const run of input.executionRuns ?? []) {
    if (!inProject(run.projectId, input.projectId)) continue
    journalSourceKeys.add(journalSourceKey(run))
    if (hasLiveBrokerLeg(run, input.brokerLegs)) continue
    rows.push(journalRunRow(run))
  }

  for (const run of input.workflowRuns ?? []) {
    // A team run lives in `workflowRuns` under a `__team__:` id; its journal
    // row is keyed `team:<runId>`, which `workflowRunSourceKind` already knows.
    if (journalSourceKeys.has(`${workflowRunSourceKind(run)}:${run.id}`)) continue
    if (!inProject(run.projectId, input.projectId)) continue
    rows.push(workflowRunRow(run))
  }

  for (const exec of input.schedulerExecutions ?? []) {
    if (journalSourceKeys.has(`scheduled:${exec.id}`)) continue
    rows.push(schedulerExecutionRow(exec))
  }

  for (const goal of input.goals ?? []) {
    if (journalSourceKeys.has(`goal:${goal.id}`)) continue
    if (!inProject(goal.projectId, input.projectId)) continue
    rows.push(legacyAgentRunRow(toAgentRunFromGoal(goal)))
  }

  for (const plan of input.plans ?? []) {
    if (journalSourceKeys.has(`plan:${plan.id}`)) continue
    rows.push(legacyAgentRunRow(toAgentRunFromPlan(plan)))
  }

  return sortExecutionRowsByRecency(rows)
}

/**
 * The i18n label key for a row's kind, from a CLOSED set.
 *
 * Not `row.kind` directly: a scheduler row carries `TaskExecution.taskType`,
 * which is an arbitrary product string (`backup`, `agent-team`, whatever a task
 * declares). Interpolating that into a translation key renders the raw enum to
 * the user for every type nobody happened to add a key for — a hard-coded
 * string that no lint catches, because the key is dynamic.
 *
 * So the mapping is explicit and total: known kinds get their key, a scheduler
 * row is labelled by its source, and anything else is `other` rather than
 * leaking an internal identifier.
 */
const KIND_LABEL_KEYS: Record<string, string> = {
  "agent-turn": "agentTurn",
  chat: "chat",
  connector: "connector",
  delegation: "delegation",
  goal: "goal",
  job: "job",
  plan: "plan",
  scheduled: "scheduled",
  "security-scan": "securityScan",
  subagent: "subagent",
  team: "team",
  workflow: "workflow",
  "workflow-step": "workflowStep",
}

/** Every key {@link runKindLabelKey} and {@link filterKindLabelKey} can return. */
export const RUN_KIND_LABEL_KEYS: readonly string[] = Object.freeze([
  ...new Set(Object.values(KIND_LABEL_KEYS)),
  "other",
])

export function runKindLabelKey(row: UnifiedExecutionRow): string {
  if (row.source === "scheduled") return "scheduled"
  return KIND_LABEL_KEYS[row.kind] ?? "other"
}

/** Same mapping for the filter chips, whose input is already a closed set. */
export function filterKindLabelKey(kind: ExecutionFilterKind): string {
  return KIND_LABEL_KEYS[kind] ?? "other"
}

export interface CockpitFilter {
  /** `undefined` = every status. */
  statusGroup?: CockpitStatusGroup
  /** `undefined` = every kind. */
  kind?: ExecutionFilterKind
  /** Case-insensitive substring over the row label. */
  query?: string
}

export function filterCockpitRows(
  rows: readonly UnifiedExecutionRow[],
  filter: CockpitFilter
): UnifiedExecutionRow[] {
  const query = filter.query?.trim().toLowerCase()
  return rows.filter((row) => {
    if (filter.statusGroup && cockpitStatusGroup(row) !== filter.statusGroup) return false
    if (filter.kind && executionRowFilterKind(row) !== filter.kind) return false
    if (query && !row.label.toLowerCase().includes(query)) return false
    return true
  })
}

export function countCockpitRowsByStatus(
  rows: readonly UnifiedExecutionRow[]
): Record<CockpitStatusGroup, number> {
  const counts: Record<CockpitStatusGroup, number> = {
    running: 0,
    waiting: 0,
    failed: 0,
    finished: 0,
  }
  for (const row of rows) counts[cockpitStatusGroup(row)] += 1
  return counts
}

/**
 * One page of rows.
 *
 * The list is live-queried with a growing limit rather than offset-paged: an
 * offset into a list that reorders on every journal append would skip rows and
 * repeat others. `loadMore` raises the ceiling; nothing is ever skipped.
 */
export const COCKPIT_PAGE_SIZE = 50

/** True when the source query returned a full page and may be hiding more. */
export function cockpitHasMore(fetched: number, limit: number): boolean {
  return fetched >= limit
}
