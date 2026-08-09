/**
 * CRUD layer for the `codeAdoptionTurns` Dexie table (v108). Written by the
 * turn tracker after each settled turn; read by `metrics.ts` and the existing
 * Task Resources panel. Local-only — this table is intentionally absent from
 * `lib/sync`, so rows never leave the device.
 */

import { getDb } from "@/lib/db/schema"

import type { CodeAdoptionTurnRow } from "./types"

export async function persistCodeAdoptionTurn(row: CodeAdoptionTurnRow): Promise<void> {
  await getDb().codeAdoptionTurns.put(row)
}

export async function getCodeAdoptionTurn(id: string): Promise<CodeAdoptionTurnRow | undefined> {
  return getDb().codeAdoptionTurns.get(id)
}

/** Resolve the adoption row correlated with a durable Task Workspace run. */
export async function getCodeAdoptionTurnByTaskWorkspaceRun(
  taskWorkspaceRunId: string
): Promise<CodeAdoptionTurnRow | undefined> {
  const derivedId = taskWorkspaceRunId.startsWith("run:")
    ? taskWorkspaceRunId.slice("run:".length)
    : undefined
  if (derivedId) {
    const direct = await getDb().codeAdoptionTurns.get(derivedId)
    if (direct) return direct
  }
  return getDb()
    .codeAdoptionTurns.filter((row) => row.taskWorkspaceRunId === taskWorkspaceRunId)
    .first()
}

/** All turns for a session, oldest-first. */
export async function listCodeAdoptionTurnsBySession(
  sessionId: string
): Promise<CodeAdoptionTurnRow[]> {
  return getDb().codeAdoptionTurns.where("sessionId").equals(sessionId).sortBy("ts")
}

/** Newest-first list across all sessions, capped. */
export async function listRecentCodeAdoptionTurns(limit = 50): Promise<CodeAdoptionTurnRow[]> {
  return getDb().codeAdoptionTurns.orderBy("ts").reverse().limit(limit).toArray()
}

/** Oldest-first rows in an explicit time window. */
export async function listCodeAdoptionTurnsInRange(
  from: number,
  to: number
): Promise<CodeAdoptionTurnRow[]> {
  return getDb().codeAdoptionTurns.where("ts").between(from, to, true, true).sortBy("ts")
}

/** Trim to the newest `keep` metric-only rows (call after each write to bound growth). */
export async function pruneCodeAdoptionTurns(keep = 10_000): Promise<number> {
  const db = getDb()
  const ids = await db.codeAdoptionTurns.orderBy("ts").reverse().offset(keep).primaryKeys()
  if (ids.length === 0) return 0
  await db.codeAdoptionTurns.bulkDelete(ids as string[])
  return ids.length
}
