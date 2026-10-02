/**
 * Small shared persistence helpers: monotonic counters, operator
 * idempotency records and the append-only audit log.
 */

import { sha256Hex } from "../../../../../lib/status/signing"

/** Increment and return a named counter. */
export async function nextCounter(db: D1Database, name: string): Promise<number> {
  const row = await db
    .prepare("UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value")
    .bind(name)
    .first<{ value: number }>()
  if (row) return row.value
  await db.prepare("INSERT OR IGNORE INTO counters (name, value) VALUES (?, 0)").bind(name).run()
  return nextCounter(db, name)
}

export async function readCounter(db: D1Database, name: string): Promise<number> {
  const row = await db
    .prepare("SELECT value FROM counters WHERE name = ?")
    .bind(name)
    .first<{ value: number }>()
  return row?.value ?? 0
}

/** Statement that increments a counter, for use inside a `db.batch`. */
export function incrementCounterStatement(db: D1Database, name: string): D1PreparedStatement {
  return db.prepare("UPDATE counters SET value = value + 1 WHERE name = ?").bind(name)
}

export interface AuditEntry {
  atMs: number
  actor: string
  action: string
  targetType: string
  targetId: string | null
  revision: number | null
  /** Non-secret, bounded detail. Never email addresses, tokens or bodies. */
  detail?: Record<string, unknown>
}

/**
 * Audit insert. With `onlyIfPreviousChanged`, the row is written only when
 * the statement immediately before it in the same batch changed a row
 * (`changes() > 0`), so a compare-and-set that lost leaves no audit entry.
 */
export function auditStatement(
  db: D1Database,
  entry: AuditEntry,
  opts: { onlyIfPreviousChanged?: boolean } = {}
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (at, actor, action, target_type, target_id, revision, detail_json)
       SELECT ?, ?, ?, ?, ?, ?, ?${opts.onlyIfPreviousChanged ? " WHERE changes() > 0" : ""}`
    )
    .bind(
      entry.atMs,
      entry.actor,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.revision,
      entry.detail ? JSON.stringify(entry.detail) : null
    )
}

export interface StoredOperation {
  status: number
  response: unknown
  sameRequest: boolean
}

/**
 * Look up a prior operator write by its operation ID. A replay with the
 * same request digest returns the stored response; a different request
 * under the same ID is a conflict the caller reports.
 */
export async function findOperation(
  db: D1Database,
  operationId: string,
  requestBytes: Uint8Array
): Promise<StoredOperation | null> {
  const row = await db
    .prepare(
      "SELECT request_digest, status, response_json FROM admin_operations WHERE operation_id = ?"
    )
    .bind(operationId)
    .first<{ request_digest: string; status: number; response_json: string }>()
  if (!row) return null
  const digest = await sha256Hex(requestBytes)
  return {
    status: row.status,
    response: JSON.parse(row.response_json),
    sameRequest: row.request_digest === digest,
  }
}

export async function recordOperationStatement(
  db: D1Database,
  input: {
    operationId: string
    actor: string
    kind: string
    requestBytes: Uint8Array
    status: number
    response: unknown
    atMs: number
  }
): Promise<D1PreparedStatement> {
  return db
    .prepare(
      `INSERT INTO admin_operations (operation_id, actor, kind, request_digest, status, response_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      input.operationId,
      input.actor,
      input.kind,
      await sha256Hex(input.requestBytes),
      input.status,
      JSON.stringify(input.response),
      input.atMs
    )
}
