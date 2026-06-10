/**
 * Persist the CLI's synthetic session as a real `ChatSession` row in the
 * CLI-local Dexie. The headless goal runner + judge read `getSession(sessionId)`
 * from the db, so a goal can only self-drive once this row exists. Mirrors the
 * exact shape `to-build-context` synthesises (via the shared `buildCliSession`).
 */
import { getDb } from "@/lib/db/schema"
import type { ChatSession } from "@/lib/claude/types"

import { buildCliSession } from "../config/to-build-context"
import type { ResolvedConfig } from "../config/schema"
import { ensureCliDb } from "../db/bootstrap"

interface SessionsTable {
  get(id: string): Promise<ChatSession | undefined>
  put(row: ChatSession): Promise<unknown>
}

export interface EnsureSessionRowDeps {
  /** Open the CLI-local db first. Defaults to {@link ensureCliDb}. */
  ensureDb?: () => Promise<unknown>
  /** The sessions table. Defaults to `getDb().sessions`. */
  getSessionsTable?: () => SessionsTable
  now?: () => number
}

/**
 * Upsert the session row, preserving `createdAt` if it already exists. Returns
 * the persisted row.
 */
export async function ensureSessionRow(
  sessionId: string,
  config: ResolvedConfig,
  deps: EnsureSessionRowDeps = {}
): Promise<ChatSession> {
  const ensureDb = deps.ensureDb ?? (() => ensureCliDb())
  const table = deps.getSessionsTable
    ? deps.getSessionsTable()
    : (getDb().sessions as unknown as SessionsTable)
  const now = deps.now ?? Date.now

  await ensureDb()
  const existing = await table.get(sessionId)
  const stamp = now()
  const row = buildCliSession(sessionId, config, stamp)
  if (existing) row.createdAt = existing.createdAt
  await table.put(row)
  return row
}
