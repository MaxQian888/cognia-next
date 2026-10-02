/**
 * Incident persistence: row mapping, bounded reads and the guarded write
 * statements every incident change (manual or automated) is built from.
 *
 * Every change is one D1 batch: a compare-and-swap UPDATE (or a conditional
 * INSERT for a new incident) that stamps a fresh `write_token`, followed by
 * statements that only take effect while that token is present. A zero-row
 * CAS therefore appends no update, no event and no operation record.
 */

import {
  DAY_MS,
  INCIDENT_PAGE_LIMIT,
  STATUS_SCHEMA_VERSION,
  type ComponentId,
  type IncidentDetail,
  type IncidentImpact,
  type IncidentPage,
  type IncidentState,
  type IncidentSummary,
  type IncidentUpdateView,
  type LocalizedText,
  type UpdateSource,
} from "../../../../../lib/status/contract"
import { toIso } from "../../../../../lib/status/derive"
import { base64UrlToBytes, bytesToBase64Url } from "../../../../../lib/status/signing"
import type { WriteGuard } from "../admin/mutation"
import {
  guardedEventStatement,
  incidentEventId,
  type IncidentEventPayload,
} from "../notifications/events"
import { newWriteToken, parseJsonColumn, randomId } from "./ids"

export interface IncidentRow {
  id: string
  title_json: string
  state: IncidentState
  impact: IncidentImpact
  component_ids_json: string
  source: UpdateSource
  fingerprint: string | null
  pinned: number
  manual_owner: string | null
  started_at: number
  resolved_at: number | null
  updated_at: number
  revision: number
  predecessor_id: string | null
  write_token: string
}

export interface IncidentUpdateRow {
  id: string
  incident_id: string
  seq: number
  state: IncidentState
  impact: IncidentImpact
  component_ids_json: string
  message_json: string
  source: UpdateSource
  at: number
  evidence_at: number | null
  correction_of: string | null
}

/** Updates returned per incident detail; an incident never needs more. */
export const MAX_UPDATES_PER_INCIDENT = 500
/** Past incidents in the snapshot. */
export const SNAPSHOT_PAST_LIMIT = 20
export const SNAPSHOT_PAST_WINDOW_MS = 90 * DAY_MS
/** Active incidents in the snapshot (a sane upper bound, never reached in practice). */
export const SNAPSHOT_ACTIVE_LIMIT = 50
export const DEFAULT_PAGE_LIMIT = 20

const INCIDENT_COLUMNS = `id, title_json, state, impact, component_ids_json, source, fingerprint, pinned,
  manual_owner, started_at, resolved_at, updated_at, revision, predecessor_id, write_token`
const UPDATE_COLUMNS = `id, incident_id, seq, state, impact, component_ids_json, message_json, source,
  at, evidence_at, correction_of`

export function toUpdateView(row: IncidentUpdateRow): IncidentUpdateView {
  return {
    id: row.id,
    state: row.state,
    impact: row.impact,
    componentIds: parseJsonColumn<ComponentId[]>(
      row.component_ids_json,
      "incident_updates.component_ids_json"
    ),
    message: parseJsonColumn<LocalizedText>(row.message_json, "incident_updates.message_json"),
    source: row.source,
    at: toIso(row.at),
    correctionOf: row.correction_of,
  }
}

export function toSummary(row: IncidentRow, latest: IncidentUpdateRow | null): IncidentSummary {
  return {
    id: row.id,
    title: parseJsonColumn<LocalizedText>(row.title_json, "incidents.title_json"),
    state: row.state,
    impact: row.impact,
    componentIds: parseJsonColumn<ComponentId[]>(
      row.component_ids_json,
      "incidents.component_ids_json"
    ),
    source: row.source,
    startedAt: toIso(row.started_at),
    resolvedAt: row.resolved_at === null ? null : toIso(row.resolved_at),
    updatedAt: toIso(row.updated_at),
    revision: row.revision,
    predecessorId: row.predecessor_id,
    latestUpdate: latest ? toUpdateView(latest) : null,
  }
}

export async function readIncidentRow(db: D1Database, id: string): Promise<IncidentRow | null> {
  return db
    .prepare(`SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE id = ?`)
    .bind(id)
    .first<IncidentRow>()
}

export async function readOpenIncidentByFingerprint(
  db: D1Database,
  fingerprint: string
): Promise<IncidentRow | null> {
  return db
    .prepare(
      `SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE fingerprint = ? AND resolved_at IS NULL`
    )
    .bind(fingerprint)
    .first<IncidentRow>()
}

export async function readUpdates(
  db: D1Database,
  incidentId: string
): Promise<IncidentUpdateRow[]> {
  const result = await db
    .prepare(
      `SELECT ${UPDATE_COLUMNS} FROM incident_updates WHERE incident_id = ? ORDER BY seq ASC LIMIT ?`
    )
    .bind(incidentId, MAX_UPDATES_PER_INCIDENT)
    .all<IncidentUpdateRow>()
  return result.results
}

/** Latest update per incident for a bounded set of incidents. */
export async function readLatestUpdates(
  db: D1Database,
  incidentIds: readonly string[]
): Promise<Map<string, IncidentUpdateRow>> {
  const latest = new Map<string, IncidentUpdateRow>()
  if (incidentIds.length === 0) return latest
  const placeholders = incidentIds.map(() => "?").join(", ")
  const result = await db
    .prepare(
      `SELECT ${UPDATE_COLUMNS.split(",")
        .map((column) => `u.${column.trim()}`)
        .join(", ")}
       FROM incident_updates u
       JOIN (SELECT incident_id, MAX(seq) AS seq FROM incident_updates
             WHERE incident_id IN (${placeholders}) GROUP BY incident_id) m
         ON m.incident_id = u.incident_id AND m.seq = u.seq`
    )
    .bind(...incidentIds)
    .all<IncidentUpdateRow>()
  for (const row of result.results) latest.set(row.incident_id, row)
  return latest
}

export function toDetail(row: IncidentRow, updates: readonly IncidentUpdateRow[]): IncidentDetail {
  return {
    ...toSummary(row, updates.length > 0 ? updates[updates.length - 1] : null),
    updates: updates.map(toUpdateView),
  }
}

export async function loadIncidentDetail(
  db: D1Database,
  id: string
): Promise<IncidentDetail | null> {
  const row = await readIncidentRow(db, id)
  if (!row) return null
  return toDetail(row, await readUpdates(db, id))
}

async function summarize(db: D1Database, rows: IncidentRow[]): Promise<IncidentSummary[]> {
  const latest = await readLatestUpdates(
    db,
    rows.map((row) => row.id)
  )
  return rows.map((row) => toSummary(row, latest.get(row.id) ?? null))
}

// ---------------------------------------------------------------------------
// Pagination: newest `started_at` first, `id` descending as the tie-breaker.
// ---------------------------------------------------------------------------

export interface PageCursor {
  startedAt: number
  id: string
}

export function encodeCursor(cursor: PageCursor): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify([cursor.startedAt, cursor.id])))
}

export function decodeCursor(value: string): PageCursor | null {
  if (value.length === 0 || value.length > 256) return null
  const bytes = base64UrlToBytes(value)
  if (!bytes) return null
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes)
    )
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      Number.isSafeInteger(parsed[0]) &&
      typeof parsed[1] === "string" &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(parsed[1])
    ) {
      return { startedAt: parsed[0] as number, id: parsed[1] }
    }
  } catch {
    return null
  }
  return null
}

/** Parse `limit` and `cursor` query parameters; null when invalid. */
export function parsePageQuery(url: URL): { limit: number; cursor: PageCursor | null } | null {
  const rawLimit = url.searchParams.get("limit")
  let limit = DEFAULT_PAGE_LIMIT
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d{1,3}$/.test(rawLimit)) return null
    limit = Number(rawLimit)
    if (limit < 1 || limit > INCIDENT_PAGE_LIMIT) return null
  }
  const rawCursor = url.searchParams.get("cursor")
  if (rawCursor === null || rawCursor === "") return { limit, cursor: null }
  const cursor = decodeCursor(rawCursor)
  return cursor ? { limit, cursor } : null
}

export async function listIncidentRows(
  db: D1Database,
  query: { limit: number; cursor: PageCursor | null }
): Promise<{ rows: IncidentRow[]; nextCursor: string | null }> {
  const fetchLimit = query.limit + 1
  const result = query.cursor
    ? await db
        .prepare(
          `SELECT ${INCIDENT_COLUMNS} FROM incidents
           WHERE started_at < ? OR (started_at = ? AND id < ?)
           ORDER BY started_at DESC, id DESC LIMIT ?`
        )
        .bind(query.cursor.startedAt, query.cursor.startedAt, query.cursor.id, fetchLimit)
        .all<IncidentRow>()
    : await db
        .prepare(
          `SELECT ${INCIDENT_COLUMNS} FROM incidents ORDER BY started_at DESC, id DESC LIMIT ?`
        )
        .bind(fetchLimit)
        .all<IncidentRow>()
  const rows = result.results.slice(0, query.limit)
  const last = rows[rows.length - 1]
  const nextCursor =
    result.results.length > query.limit && last
      ? encodeCursor({ startedAt: last.started_at, id: last.id })
      : null
  return { rows, nextCursor }
}

export async function listIncidentPage(
  db: D1Database,
  query: { limit: number; cursor: PageCursor | null }
): Promise<{ page: IncidentPage; rows: IncidentRow[] }> {
  const { rows, nextCursor } = await listIncidentRows(db, query)
  return {
    page: {
      schemaVersion: STATUS_SCHEMA_VERSION,
      incidents: await summarize(db, rows),
      nextCursor,
    },
    rows,
  }
}

export async function loadSnapshotIncidents(
  db: D1Database,
  nowMs: number
): Promise<{ active: IncidentSummary[]; past: IncidentSummary[] }> {
  const active = await db
    .prepare(
      `SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE resolved_at IS NULL
       ORDER BY started_at DESC, id DESC LIMIT ?`
    )
    .bind(SNAPSHOT_ACTIVE_LIMIT)
    .all<IncidentRow>()
  const past = await db
    .prepare(
      `SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE resolved_at IS NOT NULL AND resolved_at >= ?
       ORDER BY resolved_at DESC, id DESC LIMIT ?`
    )
    .bind(nowMs - SNAPSHOT_PAST_WINDOW_MS, SNAPSHOT_PAST_LIMIT)
    .all<IncidentRow>()
  return { active: await summarize(db, active.results), past: await summarize(db, past.results) }
}

// ---------------------------------------------------------------------------
// Guarded writes
// ---------------------------------------------------------------------------

function tokenGuard(incidentId: string, writeToken: string): WriteGuard {
  return {
    sql: "EXISTS (SELECT 1 FROM incidents WHERE id = ? AND write_token = ?)",
    params: [incidentId, writeToken],
  }
}

export interface NewUpdate {
  message: LocalizedText
  source: UpdateSource
  atMs: number
  evidenceAtMs: number | null
  correctionOf: string | null
}

function guardedUpdateInsert(
  db: D1Database,
  input: {
    updateId: string
    incidentId: string
    state: IncidentState
    impact: IncidentImpact
    componentIds: ComponentId[]
    update: NewUpdate
  },
  guard: WriteGuard
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO incident_updates (${UPDATE_COLUMNS})
       SELECT ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM incident_updates WHERE incident_id = ?),
              ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${guard.sql}`
    )
    .bind(
      input.updateId,
      input.incidentId,
      input.incidentId,
      input.state,
      input.impact,
      JSON.stringify(input.componentIds),
      JSON.stringify(input.update.message),
      input.update.source,
      input.update.atMs,
      input.update.evidenceAtMs,
      input.update.correctionOf,
      ...guard.params
    )
}

export interface CreateIncidentInput {
  title: LocalizedText
  state: Exclude<IncidentState, "resolved">
  impact: IncidentImpact
  componentIds: ComponentId[]
  source: UpdateSource
  /** Automated: the component ID; at most one open incident per fingerprint. */
  fingerprint: string | null
  pinned: boolean
  manualOwner: string | null
  predecessorId: string | null
  update: NewUpdate
  /** Extra predicate for the INSERT (the job lease for automated writes). */
  extraGuard?: WriteGuard
}

export interface PlannedIncidentWrite {
  statements: D1PreparedStatement[]
  guard: WriteGuard
  incidentId: string
  updateId: string
  /** The incident exactly as it will read after a successful commit. */
  predicted: IncidentDetail
}

/** A new incident, its first update and its notification event. */
export function planCreateIncident(
  db: D1Database,
  input: CreateIncidentInput
): PlannedIncidentWrite {
  const incidentId = randomId("inc")
  const updateId = randomId("upd")
  const writeToken = newWriteToken()
  const atMs = input.update.atMs
  const conditions: string[] = []
  const params: unknown[] = []
  if (input.fingerprint !== null) {
    conditions.push(
      "NOT EXISTS (SELECT 1 FROM incidents WHERE fingerprint = ? AND resolved_at IS NULL)"
    )
    params.push(input.fingerprint)
  }
  if (input.extraGuard) {
    conditions.push(input.extraGuard.sql)
    params.push(...input.extraGuard.params)
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""
  const insert = db
    .prepare(
      `INSERT INTO incidents (${INCIDENT_COLUMNS})
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ? ${where}`
    )
    .bind(
      incidentId,
      JSON.stringify(input.title),
      input.state,
      input.impact,
      JSON.stringify(input.componentIds),
      input.source,
      input.fingerprint,
      input.pinned ? 1 : 0,
      input.manualOwner,
      atMs,
      atMs,
      input.predecessorId,
      writeToken,
      ...params
    )
  const guard = tokenGuard(incidentId, writeToken)
  const payload: IncidentEventPayload = {
    type: "incident",
    phase: "opened",
    incidentId,
    updateId,
    title: input.title,
    message: input.update.message,
    state: input.state,
    impact: input.impact,
    componentIds: input.componentIds,
    atMs,
  }
  const statements = [
    insert,
    guardedUpdateInsert(
      db,
      {
        updateId,
        incidentId,
        state: input.state,
        impact: input.impact,
        componentIds: input.componentIds,
        update: input.update,
      },
      guard
    ),
    guardedEventStatement(db, { id: incidentEventId(updateId), payload, createdAtMs: atMs }, guard),
  ]
  const updateView: IncidentUpdateView = {
    id: updateId,
    state: input.state,
    impact: input.impact,
    componentIds: input.componentIds,
    message: input.update.message,
    source: input.update.source,
    at: toIso(atMs),
    correctionOf: null,
  }
  const predicted: IncidentDetail = {
    id: incidentId,
    title: input.title,
    state: input.state,
    impact: input.impact,
    componentIds: input.componentIds,
    source: input.source,
    startedAt: toIso(atMs),
    resolvedAt: null,
    updatedAt: toIso(atMs),
    revision: 1,
    predecessorId: input.predecessorId,
    latestUpdate: updateView,
    updates: [updateView],
  }
  return { statements, guard, incidentId, updateId, predicted }
}

export interface TransitionInput {
  current: IncidentRow
  currentUpdates: readonly IncidentUpdateRow[]
  expectedRevision: number
  state: IncidentState
  impact: IncidentImpact
  componentIds: ComponentId[]
  pinned: boolean
  manualOwner: string | null
  update: NewUpdate
  /** Whether the update notifies subscribers (corrections do not). */
  notify: boolean
  /** Automation: refuse pinned / manual incidents inside the CAS itself. */
  automationOnly: boolean
  extraGuard?: WriteGuard
}

/**
 * Append one update and move the incident to its next state, conditional on
 * the expected revision (and, for automation, on it being unpinned).
 */
export function planIncidentTransition(
  db: D1Database,
  input: TransitionInput
): PlannedIncidentWrite {
  const incidentId = input.current.id
  const updateId = randomId("upd")
  const writeToken = newWriteToken()
  const atMs = input.update.atMs
  const resolvedAtMs = input.state === "resolved" ? (input.current.resolved_at ?? atMs) : null
  const conditions = ["id = ?", "revision = ?"]
  const params: unknown[] = [incidentId, input.expectedRevision]
  if (input.automationOnly)
    conditions.push("pinned = 0", "source = 'automated'", "resolved_at IS NULL")
  if (input.extraGuard) {
    conditions.push(input.extraGuard.sql)
    params.push(...input.extraGuard.params)
  }
  const cas = db
    .prepare(
      `UPDATE incidents SET state = ?, impact = ?, component_ids_json = ?, pinned = ?, manual_owner = ?,
         resolved_at = ?, updated_at = ?, revision = revision + 1, write_token = ?
       WHERE ${conditions.join(" AND ")}`
    )
    .bind(
      input.state,
      input.impact,
      JSON.stringify(input.componentIds),
      input.pinned ? 1 : 0,
      input.manualOwner,
      resolvedAtMs,
      atMs,
      writeToken,
      ...params
    )
  const guard = tokenGuard(incidentId, writeToken)
  const statements = [
    cas,
    guardedUpdateInsert(
      db,
      {
        updateId,
        incidentId,
        state: input.state,
        impact: input.impact,
        componentIds: input.componentIds,
        update: input.update,
      },
      guard
    ),
  ]
  const title = parseJsonColumn<LocalizedText>(input.current.title_json, "incidents.title_json")
  if (input.notify) {
    const payload: IncidentEventPayload = {
      type: "incident",
      // A note appended to an already-resolved incident is an update, not a
      // second resolution.
      phase:
        input.state === "resolved" && input.current.state !== "resolved" ? "resolved" : "updated",
      incidentId,
      updateId,
      title,
      message: input.update.message,
      state: input.state,
      impact: input.impact,
      componentIds: input.componentIds,
      atMs,
    }
    statements.push(
      guardedEventStatement(
        db,
        { id: incidentEventId(updateId), payload, createdAtMs: atMs },
        guard
      )
    )
  }
  const nextRow: IncidentRow = {
    ...input.current,
    state: input.state,
    impact: input.impact,
    component_ids_json: JSON.stringify(input.componentIds),
    pinned: input.pinned ? 1 : 0,
    manual_owner: input.manualOwner,
    resolved_at: resolvedAtMs,
    updated_at: atMs,
    revision: input.expectedRevision + 1,
    write_token: writeToken,
  }
  const lastSeq = input.currentUpdates.reduce((max, row) => Math.max(max, row.seq), 0)
  const appended: IncidentUpdateRow = {
    id: updateId,
    incident_id: incidentId,
    seq: lastSeq + 1,
    state: input.state,
    impact: input.impact,
    component_ids_json: JSON.stringify(input.componentIds),
    message_json: JSON.stringify(input.update.message),
    source: input.update.source,
    at: atMs,
    evidence_at: input.update.evidenceAtMs,
    correction_of: input.update.correctionOf,
  }
  return {
    statements,
    guard,
    incidentId,
    updateId,
    predicted: toDetail(nextRow, [...input.currentUpdates, appended]),
  }
}

/** The CAS (first statement) changed exactly one row. */
export function committed(results: readonly D1Result[]): boolean {
  return (results[0]?.meta.changes ?? 0) === 1
}
