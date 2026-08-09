import type { StoredMessage } from "@cognia/agent-config-types"

import { normalizeStoredMessageMedia } from "@/lib/chat/media/normalize-message-media"
import { collectUnreferencedMessageMedia, messageMediaRefRows } from "@/lib/db/message-media-refs"
import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"

const DEFAULT_PAGE_SIZE = 200
const MAX_PAGE_SIZE = 500
const MAX_PAGES = 10_000

interface SessionHistoryPage {
  rows: StoredMessage[]
  total?: number
  next_offset?: number
}

export interface SessionHistoryHydration {
  applied: number
  total: number
  mode: "timeline" | "legacy"
}

const hydrated = new Map<string, SessionHistoryHydration["mode"]>()
const inflight = new Map<string, Promise<SessionHistoryHydration>>()
const modeListeners = new Map<string, Set<() => void>>()

function publishMode(sessionId: string, mode: SessionHistoryHydration["mode"]): void {
  hydrated.set(sessionId, mode)
  for (const listener of modeListeners.get(sessionId) ?? []) listener()
}

export function getSessionHistoryMode(
  sessionId: string | null
): SessionHistoryHydration["mode"] | null {
  return sessionId ? (hydrated.get(sessionId) ?? null) : null
}

export function subscribeSessionHistoryMode(sessionId: string, listener: () => void): () => void {
  const listeners = modeListeners.get(sessionId) ?? new Set<() => void>()
  listeners.add(listener)
  modeListeners.set(sessionId, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) modeListeners.delete(sessionId)
  }
}

/**
 * Materialize one selected cloud session's complete transcript into local
 * Dexie. Generic boot sync intentionally carries only a recent global tail;
 * this bounded pager unfolds the older history only when the user opens it.
 */
export function hydrateSessionHistory(
  transport: Transport,
  sessionId: string,
  options: { pageSize?: number } = {}
): Promise<SessionHistoryHydration> {
  const completedMode = hydrated.get(sessionId)
  if (completedMode) {
    return Promise.resolve({ applied: 0, total: 0, mode: completedMode })
  }
  const existing = inflight.get(sessionId)
  if (existing) return existing

  const pageSize = Math.min(Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
  const task = negotiateAndHydrate(transport, sessionId, pageSize)
  inflight.set(sessionId, task)
  void task.then(
    () => inflight.delete(sessionId),
    () => inflight.delete(sessionId)
  )
  return task
}

function isMethodNotFound(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined
  const code = record?.code
  const status = record?.status ?? record?.statusCode
  const message = error instanceof Error ? error.message : String(record?.message ?? "")
  return (
    code === -32601 ||
    code === "METHOD_NOT_FOUND" ||
    status === 404 ||
    status === 405 ||
    /\bmethod not found\b/i.test(message)
  )
}

async function negotiateAndHydrate(
  transport: Transport,
  sessionId: string,
  pageSize: number
): Promise<SessionHistoryHydration> {
  try {
    const capability = await transport.call<{ version?: unknown }>("transcript_capabilities", {})
    if (capability?.version === 1) {
      publishMode(sessionId, "timeline")
      return { applied: 0, total: 0, mode: "timeline" }
    }
    throw new Error("invalid transcript capability response")
  } catch (error) {
    // Only protocol absence may enter the legacy full-history path. A timeout,
    // auth failure, or server error must remain visible instead of triggering
    // an unexpectedly large background download.
    if (!isMethodNotFound(error)) throw error
  }
  return drainSessionHistory(transport, sessionId, pageSize)
}

async function drainSessionHistory(
  transport: Transport,
  sessionId: string,
  pageSize: number
): Promise<SessionHistoryHydration> {
  let offset = 0
  let applied = 0
  let total = 0

  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber++) {
    const page = await transport.call<SessionHistoryPage>("message_get_by_session", {
      session_id: sessionId,
      limit: pageSize,
      offset,
    })
    assertPage(page, sessionId, offset)

    if (page.rows.length > 0) {
      await persistHistoryPage(page.rows)
      applied += page.rows.length
    }
    total = Math.max(total, page.total ?? applied)

    if (page.next_offset === undefined) {
      publishMode(sessionId, "legacy")
      return { applied, total, mode: "legacy" }
    }
    offset = page.next_offset
  }

  throw new Error(`session history hydration exceeded ${MAX_PAGES} pages`)
}

async function persistHistoryPage(rows: StoredMessage[]): Promise<void> {
  const normalized = await Promise.all(rows.map(normalizeStoredMessageMedia))
  const db = getDb()
  const messageIds = normalized.map((message) => message.id)
  const orphanCandidates = new Set<string>()
  await db.transaction("rw", db.messages, db.messageMediaRefs, async () => {
    const oldRefs = await db.messageMediaRefs.where("messageId").anyOf(messageIds).toArray()
    for (const ref of oldRefs) orphanCandidates.add(ref.hash)
    await db.messages.bulkPut(normalized)
    await db.messageMediaRefs.where("messageId").anyOf(messageIds).delete()
    const replacementRefs = normalized.flatMap((message) =>
      messageMediaRefRows(message.id, message.sessionId, message.parts)
    )
    if (replacementRefs.length > 0) await db.messageMediaRefs.bulkPut(replacementRefs)
  })
  if (orphanCandidates.size > 0) {
    await collectUnreferencedMessageMedia(orphanCandidates)
  }
}

function assertPage(page: SessionHistoryPage, sessionId: string, offset: number): void {
  if (
    !page ||
    !Array.isArray(page.rows) ||
    (page.total !== undefined && (!Number.isFinite(page.total) || page.total < 0))
  ) {
    throw new Error("invalid session history page")
  }
  for (const row of page.rows) {
    if (!row || typeof row !== "object" || typeof row.sessionId !== "string") {
      throw new Error("invalid session history row")
    }
    if (row.sessionId !== sessionId) {
      throw new Error(`session history page session mismatch: expected ${sessionId}`)
    }
  }
  if (
    page.next_offset !== undefined &&
    (!Number.isInteger(page.next_offset) || page.next_offset <= offset)
  ) {
    throw new Error("session history page did not advance its offset")
  }
}

/** Test-only reset for the module-level completion/in-flight cache. */
export function __resetHydratedSessionHistoryForTests(): void {
  hydrated.clear()
  inflight.clear()
  modeListeners.clear()
}
