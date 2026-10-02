/**
 * Operator maintenance writes: schedule, extend, reschedule, complete and
 * cancel. Each returns a mutation plan executed by the admin router.
 *
 * Lifecycle (plan §9): `scheduled → in_progress → completed`, or
 * `scheduled → cancelled`. When the planned end passes without completion
 * the window waits in `awaiting_confirmation` (see `./lifecycle.ts`);
 * completing it records the actual end separately from the planned one.
 *
 * Validation:
 * - windows are minute-aligned (the parser enforces it) and start no earlier
 *   than the current minute when scheduled or rescheduled;
 * - `extend` moves only the end, in any lifecycle state before completion;
 *   an end that lands in the past is an audited past edit;
 * - `reschedule` moves start and end, only before the window started;
 * - every change that alters which already-elapsed minutes are excluded
 *   marks those minutes dirty (old and new ranges) after it commits, so
 *   rollups are rebuilt under a new aggregate revision; raw observations are
 *   never touched.
 */

import {
  DAY_MS,
  STATUS_SCHEMA_VERSION,
  type MaintenanceChangeRequest,
  type MaintenanceScheduleRequest,
  type MaintenanceState,
} from "../../../../../lib/status/contract"
import type { MinuteWindow } from "../../../../../lib/status/derive"
import { markMinuteRangeDirtyStatements } from "../aggregate/dirty"
import {
  planError,
  type MutationPlan,
  type OperatorContext,
  type PlanError,
} from "../admin/mutation"
import {
  changedPastMinutes,
  exclusionWindow,
  floorMinuteMs,
  planScheduleWindow,
  planWindowChange,
  readMaintenanceRow,
  readMaintenanceUpdates,
  rowFacts,
  type MaintenanceRow,
  type WindowFacts,
} from "./store"

/** Longest window an operator may publish. */
export const MAX_WINDOW_MS = 30 * DAY_MS
/** Furthest ahead a window may start. */
export const MAX_SCHEDULE_AHEAD_MS = 400 * DAY_MS

export type MaintenanceAction = "extend" | "reschedule" | "complete" | "cancel"

function windowValid(startsAtMs: number, endsAtMs: number): boolean {
  return endsAtMs > startsAtMs && endsAtMs - startsAtMs <= MAX_WINDOW_MS
}

async function explainLostRace(db: D1Database, id: string): Promise<PlanError> {
  const row = await readMaintenanceRow(db, id)
  return row ? planError("revision_conflict", row.revision) : planError("not_found")
}

/** Rebuild marks for elapsed minutes whose exclusion changed, committed with the edit. */
function dirtyStatements(db: D1Database, ranges: MinuteWindow[]): D1PreparedStatement[] {
  return ranges.flatMap((range) =>
    markMinuteRangeDirtyStatements(db, range.startMinute, range.endMinute)
  )
}

export async function planMaintenanceSchedule(
  db: D1Database,
  request: MaintenanceScheduleRequest,
  operator: OperatorContext
): Promise<MutationPlan> {
  const startsAtMs = Date.parse(request.startsAt)
  const endsAtMs = Date.parse(request.endsAt)
  if (startsAtMs < floorMinuteMs(operator.nowMs)) return planError("bad_request")
  if (startsAtMs > operator.nowMs + MAX_SCHEDULE_AHEAD_MS) return planError("bad_request")
  if (!windowValid(startsAtMs, endsAtMs)) return planError("bad_request")
  const plan = planScheduleWindow(db, {
    title: request.title,
    description: request.description,
    componentIds: request.componentIds,
    startsAtMs,
    endsAtMs,
    exclude: request.excludeFromAvailability,
    atMs: operator.nowMs,
  })
  // A window starting in the current minute already covers a started slot.
  const dirty = changedPastMinutes(
    null,
    exclusionWindow({
      state: "scheduled",
      startsAtMs,
      endsAtMs,
      actualEndAtMs: null,
      exclude: request.excludeFromAvailability,
    }),
    operator.nowMs
  )
  return {
    kind: "write",
    statements: plan.statements,
    guard: plan.guard,
    result: {
      status: 201,
      body: { schemaVersion: STATUS_SCHEMA_VERSION, maintenance: plan.predicted },
    },
    audit: {
      action: "maintenance.schedule",
      targetType: "maintenance",
      targetId: plan.maintenanceId,
      revision: 1,
      detail: {
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        componentIds: request.componentIds,
        excludeFromAvailability: request.excludeFromAvailability,
      },
    },
    onLostRace: async () => planError("conflict"),
    trailingStatements: dirtyStatements(db, dirty),
  }
}

interface NextWindow {
  state: MaintenanceState
  startsAtMs: number
  endsAtMs: number
  actualEndAtMs: number | null
  kind: "extended" | "rescheduled" | "completed" | "cancelled"
  phase: "changed" | "ended"
  endKind: "completed" | "cancelled" | null
  requireState: MaintenanceState[]
}

function nextWindow(
  action: MaintenanceAction,
  row: MaintenanceRow,
  request: MaintenanceChangeRequest,
  nowMs: number
): NextWindow | PlanError {
  const nowMinuteMs = floorMinuteMs(nowMs)
  switch (action) {
    case "extend": {
      if (!["scheduled", "in_progress", "awaiting_confirmation"].includes(row.state)) {
        return planError("conflict", row.revision)
      }
      if (request.endsAt === undefined) return planError("bad_request")
      if (request.startsAt !== undefined && Date.parse(request.startsAt) !== row.starts_at) {
        return planError("bad_request")
      }
      const endsAtMs = Date.parse(request.endsAt)
      if (!windowValid(row.starts_at, endsAtMs)) return planError("bad_request")
      let state: MaintenanceState = row.state
      if (row.state === "awaiting_confirmation" && endsAtMs > nowMs) state = "in_progress"
      if (row.state === "in_progress" && endsAtMs <= nowMs) state = "awaiting_confirmation"
      return {
        state,
        startsAtMs: row.starts_at,
        endsAtMs,
        actualEndAtMs: null,
        kind: "extended",
        phase: "changed",
        endKind: null,
        requireState: [row.state],
      }
    }
    case "reschedule": {
      if (row.state !== "scheduled" || row.starts_at <= nowMs)
        return planError("conflict", row.revision)
      if (request.startsAt === undefined || request.endsAt === undefined)
        return planError("bad_request")
      const startsAtMs = Date.parse(request.startsAt)
      const endsAtMs = Date.parse(request.endsAt)
      if (startsAtMs < nowMinuteMs || startsAtMs > nowMs + MAX_SCHEDULE_AHEAD_MS)
        return planError("bad_request")
      if (!windowValid(startsAtMs, endsAtMs)) return planError("bad_request")
      return {
        state: "scheduled",
        startsAtMs,
        endsAtMs,
        actualEndAtMs: null,
        kind: "rescheduled",
        phase: "changed",
        endKind: null,
        requireState: ["scheduled"],
      }
    }
    case "complete": {
      if (row.state !== "in_progress" && row.state !== "awaiting_confirmation") {
        return planError("conflict", row.revision)
      }
      if (request.startsAt !== undefined || request.endsAt !== undefined)
        return planError("bad_request")
      return {
        state: "completed",
        startsAtMs: row.starts_at,
        endsAtMs: row.ends_at,
        actualEndAtMs: nowMs,
        kind: "completed",
        phase: "ended",
        endKind: "completed",
        requireState: [row.state],
      }
    }
    case "cancel": {
      // Only before the work starts; a started window is completed instead,
      // so its history is never silently erased.
      if (row.state !== "scheduled" || row.starts_at <= nowMs)
        return planError("conflict", row.revision)
      if (request.startsAt !== undefined || request.endsAt !== undefined)
        return planError("bad_request")
      return {
        state: "cancelled",
        startsAtMs: row.starts_at,
        endsAtMs: row.ends_at,
        actualEndAtMs: null,
        kind: "cancelled",
        phase: "ended",
        endKind: "cancelled",
        requireState: ["scheduled"],
      }
    }
  }
}

export async function planMaintenanceChange(
  db: D1Database,
  maintenanceId: string,
  action: MaintenanceAction,
  request: MaintenanceChangeRequest,
  operator: OperatorContext
): Promise<MutationPlan> {
  const row = await readMaintenanceRow(db, maintenanceId)
  if (!row) return planError("not_found")
  if (row.revision !== request.expectedRevision) return planError("revision_conflict", row.revision)
  const next = nextWindow(action, row, request, operator.nowMs)
  if (next.kind === "error") return next
  const change = next

  const before = exclusionWindow(rowFacts(row))
  const afterFacts: WindowFacts = {
    state: change.state,
    startsAtMs: change.startsAtMs,
    endsAtMs: change.endsAtMs,
    actualEndAtMs: change.actualEndAtMs,
    exclude: row.exclude_from_availability === 1,
  }
  const dirty = changedPastMinutes(before, exclusionWindow(afterFacts), operator.nowMs)

  const plan = planWindowChange(db, {
    current: row,
    currentUpdates: await readMaintenanceUpdates(db, maintenanceId),
    expectedRevision: request.expectedRevision,
    state: change.state,
    startsAtMs: change.startsAtMs,
    endsAtMs: change.endsAtMs,
    actualEndAtMs: change.actualEndAtMs,
    kind: change.kind,
    message: request.message ?? null,
    atMs: operator.nowMs,
    event: { phase: change.phase, endKind: change.endKind },
    requireState: change.requireState,
  })
  return {
    kind: "write",
    statements: plan.statements,
    guard: plan.guard,
    result: {
      status: 200,
      body: { schemaVersion: STATUS_SCHEMA_VERSION, maintenance: plan.predicted },
    },
    audit: {
      action: `maintenance.${action}`,
      targetType: "maintenance",
      targetId: maintenanceId,
      revision: request.expectedRevision + 1,
      detail: {
        previousState: row.state,
        state: change.state,
        previousStartsAt: new Date(row.starts_at).toISOString(),
        previousEndsAt: new Date(row.ends_at).toISOString(),
        startsAt: new Date(change.startsAtMs).toISOString(),
        endsAt: new Date(change.endsAtMs).toISOString(),
        actualEndAt:
          change.actualEndAtMs === null ? null : new Date(change.actualEndAtMs).toISOString(),
        // A change to exclusions of minutes that already elapsed: rollups
        // covering them are rebuilt.
        pastEdit: dirty.length > 0,
        rebuiltMinuteRanges: dirty.map((range) => [range.startMinute, range.endMinute]),
      },
    },
    onLostRace: () => explainLostRace(db, maintenanceId),
    trailingStatements: dirtyStatements(db, dirty),
  }
}
