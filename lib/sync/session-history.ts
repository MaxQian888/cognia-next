import type { StoredMessage } from "@cognia/agent-config-types"

import { normalizeStoredMessageMedia } from "@/lib/chat/media/normalize-message-media"
import { collectUnreferencedMessageMedia, messageMediaRefRows } from "@/lib/db/message-media-refs"
import { markSessionDirty } from "@/lib/chat/search/indexer"
import { getDb } from "@/lib/db/schema"
import { getActiveRuntimeTargetContext } from "@/lib/runtime/runtime-target-context"
import type { Transport } from "@/lib/tauri/transport-types"

const DEFAULT_PAGE_SIZE = 200
const MAX_PAGE_SIZE = 500
const MAX_PAGES = 10_000

interface SessionHistoryPage {
  rows: StoredMessage[]
  total?: number
  next_offset?: number
}

/**
 * Who holds this conversation's history, decided once per session.
 *
 * - `timeline`: the host projects it as bounded pages (ADR-0027).
 * - `legacy`: the host has it but cannot page it, so it was drained here.
 * - `local`: the host has never seen this session. A paired browser runs the
 *   full app and creates its own conversations, so this is the ordinary case
 *   for anything started in the browser rather than synced down from the host.
 */
export interface SessionHistoryHydration {
  applied: number
  total: number
  mode: "timeline" | "legacy" | "local"
}

function currentScope(): string {
  const scope = getActiveRuntimeTargetContext()
  let databaseName: string | undefined
  try {
    databaseName = getDb().name
  } catch {
    /* No active database during static rendering. */
  }
  return JSON.stringify([databaseName, scope?.accountId, scope?.targetId, scope?.routingGeneration])
}

function scopedSession(sessionId: string): string {
  return JSON.stringify([currentScope(), sessionId])
}

const hydrated = new Map<string, SessionHistoryHydration["mode"]>()
const owners = new Map<string, Transport>()
const generations = new Map<string, number>()
const connectionSubscriptions = new Map<Transport, () => void>()

/** Forget ownership after reconnect or a committed ownership transfer. */
export function invalidateSessionHistory(sessionId?: string): void {
  const keys = sessionId ? [scopedSession(sessionId)] : [...owners.keys()]
  for (const key of keys) {
    generations.set(key, (generations.get(key) ?? 0) + 1)
    hydrated.delete(key)
    inflight.delete(key)
    for (const listener of modeListeners.get(key) ?? []) listener()
  }
}

function watchConnection(transport: Transport): void {
  if (connectionSubscriptions.has(transport)) return
  const observable = transport as Transport & {
    onConnectionStateChange?: (listener: (state: string) => void) => () => void
  }
  if (!observable.onConnectionStateChange) return
  connectionSubscriptions.set(
    transport,
    observable.onConnectionStateChange(() => {
      for (const [key, owner] of owners) {
        if (owner !== transport) continue
        generations.set(key, (generations.get(key) ?? 0) + 1)
        hydrated.delete(key)
        inflight.delete(key)
        for (const listener of modeListeners.get(key) ?? []) listener()
      }
    })
  )
}
const inflight = new Map<string, Promise<SessionHistoryHydration>>()
const modeListeners = new Map<string, Set<() => void>>()

function publishMode(sessionId: string, mode: SessionHistoryHydration["mode"]): void {
  hydrated.set(sessionId, mode)
  for (const listener of modeListeners.get(sessionId) ?? []) listener()
}

export function getSessionHistoryMode(
  sessionId: string | null
): SessionHistoryHydration["mode"] | null {
  return sessionId ? (hydrated.get(scopedSession(sessionId)) ?? null) : null
}

export function subscribeSessionHistoryMode(sessionId: string, listener: () => void): () => void {
  sessionId = scopedSession(sessionId)
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
  watchConnection(transport)
  const scope = currentScope()
  const key = scopedSession(sessionId)
  if (owners.has(key) && owners.get(key) !== transport) invalidateSessionHistory(sessionId)
  owners.set(key, transport)
  const completedMode = hydrated.get(key)
  if (completedMode) return Promise.resolve({ applied: 0, total: 0, mode: completedMode })
  const existing = inflight.get(key)
  if (existing) return existing
  const generation = generations.get(key) ?? 0
  const assertCurrent = () => {
    if (scope !== currentScope() || generation !== (generations.get(key) ?? 0)) {
      throw new Error("session_history_scope_changed")
    }
  }
  const pageSize = Math.min(Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
  const task = negotiateAndHydrate(transport, sessionId, pageSize, assertCurrent).then((result) => {
    assertCurrent()
    publishMode(key, result.mode)
    return result
  })
  inflight.set(key, task)
  const finished = () => {
    if (inflight.get(key) === task) inflight.delete(key)
  }
  void task.then(finished, finished)
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

function isSessionNotFound(error: unknown): boolean {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined
  if (record?.code === "SESSION_NOT_FOUND") return true
  // Hosts predating the code-preserving RPC envelope answered
  // `internal_error` with the protocol code as the message.
  return (
    (error instanceof Error ? error.message : String(record?.message ?? "")).trim() ===
    "SESSION_NOT_FOUND"
  )
}

async function negotiateAndHydrate(
  transport: Transport,
  sessionId: string,
  pageSize: number,
  assertCurrent: () => void
): Promise<SessionHistoryHydration> {
  try {
    const capability = await transport.call<{ version?: unknown }>("transcript_capabilities", {})
    if (capability?.version === 1) {
      assertCurrent()
      return negotiateTimelineOwnership(transport, sessionId)
    }
    throw new Error("invalid transcript capability response")
  } catch (error) {
    // Only protocol absence may enter the legacy full-history path. A timeout,
    // auth failure, or server error must remain visible instead of triggering
    // an unexpectedly large background download.
    if (!isMethodNotFound(error)) throw error
  }
  assertCurrent()
  return drainSessionHistory(transport, sessionId, pageSize, assertCurrent)
}

/**
 * Speaking the protocol and holding this conversation are two different facts,
 * and only the second one decides which surface may render it.
 *
 * The capability handshake answers the first. Reading it as the second handed
 * every conversation to the host's projection, including the ones this browser
 * created and the host has never stored: the pane then rendered whatever the
 * host said about a session it did not have, which was a refusal, while the
 * complete transcript sat unread in local Dexie.
 *
 * One newest turn is enough to settle it, and asking before the surface mounts
 * keeps a locally owned conversation from painting an error card first.
 */
async function negotiateTimelineOwnership(
  transport: Transport,
  sessionId: string
): Promise<SessionHistoryHydration> {
  try {
    await transport.call("session_timeline", {
      session_id: sessionId,
      direction: "backward",
      limit: 1,
    })
  } catch (error) {
    if (!isSessionNotFound(error)) throw error
    return { applied: 0, total: 0, mode: "local" }
  }
  return { applied: 0, total: 0, mode: "timeline" }
}

async function drainSessionHistory(
  transport: Transport,
  sessionId: string,
  pageSize: number,
  assertCurrent: () => void
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
    assertCurrent()
    assertPage(page, sessionId, offset)

    if (page.rows.length > 0) {
      await persistHistoryPage(page.rows, assertCurrent)
      applied += page.rows.length
    }
    total = Math.max(total, page.total ?? applied)

    if (page.next_offset === undefined) {
      return { applied, total, mode: "legacy" }
    }
    offset = page.next_offset
  }

  throw new Error(`session history hydration exceeded ${MAX_PAGES} pages`)
}

async function persistHistoryPage(rows: StoredMessage[], assertCurrent: () => void): Promise<void> {
  const normalized = await Promise.all(rows.map(normalizeStoredMessageMedia))
  assertCurrent()
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
  // Hydrated history is chat history: queue the touched sessions so the ADR-0099
  // index projects them. The lazy backfill cannot be relied on here — it walks
  // once, newest-first, and latches `complete`, so anything pulled down after
  // that walk finished would stay unsearchable forever.
  for (const sessionId of new Set(normalized.map((message) => message.sessionId))) {
    markSessionDirty(sessionId)
  }
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
  for (const unsubscribe of connectionSubscriptions.values()) unsubscribe()
  connectionSubscriptions.clear()
  owners.clear()
  generations.clear()
  hydrated.clear()
  inflight.clear()
  modeListeners.clear()
}
