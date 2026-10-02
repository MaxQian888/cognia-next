/**
 * Operator incident writes: create, update (with pin and correction) and
 * resolve. Each returns a mutation plan; the admin router adds the guarded
 * idempotency record and audit row to the same batch and runs it.
 *
 * Rules:
 * - every change names `expectedRevision`; a stale one is a 409 carrying the
 *   safe current revision;
 * - a resolved incident is never reopened: a recurrence is a new incident;
 *   notes and corrections may still be appended to it;
 * - resolution goes through `resolve`, which requires an audited reason, so
 *   `state: "resolved"` on a plain update is refused;
 * - a correction appends a record that points at the corrected update; the
 *   original stays in the append-only history and the audit names it.
 *   Corrections do not notify subscribers (they fix wording, they are not a
 *   new development);
 * - `pin: true` takes manual ownership so automation stops changing the
 *   incident; `pin: false` hands an automated incident back.
 */

import {
  STATUS_SCHEMA_VERSION,
  type ComponentId,
  type IncidentCreateRequest,
  type IncidentDetail,
  type IncidentResolveRequest,
  type IncidentUpdateRequest,
} from "../../../../../lib/status/contract"
import {
  planError,
  type MutationPlan,
  type OperatorContext,
  type PlanError,
} from "../admin/mutation"
import { parseJsonColumn } from "./ids"
import {
  listIncidentRows,
  planCreateIncident,
  planIncidentTransition,
  readIncidentRow,
  readLatestUpdates,
  readUpdates,
  toDetail,
  toSummary,
  type PageCursor,
} from "./store"

export interface AdminIncidentDetail extends IncidentDetail {
  pinned: boolean
  manualOwner: string | null
}

function sameIds(left: readonly ComponentId[], right: readonly ComponentId[]): boolean {
  return left.length === right.length && [...left].sort().join(",") === [...right].sort().join(",")
}

async function explainLostRace(db: D1Database, id: string): Promise<PlanError> {
  const row = await readIncidentRow(db, id)
  return row ? planError("revision_conflict", row.revision) : planError("not_found")
}

export async function planIncidentCreate(
  db: D1Database,
  request: IncidentCreateRequest,
  operator: OperatorContext
): Promise<MutationPlan> {
  const plan = planCreateIncident(db, {
    title: request.title,
    state: request.state,
    impact: request.impact,
    componentIds: request.componentIds,
    source: "manual",
    fingerprint: null,
    pinned: true,
    manualOwner: operator.actor,
    predecessorId: null,
    update: {
      message: request.message,
      source: "manual",
      atMs: operator.nowMs,
      evidenceAtMs: null,
      correctionOf: null,
    },
  })
  return {
    kind: "write",
    statements: plan.statements,
    guard: plan.guard,
    result: {
      status: 201,
      body: { schemaVersion: STATUS_SCHEMA_VERSION, incident: plan.predicted },
    },
    audit: {
      action: "incident.create",
      targetType: "incident",
      targetId: plan.incidentId,
      revision: 1,
      detail: { state: request.state, impact: request.impact, componentIds: request.componentIds },
    },
    // A manual create has no competing condition; only an ID collision
    // (practically impossible) can make it a zero-row insert.
    onLostRace: async () => planError("conflict"),
  }
}

export async function planIncidentUpdate(
  db: D1Database,
  incidentId: string,
  request: IncidentUpdateRequest,
  operator: OperatorContext
): Promise<MutationPlan> {
  const row = await readIncidentRow(db, incidentId)
  if (!row) return planError("not_found")
  if (row.revision !== request.expectedRevision) return planError("revision_conflict", row.revision)
  if (request.state === "resolved") return planError("bad_request")
  if (row.state === "resolved" && request.state !== undefined)
    return planError("conflict", row.revision)

  const updates = await readUpdates(db, incidentId)
  const currentIds = parseJsonColumn<ComponentId[]>(
    row.component_ids_json,
    "incidents.component_ids_json"
  )
  const state = request.state ?? row.state
  const impact = request.impact ?? row.impact
  const componentIds = request.componentIds ?? currentIds

  if (request.correctionOf !== undefined) {
    if (!updates.some((update) => update.id === request.correctionOf))
      return planError("bad_request")
    // A correction fixes wording only; a change of state/impact/scope is a
    // new update in its own right.
    if (state !== row.state || impact !== row.impact || !sameIds(componentIds, currentIds)) {
      return planError("bad_request")
    }
  }

  const pinned = request.pin ?? row.pinned === 1
  const manualOwner =
    request.pin === true ? operator.actor : request.pin === false ? null : row.manual_owner
  if (request.pin === false && row.source === "manual") {
    // Manual incidents have no automation to hand back to.
    return planError("bad_request")
  }

  const plan = planIncidentTransition(db, {
    current: row,
    currentUpdates: updates,
    expectedRevision: request.expectedRevision,
    state,
    impact,
    componentIds,
    pinned,
    manualOwner,
    update: {
      message: request.message,
      source: "manual",
      atMs: operator.nowMs,
      evidenceAtMs: null,
      correctionOf: request.correctionOf ?? null,
    },
    notify: request.correctionOf === undefined,
    automationOnly: false,
  })
  return {
    kind: "write",
    statements: plan.statements,
    guard: plan.guard,
    result: {
      status: 200,
      body: { schemaVersion: STATUS_SCHEMA_VERSION, incident: plan.predicted },
    },
    audit: {
      action: request.correctionOf !== undefined ? "incident.correct" : "incident.update",
      targetType: "incident",
      targetId: incidentId,
      revision: request.expectedRevision + 1,
      detail: {
        updateId: plan.updateId,
        previousState: row.state,
        state,
        previousImpact: row.impact,
        impact,
        componentIds,
        pin: request.pin ?? null,
        correctedUpdateId: request.correctionOf ?? null,
      },
    },
    onLostRace: () => explainLostRace(db, incidentId),
  }
}

export async function planIncidentResolve(
  db: D1Database,
  incidentId: string,
  request: IncidentResolveRequest,
  operator: OperatorContext
): Promise<MutationPlan> {
  const row = await readIncidentRow(db, incidentId)
  if (!row) return planError("not_found")
  if (row.revision !== request.expectedRevision) return planError("revision_conflict", row.revision)
  if (row.state === "resolved") return planError("conflict", row.revision)
  const plan = planIncidentTransition(db, {
    current: row,
    currentUpdates: await readUpdates(db, incidentId),
    expectedRevision: request.expectedRevision,
    state: "resolved",
    impact: row.impact,
    componentIds: parseJsonColumn<ComponentId[]>(
      row.component_ids_json,
      "incidents.component_ids_json"
    ),
    pinned: row.pinned === 1,
    manualOwner: row.manual_owner,
    update: {
      message: request.message,
      source: "manual",
      atMs: operator.nowMs,
      evidenceAtMs: null,
      correctionOf: null,
    },
    notify: true,
    automationOnly: false,
  })
  return {
    kind: "write",
    statements: plan.statements,
    guard: plan.guard,
    result: {
      status: 200,
      body: { schemaVersion: STATUS_SCHEMA_VERSION, incident: plan.predicted },
    },
    audit: {
      action: "incident.resolve",
      targetType: "incident",
      targetId: incidentId,
      revision: request.expectedRevision + 1,
      // The reason is operator-only context; it is never published.
      detail: { updateId: plan.updateId, previousState: row.state, reason: request.reason },
    },
    onLostRace: () => explainLostRace(db, incidentId),
  }
}

/** Every incident, newest first, with ownership flags (operator view). */
export async function listAdminIncidents(
  db: D1Database,
  query: { limit: number; cursor: PageCursor | null }
): Promise<{
  schemaVersion: 1
  incidents: Array<ReturnType<typeof toSummary> & { pinned: boolean; manualOwner: string | null }>
  nextCursor: string | null
}> {
  const { rows, nextCursor } = await listIncidentRows(db, query)
  const latest = await readLatestUpdates(
    db,
    rows.map((row) => row.id)
  )
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    incidents: rows.map((row) => ({
      ...toSummary(row, latest.get(row.id) ?? null),
      pinned: row.pinned === 1,
      manualOwner: row.manual_owner,
    })),
    nextCursor,
  }
}

export async function loadAdminIncident(
  db: D1Database,
  incidentId: string
): Promise<AdminIncidentDetail | null> {
  const row = await readIncidentRow(db, incidentId)
  if (!row) return null
  return {
    ...toDetail(row, await readUpdates(db, incidentId)),
    pinned: row.pinned === 1,
    manualOwner: row.manual_owner,
  }
}
