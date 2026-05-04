/**
 * Capped audit log for the External Bridge MCP server.
 *
 * Every MCP request that flows through the bridge writes one row here so the
 * Settings UI can render a "what's been called recently" table and the user
 * can spot scope-denied calls or unexpected tools. The cap is 5000 newest
 * rows — `appendMcpAuditLog` prunes the oldest 100 in the same transaction
 * once a write would exceed the cap, so the table stays bounded without a
 * background sweep.
 *
 * Pattern mirrors `lib/db/backup-history.ts` (50-row cap there); the wider
 * cap here reflects the higher per-session call volume from external agents.
 */

import type { McpAuditLogRow } from "@/types/wiki"
import { getDb } from "./schema"

const AUDIT_CAP = 5000

function newId(): string {
  return "mau_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type McpAuditDraft = Omit<McpAuditLogRow, "id"> & Partial<Pick<McpAuditLogRow, "id">>

/** Append a row, then prune the oldest if the table exceeds the cap. */
export async function appendMcpAuditLog(draft: McpAuditDraft): Promise<McpAuditLogRow> {
  const db = getDb()
  const row: McpAuditLogRow = {
    id: draft.id ?? newId(),
    ts: draft.ts,
    tool: draft.tool,
    scope: draft.scope,
    allowed: draft.allowed,
    latencyMs: draft.latencyMs,
    reason: draft.reason,
    errorMessage: draft.errorMessage,
  }
  await db.transaction("rw", db.mcpAuditLog, async () => {
    await db.mcpAuditLog.add(row)
    await pruneOldest(AUDIT_CAP)
  })
  return row
}

/** Newest-first list, optionally filtered by tool name or denied-only. */
export async function listMcpAuditLog(filter?: {
  tool?: string
  deniedOnly?: boolean
  limit?: number
}): Promise<McpAuditLogRow[]> {
  const db = getDb()
  let coll = db.mcpAuditLog.orderBy("ts").reverse()
  if (filter?.tool) {
    coll = coll.filter((r) => r.tool === filter.tool)
  }
  if (filter?.deniedOnly) {
    coll = coll.filter((r) => r.allowed === false)
  }
  if (filter?.limit && filter.limit > 0) {
    coll = coll.limit(filter.limit)
  }
  return coll.toArray()
}

export async function countMcpAuditLog(): Promise<number> {
  return getDb().mcpAuditLog.count()
}

export async function clearMcpAuditLog(): Promise<void> {
  await getDb().mcpAuditLog.clear()
}

/**
 * Prune oldest rows so the table holds exactly `keep` entries. The table is
 * append-only and reads use the `ts` index, so a per-write trim is cheap
 * (Dexie's `orderBy("ts").limit(n).primaryKeys()` is O(n) over a sorted
 * cursor, not O(table)).
 *
 * Caller is expected to wrap this in a `db.transaction("rw", ...)`.
 */
async function pruneOldest(keep: number): Promise<void> {
  const db = getDb()
  const total = await db.mcpAuditLog.count()
  if (total <= keep) return
  const overflow = total - keep
  const oldest = await db.mcpAuditLog.orderBy("ts").limit(overflow).primaryKeys()
  if (oldest.length > 0) {
    await db.mcpAuditLog.bulkDelete(oldest as string[])
  }
}

/** Test-only escape hatch so suites can validate the prune math. */
export const __TESTING__ = { AUDIT_CAP, pruneOldest }
