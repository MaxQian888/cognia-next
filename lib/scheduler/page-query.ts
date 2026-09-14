/**
 * The scheduler page's address (ADR-0179 §2).
 *
 * Selection lives in the URL so every emitter that means "open this task"
 * lands on it: the job center, the workspace environment list, ⌘K, the
 * composer's schedule suggestion, the OS wake path and a source's own
 * `deepLinkHref`. Two parameters, both `unifiedId`s:
 *
 *   `?item=<kind>:<sourceId>`   the item the detail pane shows
 *   `?run=<kind>:<nativeId>`    the run the sheet shows
 *
 * Three legacy spellings are still emitted and are translated once, then
 * rewritten out of the address bar by the page:
 *
 *   `?taskId=<id>`        app-scheduler row (app / plugin / connector kind)
 *   `?task=<id>`          the same, from the ⌘K scheduled-task provider
 *   `?systemTaskId=<id>`  OS task
 *
 * A legacy id names a *row*, not a kind — an app-table row is `app`, `plugin`
 * or `connector` depending on its type — so translation needs the loaded
 * items and is a separate step from parsing.
 */

import { parseUnifiedId, type UnifiedScheduledItem } from "@/types/scheduler/unified"

export const SCHEDULER_ITEM_PARAM = "item"
export const SCHEDULER_RUN_PARAM = "run"

/** Legacy parameters, in the order they are consulted. */
const LEGACY_APP_TASK_PARAMS = ["taskId", "task"] as const
const LEGACY_SYSTEM_TASK_PARAM = "systemTaskId"

/** The kinds whose rows live in the app scheduler's own table. */
const APP_TABLE_KINDS = new Set(["app", "plugin", "connector"])

export interface SchedulerQuery {
  /** `?item=`, only when it parses as a unified id. */
  item?: string
  /** `?run=`, only when it parses as a unified id. */
  run?: string
  /** A legacy app-table row id still waiting to be resolved. */
  legacyTaskId?: string
  /** A legacy OS task id still waiting to be resolved. */
  legacySystemTaskId?: string
}

/** Read what the address asks for. Malformed ids are dropped, not guessed. */
export function parseSchedulerQuery(params: URLSearchParams): SchedulerQuery {
  const query: SchedulerQuery = {}
  const item = params.get(SCHEDULER_ITEM_PARAM)
  if (item && parseUnifiedId(item)) query.item = item
  const run = params.get(SCHEDULER_RUN_PARAM)
  if (run && parseUnifiedId(run)) query.run = run
  for (const name of LEGACY_APP_TASK_PARAMS) {
    const value = params.get(name)
    if (value) {
      query.legacyTaskId = value
      break
    }
  }
  const system = params.get(LEGACY_SYSTEM_TASK_PARAM)
  if (system) query.legacySystemTaskId = system
  return query
}

/** True when the address still carries a spelling the page rewrites. */
export function hasLegacySchedulerParams(params: URLSearchParams): boolean {
  return (
    LEGACY_APP_TASK_PARAMS.some((name) => params.has(name)) || params.has(LEGACY_SYSTEM_TASK_PARAM)
  )
}

/**
 * Turn a legacy row id into the `unifiedId` of the loaded item it names, or
 * `undefined` when no loaded item matches. An unknown id resolves to nothing
 * rather than to the first row: a broken link must look broken.
 */
export function resolveLegacySelection(
  query: SchedulerQuery,
  items: readonly UnifiedScheduledItem[]
): string | undefined {
  if (query.legacyTaskId) {
    const id = query.legacyTaskId
    const match = items.find((item) => item.sourceId === id && APP_TABLE_KINDS.has(item.kind))
    if (match) return match.unifiedId
  }
  if (query.legacySystemTaskId) {
    const id = query.legacySystemTaskId
    const match = items.find((item) => item.sourceId === id && item.kind === "system")
    if (match) return match.unifiedId
  }
  return undefined
}

export interface SchedulerQueryPatch {
  /** `null` removes the parameter; `undefined` leaves it alone. */
  item?: string | null
  run?: string | null
}

/**
 * The next query string: the current parameters with the patch applied and
 * every legacy spelling removed. Returns `""` when nothing remains, so the
 * caller can build `pathname` or `pathname?query` without a trailing `?`.
 */
export function writeSchedulerQuery(params: URLSearchParams, patch: SchedulerQueryPatch): string {
  const next = new URLSearchParams(params.toString())
  for (const name of LEGACY_APP_TASK_PARAMS) next.delete(name)
  next.delete(LEGACY_SYSTEM_TASK_PARAM)
  if (patch.item !== undefined) {
    if (patch.item === null) next.delete(SCHEDULER_ITEM_PARAM)
    else next.set(SCHEDULER_ITEM_PARAM, patch.item)
  }
  if (patch.run !== undefined) {
    if (patch.run === null) next.delete(SCHEDULER_RUN_PARAM)
    else next.set(SCHEDULER_RUN_PARAM, patch.run)
  }
  return next.toString()
}

/** `pathname` plus the query, with no dangling `?`. */
export function schedulerHref(pathname: string, query: string): string {
  return query ? `${pathname}?${query}` : pathname
}
