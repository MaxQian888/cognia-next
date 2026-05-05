/**
 * Capped audit log for Platform Connector activity (schema v18).
 *
 * Every significant connector event (delivery, inbound, circuit-breaker,
 * credential refresh, etc.) writes one row here so the Settings UI can render
 * a "recent connector events" table per adapter. The cap is 5000 newest rows
 * by `at` — mirrors the pattern in `lib/db/mcp-audit-log.ts` exactly.
 */

import type { AuditEntry } from "@/types/connectors/audit"
import { getDb } from "./schema"

const AUDIT_CAP = 5000

export type ConnectorAuditDraft = Omit<AuditEntry, "id"> & Partial<Pick<AuditEntry, "id">>

/** Append a row, then prune oldest if the table exceeds the cap. */
export async function append(entry: ConnectorAuditDraft): Promise<AuditEntry> {
  const db = getDb()
  const row: AuditEntry = {
    id: entry.id ?? crypto.randomUUID(),
    adapterId: entry.adapterId,
    kind: entry.kind,
    at: entry.at,
    conversationKey: entry.conversationKey,
    idempotencyKey: entry.idempotencyKey,
    reason: entry.reason,
    message: entry.message,
    fields: entry.fields,
  }
  await db.transaction("rw", db.connectorAudit, async () => {
    await db.connectorAudit.add(row)
    await pruneOldest(AUDIT_CAP)
  })
  return row
}

/**
 * Return rows newest-first, optionally scoped to one adapter.
 * Defaults to 100 most recent.
 */
export async function listRecent(adapterId?: string, limit = 100): Promise<AuditEntry[]> {
  const db = getDb()
  let coll = db.connectorAudit.orderBy("at").reverse()
  if (adapterId) {
    coll = coll.filter((r) => r.adapterId === adapterId)
  }
  if (limit > 0) {
    coll = coll.limit(limit)
  }
  return coll.toArray()
}

/**
 * Prune oldest rows so the table holds exactly `keep` entries.
 * Caller must wrap in a `db.transaction("rw", ...)`.
 */
async function pruneOldest(keep: number): Promise<void> {
  const db = getDb()
  const total = await db.connectorAudit.count()
  if (total <= keep) return
  const overflow = total - keep
  const oldest = await db.connectorAudit.orderBy("at").limit(overflow).primaryKeys()
  if (oldest.length > 0) {
    await db.connectorAudit.bulkDelete(oldest as string[])
  }
}

/** Test-only escape hatch so suites can validate the prune math. */
export const __TESTING__ = { AUDIT_CAP, pruneOldest }
