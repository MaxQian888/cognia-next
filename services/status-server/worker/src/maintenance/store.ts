/**
 * Maintenance persistence: row mapping, exclusion-window math and the
 * guarded write statements every lifecycle change is built from.
 *
 * Exclusion semantics (plan §5/§9): a window excludes the minutes of its
 * components in `[startsAt, effectiveEnd)` when `excludeFromAvailability`
 * is set and it was not cancelled. The effective end is the planned end,
 * or the operator-confirmed actual end when the work finished early. A
 * window left `awaiting_confirmation` excludes only up to its planned end:
 * the clock passing is not evidence the work succeeded.
 */

import {
  DAY_MS,
  MINUTE_MS,
  type ComponentId,
  type LocalizedText,
  type MaintenanceState,
  type MaintenanceUpdateKind,
  type MaintenanceUpdateView,
  type MaintenanceView,
} from "../../../../../lib/status/contract"
import type { MinuteWindow } from "../../../../../lib/status/derive"
import { toIso } from "../../../../../lib/status/derive"
import type { WriteGuard } from "../admin/mutation"
import { newWriteToken, parseJsonColumn, randomId } from "../incidents/ids"
import {
  guardedEventStatement,
  maintenanceEventId,
  type MaintenanceEventPayload,
} from "../notifications/events"

export interface MaintenanceRow {
  id: string
  title_json: string
  description_json: string
  component_ids_json: string
  state: MaintenanceState
  starts_at: number
  ends_at: number
  actual_end_at: number | null
  exclude_from_availability: number
  created_at: number
  updated_at: number
  revision: number
  write_token: string
}

export interface MaintenanceUpdateRow {
  id: string
  maintenance_id: string
  seq: number
  kind: MaintenanceUpdateKind
  message_json: string | null
  at: number
  revision: number
}

/** Finished windows stay visible in the snapshot for this long. */
export const RECENT_FINISHED_MS = 7 * DAY_MS
export const SNAPSHOT_MAINTENANCE_LIMIT = 50
export const MAX_UPDATES_PER_WINDOW = 100
/** Upper bound on windows read for one exclusion query. */
export const MAX_EXCLUSION_ROWS = 2_000

const COLUMNS = `id, title_json, description_json, component_ids_json, state, starts_at, ends_at,
  actual_end_at, exclude_from_availability, created_at, updated_at, revision, write_token`
const UPDATE_COLUMNS = "id, maintenance_id, seq, kind, message_json, at, revision"

export function ceilMinuteMs(ms: number): number {
  return Math.ceil(ms / MINUTE_MS) * MINUTE_MS
}

export function floorMinuteMs(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS
}

export interface WindowFacts {
  state: MaintenanceState
  startsAtMs: number
  endsAtMs: number
  actualEndAtMs: number | null
  exclude: boolean
}

export function rowFacts(row: MaintenanceRow): WindowFacts {
  return {
    state: row.state,
    startsAtMs: row.starts_at,
    endsAtMs: row.ends_at,
    actualEndAtMs: row.actual_end_at,
    exclude: row.exclude_from_availability === 1,
  }
}

/** The excluded minute range of a window, or null when it excludes nothing. */
export function exclusionWindow(facts: WindowFacts): MinuteWindow | null {
  if (!facts.exclude || facts.state === "cancelled") return null
  let endMs = facts.endsAtMs
  if (facts.state === "completed" && facts.actualEndAtMs !== null) {
    endMs = Math.min(endMs, ceilMinuteMs(facts.actualEndAtMs))
  }
  if (endMs <= facts.startsAtMs) return null
  return { startMinute: facts.startsAtMs / MINUTE_MS, endMinute: endMs / MINUTE_MS }
}

/**
 * Minutes whose exclusion differs between two versions of a window, clipped
 * to minutes that have already started (`< nowMinute + 1`): only those can
 * have rollups that must be rebuilt. Future minutes are aggregated later
 * with the windows as they stand then.
 */
export function changedPastMinutes(
  before: MinuteWindow | null,
  after: MinuteWindow | null,
  nowMs: number
): MinuteWindow[] {
  const ranges: MinuteWindow[] = []
  if (before && after) {
    if (before.startMinute !== after.startMinute) {
      ranges.push({
        startMinute: Math.min(before.startMinute, after.startMinute),
        endMinute: Math.max(before.startMinute, after.startMinute),
      })
    }
    if (before.endMinute !== after.endMinute) {
      ranges.push({
        startMinute: Math.min(before.endMinute, after.endMinute),
        endMinute: Math.max(before.endMinute, after.endMinute),
      })
    }
  } else if (before) {
    ranges.push(before)
  } else if (after) {
    ranges.push(after)
  }
  const limit = Math.floor(nowMs / MINUTE_MS) + 1
  return ranges
    .map((range) => ({
      startMinute: range.startMinute,
      endMinute: Math.min(range.endMinute, limit),
    }))
    .filter((range) => range.endMinute > range.startMinute)
}

export function toUpdateView(row: MaintenanceUpdateRow): MaintenanceUpdateView {
  return {
    id: row.id,
    kind: row.kind,
    message:
      row.message_json === null
        ? null
        : parseJsonColumn<LocalizedText>(row.message_json, "maintenance_updates.message_json"),
    at: toIso(row.at),
  }
}

export function toView(
  row: MaintenanceRow,
  updates: readonly MaintenanceUpdateRow[]
): MaintenanceView {
  return {
    id: row.id,
    title: parseJsonColumn<LocalizedText>(row.title_json, "maintenance.title_json"),
    description: parseJsonColumn<LocalizedText>(
      row.description_json,
      "maintenance.description_json"
    ),
    componentIds: parseJsonColumn<ComponentId[]>(
      row.component_ids_json,
      "maintenance.component_ids_json"
    ),
    state: row.state,
    startsAt: toIso(row.starts_at),
    endsAt: toIso(row.ends_at),
    actualEndAt: row.actual_end_at === null ? null : toIso(row.actual_end_at),
    excludeFromAvailability: row.exclude_from_availability === 1,
    revision: row.revision,
    updates: updates.map(toUpdateView),
  }
}

export async function readMaintenanceRow(
  db: D1Database,
  id: string
): Promise<MaintenanceRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} FROM maintenance WHERE id = ?`)
    .bind(id)
    .first<MaintenanceRow>()
}

export async function readMaintenanceUpdates(
  db: D1Database,
  id: string
): Promise<MaintenanceUpdateRow[]> {
  const result = await db
    .prepare(
      `SELECT ${UPDATE_COLUMNS} FROM maintenance_updates WHERE maintenance_id = ? ORDER BY seq ASC LIMIT ?`
    )
    .bind(id, MAX_UPDATES_PER_WINDOW)
    .all<MaintenanceUpdateRow>()
  return result.results
}

/** Updates for a bounded set of windows, grouped and oldest first. */
export async function readUpdatesFor(
  db: D1Database,
  ids: readonly string[]
): Promise<Map<string, MaintenanceUpdateRow[]>> {
  const grouped = new Map<string, MaintenanceUpdateRow[]>()
  if (ids.length === 0) return grouped
  const result = await db
    .prepare(
      `SELECT ${UPDATE_COLUMNS} FROM maintenance_updates WHERE maintenance_id IN (${ids.map(() => "?").join(", ")})
       ORDER BY maintenance_id, seq ASC`
    )
    .bind(...ids)
    .all<MaintenanceUpdateRow>()
  for (const row of result.results) {
    const list = grouped.get(row.maintenance_id) ?? []
    if (list.length < MAX_UPDATES_PER_WINDOW) list.push(row)
    grouped.set(row.maintenance_id, list)
  }
  return grouped
}

export async function viewsFor(
  db: D1Database,
  rows: readonly MaintenanceRow[]
): Promise<MaintenanceView[]> {
  const updates = await readUpdatesFor(
    db,
    rows.map((row) => row.id)
  )
  return rows.map((row) => toView(row, updates.get(row.id) ?? []))
}

export async function loadSnapshotMaintenance(
  db: D1Database,
  nowMs: number
): Promise<MaintenanceView[]> {
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM maintenance
       WHERE state IN ('scheduled', 'in_progress', 'awaiting_confirmation')
          OR (state IN ('completed', 'cancelled') AND updated_at >= ?)
       ORDER BY starts_at ASC, id ASC LIMIT ?`
    )
    .bind(nowMs - RECENT_FINISHED_MS, SNAPSHOT_MAINTENANCE_LIMIT)
    .all<MaintenanceRow>()
  return viewsFor(db, result.results)
}

export function emptyComponentWindows(): Record<ComponentId, MinuteWindow[]> {
  return { signalingHttp: [], signalingAuth: [], relayData: [] }
}

export async function loadComponentExclusions(
  db: D1Database,
  fromMs: number,
  toMs: number
): Promise<Record<ComponentId, MinuteWindow[]>> {
  const windows = emptyComponentWindows()
  if (toMs <= fromMs) return windows
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM maintenance
       WHERE exclude_from_availability = 1 AND state != 'cancelled' AND starts_at < ? AND ends_at > ?
       ORDER BY starts_at ASC LIMIT ?`
    )
    .bind(toMs, fromMs, MAX_EXCLUSION_ROWS)
    .all<MaintenanceRow>()
  for (const row of result.results) {
    const window = exclusionWindow(rowFacts(row))
    if (!window) continue
    if (window.endMinute * MINUTE_MS <= fromMs || window.startMinute * MINUTE_MS >= toMs) continue
    for (const componentId of parseJsonColumn<ComponentId[]>(
      row.component_ids_json,
      "maintenance.component_ids_json"
    )) {
      windows[componentId]?.push({ ...window })
    }
  }
  return windows
}

export async function loadActiveComponents(
  db: D1Database,
  nowMs: number
): Promise<Set<ComponentId>> {
  const result = await db
    .prepare(
      `SELECT component_ids_json FROM maintenance
       WHERE state IN ('scheduled', 'in_progress') AND starts_at <= ? AND ends_at > ?
       LIMIT 100`
    )
    .bind(nowMs, nowMs)
    .all<{ component_ids_json: string }>()
  const active = new Set<ComponentId>()
  for (const row of result.results) {
    for (const id of parseJsonColumn<ComponentId[]>(
      row.component_ids_json,
      "maintenance.component_ids_json"
    )) {
      active.add(id)
    }
  }
  return active
}

// ---------------------------------------------------------------------------
// Guarded writes
// ---------------------------------------------------------------------------

function tokenGuard(id: string, writeToken: string): WriteGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM maintenance WHERE id = ? AND write_token = ?)",
    params: [id, writeToken],
  }
}

function guardedUpdateInsert(
  db: D1Database,
  input: {
    updateId: string
    maintenanceId: string
    kind: MaintenanceUpdateKind
    message: LocalizedText | null
    atMs: number
    revision: number
  },
  guard: WriteGuard
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO maintenance_updates (${UPDATE_COLUMNS})
       SELECT ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM maintenance_updates WHERE maintenance_id = ?), ?, ?, ?, ?
       WHERE ${guard.sql}`
    )
    .bind(
      input.updateId,
      input.maintenanceId,
      input.maintenanceId,
      input.kind,
      input.message === null ? null : JSON.stringify(input.message),
      input.atMs,
      input.revision,
      ...guard.params
    )
}

export interface PlannedMaintenanceWrite {
  statements: D1PreparedStatement[]
  guard: WriteGuard
  maintenanceId: string
  updateId: string
  predicted: MaintenanceView
}

export interface ScheduleInput {
  title: LocalizedText
  description: LocalizedText
  componentIds: ComponentId[]
  startsAtMs: number
  endsAtMs: number
  exclude: boolean
  atMs: number
}

export function planScheduleWindow(db: D1Database, input: ScheduleInput): PlannedMaintenanceWrite {
  const maintenanceId = randomId("mnt")
  const updateId = randomId("mup")
  const writeToken = newWriteToken()
  const insert = db
    .prepare(
      `INSERT INTO maintenance (${COLUMNS}) VALUES (?, ?, ?, ?, 'scheduled', ?, ?, NULL, ?, ?, ?, 1, ?)`
    )
    .bind(
      maintenanceId,
      JSON.stringify(input.title),
      JSON.stringify(input.description),
      JSON.stringify(input.componentIds),
      input.startsAtMs,
      input.endsAtMs,
      input.exclude ? 1 : 0,
      input.atMs,
      input.atMs,
      writeToken
    )
  const guard = tokenGuard(maintenanceId, writeToken)
  const payload: MaintenanceEventPayload = {
    type: "maintenance",
    phase: "scheduled",
    endKind: null,
    maintenanceId,
    title: input.title,
    description: input.description,
    message: null,
    componentIds: input.componentIds,
    startsAtMs: input.startsAtMs,
    endsAtMs: input.endsAtMs,
    actualEndAtMs: null,
    revision: 1,
    atMs: input.atMs,
  }
  const row: MaintenanceRow = {
    id: maintenanceId,
    title_json: JSON.stringify(input.title),
    description_json: JSON.stringify(input.description),
    component_ids_json: JSON.stringify(input.componentIds),
    state: "scheduled",
    starts_at: input.startsAtMs,
    ends_at: input.endsAtMs,
    actual_end_at: null,
    exclude_from_availability: input.exclude ? 1 : 0,
    created_at: input.atMs,
    updated_at: input.atMs,
    revision: 1,
    write_token: writeToken,
  }
  const update: MaintenanceUpdateRow = {
    id: updateId,
    maintenance_id: maintenanceId,
    seq: 1,
    kind: "scheduled",
    message_json: null,
    at: input.atMs,
    revision: 1,
  }
  return {
    statements: [
      insert,
      guardedUpdateInsert(
        db,
        {
          updateId,
          maintenanceId,
          kind: "scheduled",
          message: null,
          atMs: input.atMs,
          revision: 1,
        },
        guard
      ),
      guardedEventStatement(
        db,
        { id: maintenanceEventId(maintenanceId, "scheduled", 1), payload, createdAtMs: input.atMs },
        guard
      ),
    ],
    guard,
    maintenanceId,
    updateId,
    predicted: toView(row, [update]),
  }
}

export interface ChangeInput {
  current: MaintenanceRow
  currentUpdates: readonly MaintenanceUpdateRow[]
  expectedRevision: number
  state: MaintenanceState
  startsAtMs: number
  endsAtMs: number
  actualEndAtMs: number | null
  kind: MaintenanceUpdateKind
  message: LocalizedText | null
  atMs: number
  /** Subscriber notice for this change, if any. */
  event: {
    phase: MaintenanceEventPayload["phase"]
    endKind: MaintenanceEventPayload["endKind"]
  } | null
  /** The state the CAS requires besides the revision (lifecycle races). */
  requireState?: MaintenanceState[]
  extraGuard?: WriteGuard
}

export function planWindowChange(db: D1Database, input: ChangeInput): PlannedMaintenanceWrite {
  const maintenanceId = input.current.id
  const updateId = randomId("mup")
  const writeToken = newWriteToken()
  const revision = input.expectedRevision + 1
  const conditions = ["id = ?", "revision = ?"]
  const params: unknown[] = [maintenanceId, input.expectedRevision]
  if (input.requireState && input.requireState.length > 0) {
    conditions.push(`state IN (${input.requireState.map(() => "?").join(", ")})`)
    params.push(...input.requireState)
  }
  if (input.extraGuard) {
    conditions.push(input.extraGuard.sql)
    params.push(...input.extraGuard.params)
  }
  const cas = db
    .prepare(
      `UPDATE maintenance SET state = ?, starts_at = ?, ends_at = ?, actual_end_at = ?, updated_at = ?,
         revision = revision + 1, write_token = ?
       WHERE ${conditions.join(" AND ")}`
    )
    .bind(
      input.state,
      input.startsAtMs,
      input.endsAtMs,
      input.actualEndAtMs,
      input.atMs,
      writeToken,
      ...params
    )
  const guard = tokenGuard(maintenanceId, writeToken)
  const statements = [
    cas,
    guardedUpdateInsert(
      db,
      {
        updateId,
        maintenanceId,
        kind: input.kind,
        message: input.message,
        atMs: input.atMs,
        revision,
      },
      guard
    ),
  ]
  if (input.event) {
    const payload: MaintenanceEventPayload = {
      type: "maintenance",
      phase: input.event.phase,
      endKind: input.event.endKind,
      maintenanceId,
      title: parseJsonColumn<LocalizedText>(input.current.title_json, "maintenance.title_json"),
      description: parseJsonColumn<LocalizedText>(
        input.current.description_json,
        "maintenance.description_json"
      ),
      message: input.message,
      componentIds: parseJsonColumn<ComponentId[]>(
        input.current.component_ids_json,
        "maintenance.component_ids_json"
      ),
      startsAtMs: input.startsAtMs,
      endsAtMs: input.endsAtMs,
      actualEndAtMs: input.actualEndAtMs,
      revision,
      atMs: input.atMs,
    }
    statements.push(
      guardedEventStatement(
        db,
        {
          id: maintenanceEventId(maintenanceId, input.event.phase, revision),
          payload,
          createdAtMs: input.atMs,
        },
        guard
      )
    )
  }
  const nextRow: MaintenanceRow = {
    ...input.current,
    state: input.state,
    starts_at: input.startsAtMs,
    ends_at: input.endsAtMs,
    actual_end_at: input.actualEndAtMs,
    updated_at: input.atMs,
    revision,
    write_token: writeToken,
  }
  const lastSeq = input.currentUpdates.reduce((max, row) => Math.max(max, row.seq), 0)
  const appended: MaintenanceUpdateRow = {
    id: updateId,
    maintenance_id: maintenanceId,
    seq: lastSeq + 1,
    kind: input.kind,
    message_json: input.message === null ? null : JSON.stringify(input.message),
    at: input.atMs,
    revision,
  }
  return {
    statements,
    guard,
    maintenanceId,
    updateId,
    predicted: toView(nextRow, [...input.currentUpdates, appended]),
  }
}

export async function listMaintenanceRows(
  db: D1Database,
  query: { limit: number; cursor: { startedAt: number; id: string } | null }
): Promise<{ rows: MaintenanceRow[]; hasMore: boolean }> {
  const fetchLimit = query.limit + 1
  const result = query.cursor
    ? await db
        .prepare(
          `SELECT ${COLUMNS} FROM maintenance WHERE starts_at < ? OR (starts_at = ? AND id < ?)
           ORDER BY starts_at DESC, id DESC LIMIT ?`
        )
        .bind(query.cursor.startedAt, query.cursor.startedAt, query.cursor.id, fetchLimit)
        .all<MaintenanceRow>()
    : await db
        .prepare(`SELECT ${COLUMNS} FROM maintenance ORDER BY starts_at DESC, id DESC LIMIT ?`)
        .bind(fetchLimit)
        .all<MaintenanceRow>()
  return {
    rows: result.results.slice(0, query.limit),
    hasMore: result.results.length > query.limit,
  }
}

/** Windows due for a time-driven transition (bounded). */
export async function readDueWindows(
  db: D1Database,
  state: "scheduled" | "in_progress",
  nowMs: number,
  limit: number
): Promise<MaintenanceRow[]> {
  const column = state === "scheduled" ? "starts_at" : "ends_at"
  const result = await db
    .prepare(
      `SELECT ${COLUMNS} FROM maintenance WHERE state = ? AND ${column} <= ? ORDER BY ${column} ASC LIMIT ?`
    )
    .bind(state, nowMs, limit)
    .all<MaintenanceRow>()
  return result.results
}
