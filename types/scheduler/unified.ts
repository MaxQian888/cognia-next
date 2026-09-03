/**
 * Unified scheduled-item types for the cross-source scheduler page.
 *
 * cognia-next persists timed work across six independent backends (the
 * closed `SCHEDULED_ITEM_KINDS` tuple below, ADR-0079 §3):
 *
 *   1. App scheduler    — Dexie `tasks` table  (lib/scheduler/scheduler-db.ts)
 *   2. Workflow runtime — Dexie `workflowTriggers` + Rust cron_daemon
 *   3. Backup scheduler — `appSettings.backupSchedule`
 *   4. Plugin scheduler — `type: "plugin"` rows in SchedulerDB `tasks`
 *   5. System scheduler — OS-level (Windows Task Scheduler / launchd / cron)
 *   6. Connector queue  — `connection:*` rows collapsed into one rollup item
 *
 * Each source keeps its own storage and CRUD path; the scheduler page renders
 * them through this normalized shape. `ScheduledItemSource` is the adapter
 * contract — one per backend — wired together by `SchedulerSourceRegistry`
 * and consumed by the `useUnifiedScheduledItems` hook.
 */

import type { TaskTriggerType } from "@/types/scheduler"

/** Single exhaustive runtime/type authority for every unified scheduler kind. */
export const SCHEDULED_ITEM_KINDS = [
  "app",
  "workflow",
  "backup",
  "plugin",
  "system",
  "connector",
] as const

export type ScheduledItemKind = (typeof SCHEDULED_ITEM_KINDS)[number]

export type UnifiedItemStatus = "active" | "paused" | "disabled" | "expired" | "unknown"

/**
 * Trigger summary normalized across sources. Sources may populate any subset;
 * the UI renders whatever is present (cron expression preferred when known).
 */
export interface UnifiedTriggerSummary {
  type: TaskTriggerType
  cron?: string
  intervalMs?: number
  runAtMs?: number
  eventType?: string
  timezone?: string
}

/**
 * What the UI is allowed to do with this item. Sources that don't support a
 * given action (e.g., OS system tasks may not allow run-now) set that bit to
 * false; the UI hides the corresponding action menu entry.
 */
export interface UnifiedItemCapabilities {
  runNow: boolean
  pause: boolean
  edit: boolean
  delete: boolean
}

/**
 * Where this item came from. `deepLinkHref` is the route the UI navigates to
 * when the user wants to edit/inspect in the source's native UI; sources that
 * want full read-write parity in the scheduler page still expose this so the
 * settings/audit deep-link works.
 */
export interface UnifiedItemOrigin {
  /** Optional human-readable storage location (e.g., `workflowTriggers`). */
  tableName?: string
  /** Route to open the source-native editor for this item. */
  deepLinkHref: string
}

/**
 * Normalized representation of one scheduled item across all five sources.
 * The renderer doesn't know or care which backend produced it.
 */
export interface UnifiedScheduledItem {
  /**
   * Stable, scope-prefixed identifier — `${kind}:${sourceId}`. Use this as
   * the React key; never assume the kind from `sourceId` alone (some sources
   * use UUIDs that look identical across kinds).
   */
  unifiedId: string
  kind: ScheduledItemKind
  /** Source-native row id (Dexie pk, workflow id, etc.). */
  sourceId: string
  name: string
  description?: string
  status: UnifiedItemStatus
  triggerSummary: UnifiedTriggerSummary
  /** Unix epoch ms; undefined when no next run is scheduled. */
  nextRunAt?: number
  /** Unix epoch ms; undefined when never run. */
  lastRunAt?: number
  successCount?: number
  failureCount?: number
  /**
   * Source-native labels carried through so cross-source filters can reason
   * about them (the `/loop` status filter matches the `loop` tag written by
   * `lib/loop/interval.ts`). Sources with no tag concept leave this unset.
   */
  tags?: string[]
  /**
   * Owning workspace, for sources that have one (`app` schedules do; a backup
   * or a system task is machine-wide). Undefined means unattributed rather
   * than foreign — see `taskVisibleInWorkspace`.
   */
  projectId?: string
  /**
   * Who put this on the schedule.
   *
   * Only `app` schedules carry a creator record; a workflow trigger or a
   * system task is machine-wide and leaves this unset. It matters now that an
   * agent can author a schedule of its own: a user who finds an unfamiliar row
   * needs to be able to tell "I set this up and forgot" from "something set
   * this up on my behalf" without opening it.
   */
  createdBySource?: "user" | "agent" | "plugin"
  origin: UnifiedItemOrigin
  capabilities: UnifiedItemCapabilities
}

/**
 * Helper — build a stable `unifiedId`. Centralized so sources can't drift.
 */
export function makeUnifiedId(kind: ScheduledItemKind, sourceId: string): string {
  return `${kind}:${sourceId}`
}

/**
 * Helper — split a `unifiedId` back into its parts. Returns undefined for any
 * malformed input (no colon, empty kind, or unknown kind).
 */
export function parseUnifiedId(
  unifiedId: string
): { kind: ScheduledItemKind; sourceId: string } | undefined {
  const colonIndex = unifiedId.indexOf(":")
  if (colonIndex <= 0 || colonIndex === unifiedId.length - 1) return undefined
  const kind = unifiedId.slice(0, colonIndex) as ScheduledItemKind
  const sourceId = unifiedId.slice(colonIndex + 1)
  if (
    kind !== "app" &&
    kind !== "workflow" &&
    kind !== "backup" &&
    kind !== "plugin" &&
    kind !== "system" &&
    kind !== "connector"
  ) {
    return undefined
  }
  return { kind, sourceId }
}

/**
 * Stable cross-source sort order: active items first, then by nextRunAt
 * ascending (items with no nextRunAt sink to the bottom), then by unifiedId
 * for deterministic ordering across renders.
 */
export function compareUnifiedItems(a: UnifiedScheduledItem, b: UnifiedScheduledItem): number {
  const aActive = a.status === "active" ? 0 : 1
  const bActive = b.status === "active" ? 0 : 1
  if (aActive !== bActive) return aActive - bActive

  const aNext = a.nextRunAt ?? Number.POSITIVE_INFINITY
  const bNext = b.nextRunAt ?? Number.POSITIVE_INFINITY
  if (aNext !== bNext) return aNext - bNext

  return a.unifiedId < b.unifiedId ? -1 : a.unifiedId > b.unifiedId ? 1 : 0
}
