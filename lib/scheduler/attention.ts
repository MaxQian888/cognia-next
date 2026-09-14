/**
 * What needs the user (ADR-0179 §3).
 *
 * `ScheduledTask` carries `lastError`, `consecutiveFailures` and the
 * auto-pause outcome; the system scheduler carries pending confirmations; the
 * host target knows when the local schedule is suspended; the policy has a
 * per-source quota; the unified hook reports which source failed to load.
 * None of it reached a pane. This module reads all of it once and answers
 * with one ordered list the overview, the list rows and the detail alerts
 * all render.
 *
 * Pure: every input is passed in, so the same function serves the desktop
 * page, the phone page and a test with a fixed clock.
 */

import type { ScheduledTask } from "@/types/scheduler"
import type { ScheduledItemKind, UnifiedScheduledItem } from "@/types/scheduler/unified"
import type { UnifiedExecutionRun } from "@/types/scheduler/unified-runs"

import { getTaskTypeHostSupport, type TaskTypeHostSupport } from "./host-support"
import type { TaskWriteSource } from "./write-authority"

export type AttentionSeverity = "critical" | "attention" | "info"

export type AttentionKind =
  | "auto-paused"
  | "consecutive-failures"
  | "last-run-failed"
  | "source-failed"
  | "awaiting-confirmation"
  | "host-suspended"
  | "unsupported-type"
  | "quota-near-limit"
  | "running"

export interface AttentionSignal {
  /** Stable React key: `${kind}:${subject}`. */
  id: string
  kind: AttentionKind
  severity: AttentionSeverity
  /** The item this is about, when it is about one. */
  itemUnifiedId?: string
  itemName?: string
  /** The run, for `running` and `last-run-failed`. */
  runUnifiedId?: string
  /** Live processes behind a `running` signal. */
  processCount?: number
  /** Consecutive failures, or tasks owned by the source near its quota. */
  count?: number
  /** The quota the count is measured against. */
  limit?: number
  /** Which source failed to load, or which source is near its quota. */
  sourceKind?: ScheduledItemKind
  writeSource?: TaskWriteSource
  /** The last error message, verbatim from the task. */
  detail?: string
  /** For `unsupported-type`: why the host refuses the type. */
  reason?: TaskTypeHostSupport["reason"]
  /** For `unsupported-type`: the requirements the host lacks, joined. */
  missing?: string
}

export interface AttentionInput {
  items: readonly UnifiedScheduledItem[]
  /** App-scheduler rows keyed by id: where failure state and promotion live. */
  tasksById: ReadonlyMap<string, ScheduledTask>
  /** Recent runs across every kind, newest first is not required. */
  runs: readonly UnifiedExecutionRun[]
  /** Live process count per app task id (`countLiveProcesses`). */
  liveProcessesByTaskId?: ReadonlyMap<string, number>
  /** How many OS confirmations are waiting. */
  pendingConfirmations: number
  /** The local schedule is suspended because a paired host took over. */
  hostSuspended: boolean
  /** Sources whose subscribe stream errored. */
  sourceErrors: Partial<Record<ScheduledItemKind, unknown>>
  /** `maxTasksPerSource` from the permission policy. */
  maxTasksPerSource: number
  /** Injected in tests; production reads the local host. */
  hostSupport?: (type: string) => TaskTypeHostSupport
}

/** Consecutive failures at or above this are worth a row of their own. */
export const CONSECUTIVE_FAILURE_THRESHOLD = 2
/** Quota usage at or above this fraction is announced before it bites. */
export const QUOTA_WARNING_FRACTION = 0.8

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, attention: 1, info: 2 }

/** The app-table kinds, whose rows are `ScheduledTask`s. */
function taskFor(
  item: UnifiedScheduledItem,
  tasksById: ReadonlyMap<string, ScheduledTask>
): ScheduledTask | undefined {
  if (item.kind !== "app" && item.kind !== "plugin" && item.kind !== "connector") return undefined
  return tasksById.get(item.sourceId)
}

/** The newest run per item, whatever order the runs arrived in. */
function latestRunByItem(runs: readonly UnifiedExecutionRun[]): Map<string, UnifiedExecutionRun> {
  const latest = new Map<string, UnifiedExecutionRun>()
  for (const run of runs) {
    const current = latest.get(run.itemUnifiedId)
    if (!current || run.startedAt > current.startedAt) latest.set(run.itemUnifiedId, run)
  }
  return latest
}

/**
 * The one signal an item row shows, or `null`. Ordered by what the user
 * would want to hear first about this item: that it stopped itself, that it
 * keeps failing, that it failed last time, that its host cannot run it, that
 * it is running now.
 */
export function itemAttention(
  item: UnifiedScheduledItem,
  context: {
    task?: ScheduledTask
    latestRun?: UnifiedExecutionRun
    liveProcesses?: number
    hostSupport?: (type: string) => TaskTypeHostSupport
  } = {}
): AttentionSignal | null {
  const { task, latestRun, liveProcesses = 0 } = context
  const hostSupport = context.hostSupport ?? getTaskTypeHostSupport
  const base = { itemUnifiedId: item.unifiedId, itemName: item.name }

  if (task?.lastTerminalReason === "auto-paused" && task.status === "paused") {
    return {
      id: `auto-paused:${item.unifiedId}`,
      kind: "auto-paused",
      severity: "critical",
      ...base,
      count: task.consecutiveFailures,
      detail: task.lastError,
    }
  }
  if ((task?.consecutiveFailures ?? 0) >= CONSECUTIVE_FAILURE_THRESHOLD) {
    return {
      id: `consecutive-failures:${item.unifiedId}`,
      kind: "consecutive-failures",
      severity: "critical",
      ...base,
      count: task?.consecutiveFailures,
      detail: task?.lastError,
    }
  }
  if (latestRun?.status === "running") {
    return {
      id: `running:${item.unifiedId}`,
      kind: "running",
      severity: "info",
      ...base,
      runUnifiedId: latestRun.unifiedId,
      processCount: liveProcesses,
    }
  }
  if (
    latestRun?.status === "failed" ||
    (task && task.lastTerminalReason && task.lastTerminalReason !== "completed" && task.lastError)
  ) {
    return {
      id: `last-run-failed:${item.unifiedId}`,
      kind: "last-run-failed",
      severity: "critical",
      ...base,
      runUnifiedId: latestRun?.status === "failed" ? latestRun.unifiedId : undefined,
      detail: task?.lastError ?? latestRun?.error?.message,
    }
  }
  if (task) {
    const support = hostSupport(task.type)
    if (!support.supported) {
      return {
        id: `unsupported-type:${item.unifiedId}`,
        kind: "unsupported-type",
        severity: "attention",
        ...base,
        reason: support.reason,
        missing: support.missing.join(", "),
      }
    }
  }
  return null
}

/** Severity rank for sorting; lower comes first. `null` sorts last. */
export function attentionRank(signal: AttentionSignal | null): number {
  if (!signal) return SEVERITY_RANK.info + 1
  return SEVERITY_RANK[signal.severity]
}

/**
 * Every signal on the page, most severe first, stable within a severity by
 * item name. Per-item signals come first inside a severity, then the global
 * ones (a failed source, a suspended host, a quota), so the block reads as
 * "these tasks, and also this".
 */
export function deriveAttention(input: AttentionInput): AttentionSignal[] {
  const {
    items,
    tasksById,
    runs,
    liveProcessesByTaskId,
    pendingConfirmations,
    hostSuspended,
    sourceErrors,
    maxTasksPerSource,
    hostSupport,
  } = input
  const latest = latestRunByItem(runs)
  const signals: AttentionSignal[] = []

  for (const item of items) {
    const task = taskFor(item, tasksById)
    const signal = itemAttention(item, {
      task,
      latestRun: latest.get(item.unifiedId),
      liveProcesses: task ? liveProcessesByTaskId?.get(task.id) : undefined,
      hostSupport,
    })
    if (signal) signals.push(signal)
  }

  for (const kind of Object.keys(sourceErrors) as ScheduledItemKind[]) {
    if (sourceErrors[kind] === undefined) continue
    signals.push({
      id: `source-failed:${kind}`,
      kind: "source-failed",
      severity: "critical",
      sourceKind: kind,
      detail: describeError(sourceErrors[kind]),
    })
  }

  if (pendingConfirmations > 0) {
    signals.push({
      id: "awaiting-confirmation",
      kind: "awaiting-confirmation",
      severity: "attention",
      count: pendingConfirmations,
    })
  }

  if (hostSuspended) {
    signals.push({ id: "host-suspended", kind: "host-suspended", severity: "attention" })
  }

  if (maxTasksPerSource > 0) {
    const owned = new Map<TaskWriteSource, number>()
    for (const item of items) {
      const source = item.createdBySource
      if (source === "agent" || source === "plugin") {
        owned.set(source, (owned.get(source) ?? 0) + 1)
      }
    }
    for (const [source, count] of owned) {
      if (count >= maxTasksPerSource * QUOTA_WARNING_FRACTION) {
        signals.push({
          id: `quota-near-limit:${source}`,
          kind: "quota-near-limit",
          severity: "attention",
          writeSource: source,
          count,
          limit: maxTasksPerSource,
        })
      }
    }
  }

  return signals.sort(compareSignals)
}

function compareSignals(a: AttentionSignal, b: AttentionSignal): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (bySeverity !== 0) return bySeverity
  const aGlobal = a.itemUnifiedId === undefined ? 1 : 0
  const bGlobal = b.itemUnifiedId === undefined ? 1 : 0
  if (aGlobal !== bGlobal) return aGlobal - bGlobal
  return (a.itemName ?? a.id).localeCompare(b.itemName ?? b.id)
}

function describeError(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return undefined
}

/** Signals about one item, for its detail alerts. */
export function signalsForItem(signals: readonly AttentionSignal[], unifiedId: string) {
  return signals.filter((signal) => signal.itemUnifiedId === unifiedId)
}
