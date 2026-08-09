/** Tier-retained audit log for Platform Connector activity. */

import type { AuditEntry } from "@/types/connectors/audit"
import { getDb } from "./schema"

export const CONNECTOR_AUDIT_SECURITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000
export const CONNECTOR_AUDIT_OPERATIONAL_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000
export const CONNECTOR_AUDIT_DIAGNOSTIC_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
export const CONNECTOR_AUDIT_RETENTION_BATCH = 500

export type ConnectorAuditRetentionTier = "security" | "operational" | "diagnostic"
export type ConnectorAuditDraft = Omit<AuditEntry, "id"> & Partial<Pick<AuditEntry, "id">>

export function connectorAuditRetentionTier(
  entry: Pick<AuditEntry, "kind" | "reason">
): ConnectorAuditRetentionTier {
  if (
    entry.kind.startsWith("callback.") ||
    entry.kind.startsWith("principal.") ||
    entry.kind.includes("credential") ||
    entry.reason === "delivery_unknown"
  ) {
    return "security"
  }
  if (
    entry.kind.startsWith("adapter.") ||
    entry.kind.startsWith("delivery.") ||
    entry.kind.startsWith("circuit.") ||
    entry.kind.startsWith("rate_limit.") ||
    entry.kind.startsWith("outbound.")
  ) {
    return "operational"
  }
  return "diagnostic"
}

/** Append only; low-frequency housekeeping owns bounded tier pruning. */
export async function append(entry: ConnectorAuditDraft): Promise<AuditEntry> {
  const db = getDb()
  const row: AuditEntry = {
    id: entry.id ?? crypto.randomUUID(),
    adapterId: entry.adapterId,
    projectId: entry.projectId,
    kind: entry.kind,
    at: entry.at,
    conversationKey: entry.conversationKey,
    idempotencyKey: entry.idempotencyKey,
    reason: entry.reason,
    message: entry.message,
    fields: entry.fields,
  }
  await db.connectorAudit.add(row)
  return row
}

export async function listRecent(adapterId?: string, limit = 100): Promise<AuditEntry[]> {
  const db = getDb()
  let collection = db.connectorAudit.orderBy("at").reverse()
  if (adapterId) collection = collection.filter((row) => row.adapterId === adapterId)
  if (limit > 0) collection = collection.limit(limit)
  return collection.toArray()
}

export async function sweepConnectorAuditRetention(
  options: {
    now?: number
    batchLimit?: number
  } = {}
): Promise<number> {
  const now = options.now ?? Date.now()
  const batchLimit = options.batchLimit ?? CONNECTOR_AUDIT_RETENTION_BATCH
  const db = getDb()
  const tiers: Array<{
    tier: ConnectorAuditRetentionTier
    cutoff: number
    quota: number
  }> = [
    {
      tier: "diagnostic",
      cutoff: now - CONNECTOR_AUDIT_DIAGNOSTIC_RETENTION_MS,
      quota: Math.ceil(batchLimit / 3),
    },
    {
      tier: "operational",
      cutoff: now - CONNECTOR_AUDIT_OPERATIONAL_RETENTION_MS,
      quota: Math.ceil(batchLimit / 3),
    },
    {
      tier: "security",
      cutoff: now - CONNECTOR_AUDIT_SECURITY_RETENTION_MS,
      quota: Math.floor(batchLimit / 3),
    },
  ]
  const victims: AuditEntry[] = []
  for (const { tier, cutoff, quota } of tiers) {
    if (quota <= 0) continue
    victims.push(
      ...(await db.connectorAudit
        .where("at")
        .below(cutoff)
        .filter((entry) => connectorAuditRetentionTier(entry) === tier)
        .limit(quota)
        .toArray())
    )
  }
  if (victims.length > 0) await db.connectorAudit.bulkDelete(victims.map((entry) => entry.id))
  return victims.length
}

export const __TESTING__ = { connectorAuditRetentionTier }
