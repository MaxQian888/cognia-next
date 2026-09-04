/**
 * Unified execution view model.
 *
 * The execution monitor answers one question — "what is running right now?" —
 * across three already-existing sources, with NO new persistence layer:
 *   1. the in-memory {@link ExecutionBroker} legs (every admitted AI turn:
 *      chat + the headless legs funneled through `run-and-capture`, which is
 *      where sub-agent / connector / goal / team work shows up — the
 *      BackgroundTaskRegistry's running sub-agents ARE these legs),
 *   2. the persisted `workflowRuns` table (Dexie liveQuery),
 *   3. the persisted scheduler `executions` table (Dexie liveQuery).
 *
 * This module is the pure merge: given the three source arrays it returns one
 * sorted, normalized row list. The panel feeds it live data; keeping the merge
 * pure makes it trivially testable and free of Dexie/React concerns.
 */

import type { ExecutionLegSnapshot } from "./types"
import type { WorkflowRunRow, RunStatus } from "@/types/workflow/visual"
import type { TaskExecution, TaskExecutionStatus } from "@/types/scheduler"
import type { ExecutionRun, ExecutionRunStatus, RunControlAction } from "@/types/execution/run"

export type UnifiedExecutionStatus =
  "queued" | "running" | "waiting" | "done" | "error" | "cancelled"

/**
 * Where a row came from, in precedence order.
 *
 * `legacy` is the cockpit's only addition: a `chatGoals` / `agentPlans` row
 * that predates the journal bridge. It is last on purpose — a legacy row is
 * suppressed the moment a canonical run for the same source exists.
 */
export type UnifiedExecutionSource = "broker" | "journal" | "workflow" | "scheduled" | "legacy"

export interface UnifiedExecutionRow {
  /** Source-prefixed unique row id (stable React key). */
  rowId: string
  source: UnifiedExecutionSource
  /** Native id within the source (broker leg id / workflow run id / execution id). */
  nativeId: string
  /** Display kind — broker leg kind, `"workflow"`, or the scheduled task type. */
  kind: string
  label: string
  status: UnifiedExecutionStatus
  startedAt: number
  sessionId?: string
  runId?: string
  taskId?: string
  projectId?: string
  /**
   * Queued on the DIRECTORY (a working tree / sandbox already in use) rather
   * than on a permit.
   *
   * A queued leg with no reason reads as "hung", and the two waits look
   * identical without this — but only one of them is something the user can
   * act on, because freeing the tree means finishing or cancelling whatever is
   * in it. The broker's own `slotKey` / `holdsSlot` are deliberately NOT
   * projected here: no surface renders them, and a leg whose tree was free
   * when it arrived carries a `slotKey` while waiting on a permit, so reading
   * one is how the panel started blaming an empty directory.
   */
  waitingForSlot?: boolean
  /** Broker leg id when this row can be cancelled through the broker. */
  legId?: string
  /** True when the panel's cancel affordance should be shown. */
  cancellable: boolean

  // ── Detail fields (journal rows only) ──────────────────────────────────────
  // Optional because three of the four sources have no journal behind them.
  // A consumer that needs them must treat `undefined` as "this row is not
  // canonical", never as a zero value — that distinction is what stops the
  // cockpit offering a control button on a row nothing can control.

  /** Settled timestamp. */
  endedAt?: number
  /** `ExecutionRun.sourceId` — the native id the producing engine knows. */
  sourceId?: string
  /**
   * The control verbs the projection says this run can take RIGHT NOW.
   *
   * Read from `latestSnapshot.allowedActions`, which already encodes the
   * per-kind rules (steer only where a live input lane exists, retry only on a
   * settled retryable kind, and so on). A surface that derives buttons from the
   * kind instead re-implements those rules and drifts from them.
   */
  allowedActions?: readonly RunControlAction[]
  /** Terminal error summary from the projection. */
  error?: string
  /** 0..1 completion ratio, only when the projection calls it trustworthy. */
  progressRatio?: number
  /** Approval this run is currently blocked on. */
  pendingInterruptId?: string
}

export interface BuildMonitorModelInput {
  brokerLegs: ExecutionLegSnapshot[]
  executionRuns?: ExecutionRun[]
  workflowRuns?: WorkflowRunRow[]
  schedulerExecutions?: TaskExecution[]
  /** When set, keep only rows for this project (plus unscoped rows). */
  projectId?: string
}

/** Workflow run statuses that represent live/in-flight work. */
const ACTIVE_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "running",
  "pending",
  "waiting",
  "paused",
])

/** Scheduler execution statuses that represent live/in-flight work. */
const ACTIVE_EXEC_STATUSES: ReadonlySet<TaskExecutionStatus> = new Set(["running", "pending"])

export function mapRunStatus(status: RunStatus): UnifiedExecutionStatus {
  switch (status) {
    case "running":
      return "running"
    case "pending":
      return "queued"
    case "waiting":
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

export function mapExecStatus(status: TaskExecutionStatus): UnifiedExecutionStatus {
  switch (status) {
    case "running":
      return "running"
    case "pending":
      return "queued"
    case "completed":
    case "skipped":
      return "done"
    case "failed":
      return "error"
    case "cancelled":
      return "cancelled"
  }
}

export function mapExecutionStatus(status: ExecutionRunStatus): UnifiedExecutionStatus {
  switch (status) {
    case "queued":
      return "queued"
    case "running":
      return "running"
    case "waiting":
    case "paused":
    case "recovery_required":
      return "waiting"
    case "completed":
      return "done"
    case "failed":
      return "error"
    case "cancelled":
      return "cancelled"
  }
}

function inProject(rowProjectId: string | undefined, filter: string | undefined): boolean {
  if (!filter) return true
  // Unscoped rows are global → always shown; scoped rows must match.
  return rowProjectId == null || rowProjectId === filter
}

/** Journal statuses that mean the run is over. */
export const SETTLED_EXECUTION_RUN_STATUSES: ReadonlySet<ExecutionRunStatus> =
  new Set<ExecutionRunStatus>(["completed", "failed", "cancelled"])

/**
 * True when a live broker leg is already projecting this run.
 *
 * The broker row stays the live/cancellable projection while the durable
 * journal supplies replay and suppresses matching legacy rows — showing both
 * would double-count one piece of work.
 *
 * Two matches, and the difference matters. An explicit id match (`leg.runId`)
 * identifies THIS run and holds whatever its status is. The kind+session match
 * is a heuristic for a leg that has not yet learned its run id, and it is only
 * sound while the run is still live: a session hosts many turns over its life,
 * so applying it to a settled run lets one in-flight leg suppress every
 * finished run that session ever had. The live monitor never noticed because it
 * drops settled runs before asking; the cockpit keeps them on purpose.
 */
export function hasLiveBrokerLeg(
  run: ExecutionRun,
  brokerLegs: readonly ExecutionLegSnapshot[]
): boolean {
  const brokerKind = brokerKindForRun(run)
  const settled = SETTLED_EXECUTION_RUN_STATUSES.has(run.status)
  return brokerLegs.some(
    (leg) =>
      leg.runId === run.id ||
      leg.runId === run.sourceId ||
      (!settled &&
        brokerKind !== undefined &&
        leg.kind === brokerKind &&
        run.sessionId !== undefined &&
        leg.sessionId === run.sessionId)
  )
}

function brokerKindForRun(run: ExecutionRun): ExecutionLegSnapshot["kind"] | undefined {
  if (run.kind === "agent-turn") return "chat"
  if (run.kind === "workflow") return "workflow-step"
  if (run.kind === "goal" || run.kind === "team" || run.kind === "scheduled") return run.kind
  return undefined
}

/**
 * Per-source row mappers.
 *
 * Exported so the cockpit (`cockpit-model.ts`) projects rows the SAME way the
 * live monitor does instead of forking a second normalization that drifts. The
 * two builders differ only in which rows they admit — the monitor keeps live
 * work, the cockpit keeps history too — never in what a row means.
 */

export function brokerLegRow(leg: ExecutionLegSnapshot): UnifiedExecutionRow {
  return {
    rowId: `broker:${leg.id}`,
    source: "broker",
    nativeId: leg.id,
    kind: leg.kind,
    label: leg.label,
    status: leg.cancelled ? "cancelled" : leg.state,
    startedAt: leg.startedAt,
    ...(leg.sessionId ? { sessionId: leg.sessionId } : {}),
    ...(leg.runId ? { runId: leg.runId } : {}),
    ...(leg.taskId ? { taskId: leg.taskId } : {}),
    ...(leg.projectId ? { projectId: leg.projectId } : {}),
    ...(leg.waitingForSlot ? { waitingForSlot: true } : {}),
    legId: leg.id,
    // A leg that has already been cancelled (awaiting its release) is no
    // longer actionable.
    cancellable: !leg.cancelled,
  }
}

/** `${kind}:${sourceId}` — the key a legacy row is deduped against. */
export function journalSourceKey(run: ExecutionRun): string {
  return `${run.kind}:${run.sourceId}`
}

/**
 * Ids of team runs that some OTHER team row already names as its source.
 *
 * Journal rows are deduped against workflow / scheduler / goal / plan rows,
 * never against each other, and for a stretch two paths created a journal row
 * for the same team run under different conventions: `startSquadRun` went
 * through `agentTeamExecutionRunId` (`execution:team:<runId>`, `sourceId:
 * <runId>`), while the durable coordinator used the bare `<runId>` as the id
 * with `sourceId: <teamId>`. Both rendered. The second copy carried no
 * `sessionId`, so its coordination tab said "unavailable" and its gate
 * receipts went nowhere.
 *
 * Both writers now agree, but rows created before that still sit in local
 * databases, so the legacy copy is collapsed on read rather than migrated —
 * a display defect is not worth a schema version. The legacy row is exactly
 * the one whose own `id` is the canonical row's `sourceId`.
 */
export function supersededTeamRunIds(runs: readonly ExecutionRun[]): Set<string> {
  const sourceIds = new Set<string>()
  for (const run of runs) {
    if (run.kind === "team") sourceIds.add(run.sourceId)
  }
  const superseded = new Set<string>()
  for (const run of runs) {
    if (run.kind === "team" && sourceIds.has(run.id)) superseded.add(run.id)
  }
  return superseded
}

export function journalRunRow(run: ExecutionRun): UnifiedExecutionRow {
  const snapshot = run.latestSnapshot
  const ratio = snapshot?.progress.trustworthy ? snapshot.progress.ratio : undefined
  return {
    rowId: `journal:${run.id}`,
    source: "journal",
    nativeId: run.id,
    kind: run.kind,
    label: snapshot?.title || run.title,
    status: mapExecutionStatus(snapshot?.status ?? run.status),
    startedAt: run.startedAt,
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    runId: run.id,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    // The broker owns cancellation for a live leg; a journal row is driven
    // through the control plane instead, which `allowedActions` describes.
    cancellable: false,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    sourceId: run.sourceId,
    ...(snapshot ? { allowedActions: snapshot.allowedActions } : {}),
    ...(snapshot?.error ? { error: snapshot.error } : {}),
    ...(ratio !== undefined ? { progressRatio: ratio } : {}),
    ...(snapshot?.pendingInterrupt ? { pendingInterruptId: snapshot.pendingInterrupt.id } : {}),
  }
}

/** The kind a workflow row is deduped under — a team/cron run is not a workflow. */
export function workflowRunSourceKind(run: WorkflowRunRow): string {
  if (run.triggerKind === "trigger.team") return "team"
  if (run.triggerKind === "trigger.cron") return "scheduled"
  return "workflow"
}

export function workflowRunRow(run: WorkflowRunRow): UnifiedExecutionRow {
  return {
    rowId: `workflow:${run.id}`,
    source: "workflow",
    nativeId: run.id,
    kind: "workflow",
    label: run.title || run.workflowSnapshot?.name || run.workflowId,
    status: mapRunStatus(run.status),
    startedAt: run.startedAt,
    runId: run.id,
    ...(run.projectId ? { projectId: run.projectId } : {}),
    cancellable: false,
  }
}

export function schedulerExecutionRow(exec: TaskExecution): UnifiedExecutionRow {
  return {
    rowId: `scheduled:${exec.id}`,
    source: "scheduled",
    nativeId: exec.id,
    kind: exec.taskType,
    label: exec.taskName,
    status: mapExecStatus(exec.status),
    startedAt: exec.startedAt instanceof Date ? exec.startedAt.getTime() : Number(exec.startedAt),
    taskId: exec.taskId,
    cancellable: false,
  }
}

/** Newest-first, ties broken on the stable row id. */
export function sortExecutionRowsByRecency(rows: UnifiedExecutionRow[]): UnifiedExecutionRow[] {
  return rows.sort((a, b) => b.startedAt - a.startedAt || a.rowId.localeCompare(b.rowId))
}

/**
 * Merge the three live sources into one normalized, project-filtered row list,
 * sorted most-recent-first.
 */
export function buildExecutionMonitorModel(input: BuildMonitorModelInput): UnifiedExecutionRow[] {
  const rows: UnifiedExecutionRow[] = []
  const journalSourceKeys = new Set<string>()

  for (const leg of input.brokerLegs) {
    if (!inProject(leg.projectId, input.projectId)) continue
    rows.push(brokerLegRow(leg))
  }

  const supersededTeamRuns = supersededTeamRunIds(input.executionRuns ?? [])
  for (const run of input.executionRuns ?? []) {
    if (["completed", "failed", "cancelled"].includes(run.status)) continue
    if (!inProject(run.projectId, input.projectId)) continue
    journalSourceKeys.add(journalSourceKey(run))
    if (supersededTeamRuns.has(run.id)) continue
    if (hasLiveBrokerLeg(run, input.brokerLegs)) continue
    rows.push(journalRunRow(run))
  }

  for (const run of input.workflowRuns ?? []) {
    if (journalSourceKeys.has(`${workflowRunSourceKind(run)}:${run.id}`)) continue
    if (!ACTIVE_RUN_STATUSES.has(run.status)) continue
    if (!inProject(run.projectId, input.projectId)) continue
    rows.push(workflowRunRow(run))
  }

  for (const exec of input.schedulerExecutions ?? []) {
    if (journalSourceKeys.has(`scheduled:${exec.id}`)) continue
    if (!ACTIVE_EXEC_STATUSES.has(exec.status)) continue
    rows.push(schedulerExecutionRow(exec))
  }

  return sortExecutionRowsByRecency(rows)
}

/** Count of rows that are actively running (not queued / waiting / settled). */
export function countRunningRows(rows: UnifiedExecutionRow[]): number {
  return rows.reduce((n, r) => (r.status === "running" ? n + 1 : n), 0)
}

/**
 * The stable set of kinds the monitor can filter/group by. Broker legs already
 * carry one of the seven {@link ExecutionLegKind} values; workflow-run rows and
 * scheduler rows are normalized to `"workflow"` / `"scheduled"` so the filter
 * stays stable regardless of a scheduler task's arbitrary `taskType`.
 */
export const EXECUTION_FILTER_KINDS = [
  "chat",
  "subagent",
  "team",
  "goal",
  "connector",
  "workflow",
  "workflow-step",
  "scheduled",
  // Appended, not inserted: `KIND_RANK` in `monitor-prefs.ts` derives the
  // "by kind" sort order from these indices, so inserting would silently
  // reorder every existing user's grouped view.
  //
  // Both are journal-only kinds — no broker leg carries them — and both became
  // reachable here once their bridges started projecting: `delegation` from
  // `delegation-bridge.ts`, `job` from `job-bridge.ts`. Before this they fell
  // through `executionRowFilterKind`'s cast and were counted under a kind that
  // does not exist, which is why neither could be filtered out.
  "delegation",
  "job",
  // Appended for the same reason as the two above: `security-scan` became
  // reachable once `security-scan-bridge.ts` started projecting the Strix
  // plugin's runs.
  "security-scan",
  // Reachable once `bot-run.ts` starts creating runs. A Bot run is a queue
  // entry with a face, so being able to filter it apart from the agent turns
  // it may spawn is the difference between reading the cockpit and scrolling
  // it.
  "bot",
] as const

export type ExecutionFilterKind = (typeof EXECUTION_FILTER_KINDS)[number]

/**
 * Normalize a row to its filterable kind. Workflow-run and scheduler rows carry
 * a display `kind` (`"workflow"` / the raw `taskType`) that isn't stable for
 * filtering, so they are keyed off `source`; broker rows use their leg kind,
 * which is always one of {@link EXECUTION_FILTER_KINDS}.
 */
export function executionRowFilterKind(row: UnifiedExecutionRow): ExecutionFilterKind {
  if (row.source === "workflow") return "workflow"
  if (row.source === "scheduled") return "scheduled"
  // Journal AND legacy rows carry an `ExecutionRunKind`, so both need the same
  // normalization. Keying it off `source === "journal"` alone left a legacy
  // `plan` row reporting a kind that is not in EXECUTION_FILTER_KINDS: it
  // matched no chip, so selecting any kind hid it, and the tally wrote NaN
  // under a key the record was never seeded with.
  if (row.source === "journal" || row.source === "legacy") {
    if (row.kind === "agent-turn") return "chat"
    if (row.kind === "plan") return "workflow"
    return row.kind as ExecutionFilterKind
  }
  return row.kind as ExecutionFilterKind
}

/** Tally live rows by filterable kind — powers the filter chips + their counts. */
export function countExecutionRowsByKind(
  rows: UnifiedExecutionRow[]
): Record<ExecutionFilterKind, number> {
  const counts = Object.fromEntries(EXECUTION_FILTER_KINDS.map((k) => [k, 0])) as Record<
    ExecutionFilterKind,
    number
  >
  for (const row of rows) counts[executionRowFilterKind(row)] += 1
  return counts
}

export interface ElapsedParts {
  hours: number
  minutes: number
  seconds: number
}

/**
 * Split the wall-clock elapsed since `startedAt` into h/m/s parts (clamped at
 * zero for clock skew). Pure so the panel's live timer stays testable; the
 * panel maps the parts to the right i18n form.
 */
export function elapsedPartsFrom(startedAt: number, now: number): ElapsedParts {
  const total = Math.max(0, Math.floor((now - startedAt) / 1000))
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  }
}
