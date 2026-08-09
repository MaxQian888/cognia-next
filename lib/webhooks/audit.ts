/** Append-only durable audit for outbound Standard Webhooks deliveries. */

import { getDb } from "@/lib/db/schema"
import type { WebhookAuditEntry } from "@/types/webhooks"

const MAX_ROWS = 1000

export async function appendWebhookAudit(
  entry: Omit<WebhookAuditEntry, "id" | "at"> & { id?: string; at?: number }
): Promise<void> {
  const row: WebhookAuditEntry = {
    ...entry,
    id: entry.id ?? crypto.randomUUID(),
    at: entry.at ?? Date.now(),
  }
  // Keep the established Dexie table name to avoid a destructive schema
  // migration; only the canonical outbound module writes new rows.
  await getDb().remoteControlAudit.add(row)
  await pruneWebhookAudit()
}

export async function listWebhookAudit(limit = 100): Promise<WebhookAuditEntry[]> {
  return getDb()
    .remoteControlAudit.orderBy("at")
    .reverse()
    .filter((row) => row.direction === "outbound")
    .limit(limit)
    .toArray()
}

export async function pruneWebhookAudit(): Promise<void> {
  const table = getDb().remoteControlAudit
  const count = await table.count()
  if (count <= MAX_ROWS) return
  const oldest = await table
    .orderBy("at")
    .limit(count - MAX_ROWS)
    .primaryKeys()
  await table.bulkDelete(oldest)
}
