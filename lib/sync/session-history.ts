import type { StoredMessage } from "@cognia/agent-config-types"

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
}

const hydrated = new Set<string>()
const inflight = new Map<string, Promise<SessionHistoryHydration>>()

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
  if (hydrated.has(sessionId)) {
    return Promise.resolve({ applied: 0, total: 0 })
  }
  const existing = inflight.get(sessionId)
  if (existing) return existing

  const pageSize = Math.min(Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE)
  const task = drainSessionHistory(transport, sessionId, pageSize)
  inflight.set(sessionId, task)
  void task.then(
    () => inflight.delete(sessionId),
    () => inflight.delete(sessionId)
  )
  return task
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
      await getDb().messages.bulkPut(page.rows)
      applied += page.rows.length
    }
    total = Math.max(total, page.total ?? applied)

    if (page.next_offset === undefined) {
      hydrated.add(sessionId)
      return { applied, total }
    }
    offset = page.next_offset
  }

  throw new Error(`session history hydration exceeded ${MAX_PAGES} pages`)
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
}
