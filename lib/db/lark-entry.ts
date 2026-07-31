/**
 * CRUD for the Lark entry-token ledger + web-session audit ledger
 * (Dexie v126, plan 2026-07-24 Phase 3).
 *
 * Single-use ENFORCEMENT lives in the Rust companion (jti LRU + token TTL);
 * these tables are the brain's durable ops view: which tokens were minted,
 * when they were consumed, and which web sessions have been seen. The raw
 * session token never lands here — sessions are keyed by a jti hash.
 */

import type { LarkEntryContextRow, LarkWebSessionRow } from "./connector-types"
import { getDb } from "./schema"

export interface RecordEntryContextInput {
  jti: string
  adapterId: string
  principalId: string
  accountId: string
  entryType: string
  conversationKey: string
  sessionId?: string
  expiresAt: number
  now?: number
}

export async function recordEntryContext(
  input: RecordEntryContextInput
): Promise<LarkEntryContextRow> {
  const row: LarkEntryContextRow = {
    id: input.jti,
    adapterId: input.adapterId,
    principalId: input.principalId,
    accountId: input.accountId,
    entryType: input.entryType,
    conversationKey: input.conversationKey,
    sessionId: input.sessionId,
    issuedAt: input.now ?? Date.now(),
    expiresAt: input.expiresAt,
  }
  await getDb().larkEntryContexts.put(row)
  return row
}

/** Mark consumption reported by the companion. No-op for unknown jtis. */
export async function markEntryContextConsumed(jti: string, now?: number): Promise<void> {
  const existing = await getDb().larkEntryContexts.get(jti)
  if (!existing) return
  await getDb().larkEntryContexts.update(jti, { consumedAt: now ?? Date.now() })
}

export async function getEntryContext(jti: string): Promise<LarkEntryContextRow | undefined> {
  return getDb().larkEntryContexts.get(jti)
}

/** Reap expired, unconsumed ledger rows. Returns the number deleted. */
export async function pruneExpiredEntryContexts(now?: number): Promise<number> {
  const at = now ?? Date.now()
  const stale = await getDb()
    .larkEntryContexts.where("expiresAt")
    .below(at)
    .filter((row) => row.consumedAt === undefined)
    .toArray()
  await getDb().larkEntryContexts.bulkDelete(stale.map((row) => row.id))
  return stale.length
}

export interface TouchWebSessionInput {
  jtiHash: string
  adapterId: string
  openIdHash: string
  tenantKey: string
  appId: string
  principalId?: string
  issuedAt: number
  expiresAt: number
  now?: number
}

/** Upsert the session ledger row on every sighting (entry resolve / intent). */
export async function touchWebSession(input: TouchWebSessionInput): Promise<LarkWebSessionRow> {
  const now = input.now ?? Date.now()
  const existing = await getDb().larkWebSessions.get(input.jtiHash)
  const row: LarkWebSessionRow = existing
    ? { ...existing, principalId: input.principalId ?? existing.principalId, lastSeenAt: now }
    : {
        id: input.jtiHash,
        adapterId: input.adapterId,
        openIdHash: input.openIdHash,
        tenantKey: input.tenantKey,
        appId: input.appId,
        principalId: input.principalId,
        issuedAt: input.issuedAt,
        expiresAt: input.expiresAt,
        lastSeenAt: now,
      }
  await getDb().larkWebSessions.put(row)
  return row
}

export async function revokeWebSession(jtiHash: string, now?: number): Promise<void> {
  await getDb().larkWebSessions.update(jtiHash, { revokedAt: now ?? Date.now() })
}

export async function getWebSession(jtiHash: string): Promise<LarkWebSessionRow | undefined> {
  return getDb().larkWebSessions.get(jtiHash)
}
