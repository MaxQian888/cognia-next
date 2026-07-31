/**
 * Capped breadcrumb log for Inbox subsystem telemetry (Dexie schema v49).
 *
 * Decoupled from `connectorAudit` so high-volume breadcrumb rotation does
 * not displace the operator-visible 5000-row audit window. The cap is 3000
 * newest rows by `at`; mirrors the pattern in `lib/db/connector-audit.ts`
 * verbatim (synchronous prune inside the same transaction as the append).
 *
 * The `lib/telemetry/inbox-events.ts` module wraps these calls behind a
 * convenience `trackInboxEvent(kind, fields)` helper that fills in `id` and
 * `at` so emit sites stay terse.
 */

import { getDb } from "./schema"
import type { InboxTelemetryEventRow, InboxTelemetryKind } from "./inbox-telemetry-types"

export type { InboxTelemetryEventRow, InboxTelemetryKind } from "./inbox-telemetry-types"

const TELEMETRY_CAP = 3000

export type InboxTelemetryDraft = Omit<InboxTelemetryEventRow, "id"> &
  Partial<Pick<InboxTelemetryEventRow, "id">>

/** Append a row, then prune oldest if the table exceeds the cap. */
export async function append(entry: InboxTelemetryDraft): Promise<InboxTelemetryEventRow> {
  const db = getDb()
  const row: InboxTelemetryEventRow = {
    id: entry.id ?? crypto.randomUUID(),
    kind: entry.kind,
    at: entry.at,
    adapterId: entry.adapterId,
    conversationKey: entry.conversationKey,
    fields: entry.fields,
  }
  await db.inboxTelemetryEvents.add(row)
  await pruneOldest(TELEMETRY_CAP, db.inboxTelemetryEvents)
  return row
}

/**
 * Return rows newest-first, optionally scoped to one adapter and/or kind.
 * Defaults to 200 most recent.
 */
export async function listRecent(
  options: { adapterId?: string; kind?: InboxTelemetryKind; limit?: number } = {}
): Promise<InboxTelemetryEventRow[]> {
  const db = getDb()
  const limit = options.limit ?? 200
  let coll = db.inboxTelemetryEvents.orderBy("at").reverse()
  if (options.adapterId) {
    coll = coll.filter((r) => r.adapterId === options.adapterId)
  }
  if (options.kind) {
    coll = coll.filter((r) => r.kind === options.kind)
  }
  if (limit > 0) {
    coll = coll.limit(limit)
  }
  return coll.toArray()
}

/**
 * Prune oldest rows so the table holds exactly `keep` entries.
 * Safe to call after an append; concurrent callers converge on the same cap
 * because deleting an already-deleted primary key is a no-op.
 */
async function pruneOldest(keep: number, table = getDb().inboxTelemetryEvents): Promise<void> {
  const total = await table.count()
  if (total <= keep) return
  const overflow = total - keep
  const oldest = await table.orderBy("at").limit(overflow).primaryKeys()
  if (oldest.length > 0) {
    await table.bulkDelete(oldest as string[])
  }
}

/** Test-only escape hatch so suites can validate the prune math. */
export const __TESTING__ = { TELEMETRY_CAP, pruneOldest }
