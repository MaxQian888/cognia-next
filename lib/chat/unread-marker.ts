/**
 * The "new messages" divider (ADR-0177, batch 2).
 *
 * Two pure decisions and one shell entry point. `firstUnreadMessageId` is
 * where the divider goes. `captureUnreadMarker` is what the shell records
 * before it marks the session read: the old `lastReadAt`, and only when the
 * session actually had unread messages, so a conversation the user simply
 * returned to gets no divider. `openSessionForReading` does both in the
 * order that matters, capture first, because `markSessionRead` overwrites
 * the pointer.
 */

import { getSessionState, markSessionRead } from "@/lib/db/session-state"
import { useUnreadMarkerStore } from "@/stores/chat/unread-marker-store"

interface MessageLike {
  id: string
  metadata?: unknown
}

/** The `createdAt` the row hoists onto the UI message, or `null` while it is in flight. */
export function messageCreatedAt(message: MessageLike): number | null {
  const meta = message.metadata
  if (!meta || typeof meta !== "object") return null
  const value = (meta as { createdAt?: unknown }).createdAt
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

/**
 * The id of the first message newer than `marker`, or `null`. Messages with
 * no timestamp yet (still streaming) are newer than any marker: they arrived
 * during this visit, which is after the pointer by definition.
 */
export function firstUnreadMessageId(
  messages: readonly MessageLike[],
  marker: number | null
): string | null {
  if (marker === null) return null
  for (const message of messages) {
    const createdAt = messageCreatedAt(message)
    if (createdAt === null || createdAt > marker) return message.id
  }
  return null
}

export interface UnreadMarkerDeps {
  getSessionState: typeof getSessionState
  markSessionRead: typeof markSessionRead
  setMarker: (sessionId: string, lastReadAt: number | null) => void
}

const productionDeps = (): UnreadMarkerDeps => ({
  getSessionState,
  markSessionRead,
  setMarker: (sessionId, lastReadAt) =>
    useUnreadMarkerStore.getState().setMarker(sessionId, lastReadAt),
})

/**
 * Record where the divider goes for this visit. Returns the pointer, or
 * `null` when the session had nothing unread (and clears any stale marker).
 */
export async function captureUnreadMarker(
  sessionId: string,
  deps: UnreadMarkerDeps = productionDeps()
): Promise<number | null> {
  const state = await deps.getSessionState(sessionId)
  const marker = state && state.unreadCount > 0 && state.lastReadAt > 0 ? state.lastReadAt : null
  deps.setMarker(sessionId, marker)
  return marker
}

/** Capture the divider pointer, then mark the session read, in that order. */
export async function openSessionForReading(
  sessionId: string,
  deps: UnreadMarkerDeps = productionDeps()
): Promise<void> {
  await captureUnreadMarker(sessionId, deps)
  await deps.markSessionRead(sessionId)
}

/** The user sent something here, so what came before it has been read. */
export function dropUnreadMarker(sessionId: string): void {
  useUnreadMarkerStore.getState().setMarker(sessionId, null)
}
