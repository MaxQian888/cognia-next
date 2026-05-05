/**
 * CRUD layer for the `connectorAttachments` Dexie table (schema v18).
 *
 * Cached platform attachments (images, files, voice notes) fetched once and
 * stored locally to avoid repeated Tauri fetch commands. Keyed by
 * `[adapterId+remoteRef]` for O(1) "do I have it?" checks.
 */

import type { ConnectorAttachmentRow } from "./connector-types"
import { getDb } from "./schema"

/**
 * Insert or replace an attachment row. The `[adapterId+remoteRef]` composite
 * key uniquely identifies the attachment — a second put with the same pair
 * replaces the existing row.
 */
export async function upsertAttachment(
  row: ConnectorAttachmentRow
): Promise<ConnectorAttachmentRow> {
  const db = getDb()
  // Delete any existing row for this [adapterId+remoteRef] before insert to
  // enforce the unique-per-pair semantic (Dexie `put` uses the primary key
  // `id`, so different `id` values would create duplicates).
  const existing = await db.connectorAttachments
    .where("[adapterId+remoteRef]")
    .equals([row.adapterId, row.remoteRef])
    .first()
  if (existing && existing.id !== row.id) {
    await db.connectorAttachments.delete(existing.id)
  }
  await db.connectorAttachments.put(row)
  return row
}

/** Look up an attachment by adapter + remote ref. Returns undefined if absent. */
export async function findByRemoteRef(
  adapterId: string,
  remoteRef: string
): Promise<ConnectorAttachmentRow | undefined> {
  return getDb()
    .connectorAttachments.where("[adapterId+remoteRef]")
    .equals([adapterId, remoteRef])
    .first()
}

/**
 * Delete rows where `expiresAt < now`. Returns the count of deleted rows.
 * Defaults to `Date.now()`.
 */
export async function cleanupExpired(now = Date.now()): Promise<number> {
  const db = getDb()
  const expired = await db.connectorAttachments
    .filter((r) => r.expiresAt !== undefined && r.expiresAt < now)
    .toArray()
  if (expired.length === 0) return 0
  await db.connectorAttachments.bulkDelete(expired.map((r) => r.id))
  return expired.length
}
