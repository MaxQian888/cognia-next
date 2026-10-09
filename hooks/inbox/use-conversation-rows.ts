"use client"

/**
 * The Inbox conversation list's data: every platform-bound session in scope,
 * joined with its override row and unread count.
 *
 * Extracted from `conversation-list.tsx`, where the live query opened one
 * `messages` index scan PER SESSION, sequentially, just to draw a preview line
 * — an N+1 that re-ran on every message, override and session-state change.
 * `ChatSession` already carries a denormalized `lastMessagePreview` /
 * `lastMessageAt` (written by `persistMessages`, and by the connector writers
 * through `stampSessionLastMessage`), so those are used directly. Only legacy
 * rows that have never been stamped fall back to a message read, and those
 * reads run in parallel.
 *
 * The shell owns one subscription and hands the rows to both the list and the
 * triage pane's empty state, so the two can never disagree about a count.
 */

import { useCallback, useState } from "react"
import Dexie from "dexie"
import { useLiveQuery } from "dexie-react-hooks"
import type { ChatSession } from "@cognia/agent-config-types"
import { getDb } from "@/lib/db/schema"
import type { ConversationOverrideRow } from "@/lib/db/connector-types"
import type { SessionStateRow } from "@/lib/db/session-state"
import { extractPlainText } from "@/lib/inbox/extract-plain-text"
import type { ConversationRowItem } from "@/lib/inbox/conversation-grouping"
import { useProjectStore } from "@/stores/project/project-store"

/** Same cap the list used before; the row truncates visually anyway. */
export const CONVERSATION_PREVIEW_MAX = 240

export interface ConversationRowsScope {
  adapterId?: string
  platformKind?: string
}

/** The fallback preview for a session never stamped with one. */
export interface LatestMessagePreview {
  preview: string
  at: number
}

/**
 * Which sessions the list shows: platform-bound, in the active workspace
 * (legacy sessions without a `projectId` are grandfathered, Dexie v86), and
 * inside the route's adapter / platform scope.
 */
export function filterConversationSessions(
  sessions: readonly ChatSession[],
  scope: ConversationRowsScope & { activeProjectId?: string | null }
): ChatSession[] {
  return sessions.filter((session) => {
    const binding = session.platformBinding
    if (!binding) return false
    if (scope.activeProjectId && session.projectId && session.projectId !== scope.activeProjectId) {
      return false
    }
    if (scope.adapterId && binding.adapterId !== scope.adapterId) return false
    if (scope.platformKind && binding.platform !== scope.platformKind) return false
    return true
  })
}

/** A session the denormalized preview cannot speak for yet. */
export function needsPreviewFallback(session: ChatSession): boolean {
  return typeof session.lastMessageAt !== "number"
}

export function buildConversationRows(
  sessions: readonly ChatSession[],
  overrides: readonly ConversationOverrideRow[],
  states: readonly Pick<SessionStateRow, "sessionId" | "unreadCount">[],
  fallbacks: ReadonlyMap<string, LatestMessagePreview | undefined> = new Map()
): ConversationRowItem[] {
  const overrideByKey = new Map(overrides.map((row) => [row.conversationKey, row]))
  const unreadById = new Map(states.map((state) => [state.sessionId, state.unreadCount]))
  return sessions.map((session) => {
    const conversationKey = session.platformBinding!.conversationKey
    const fallback = fallbacks.get(session.id)
    const denormalized = !needsPreviewFallback(session)
    return {
      session,
      override: overrideByKey.get(conversationKey),
      unreadCount: Math.max(0, unreadById.get(session.id) ?? 0),
      lastMessagePreview: denormalized
        ? session.lastMessagePreview?.slice(0, CONVERSATION_PREVIEW_MAX)
        : fallback?.preview,
      lastMessageAt: denormalized ? session.lastMessageAt : fallback?.at,
    }
  })
}

async function latestMessagePreview(sessionId: string): Promise<LatestMessagePreview | undefined> {
  const latest = await getDb()
    .messages.where("[sessionId+createdAt]")
    .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey])
    .last()
  if (!latest) return undefined
  return {
    preview: extractPlainText(latest.parts).slice(0, CONVERSATION_PREVIEW_MAX),
    at: latest.createdAt,
  }
}

/** The live-query body, exported so it can be exercised against a real Dexie. */
export async function loadConversationRows(
  scope: ConversationRowsScope & { activeProjectId?: string | null }
): Promise<ConversationRowItem[]> {
  const db = getDb()
  const [allSessions, overrides, states] = await Promise.all([
    db.sessions.filter((session) => session.platformBinding != null).toArray(),
    db.conversationOverrides.toArray(),
    db.sessionState.toArray(),
  ])
  const sessions = filterConversationSessions(allSessions, scope)
  const legacy = sessions.filter(needsPreviewFallback)
  const fallbackEntries = await Promise.all(
    legacy.map(async (session) => [session.id, await latestMessagePreview(session.id)] as const)
  )
  return buildConversationRows(sessions, overrides, states, new Map(fallbackEntries))
}

export interface ConversationRowsState {
  /** `undefined` while the first read is in flight (or after a failed one). */
  rows: ConversationRowItem[] | undefined
  /** The last read's failure, if it failed. */
  error: Error | null
  /** Run the read again after a failure. */
  retry: () => void
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Live rows for the scope.
 *
 * A failed read is CAPTURED, not thrown. The shell calls this above its
 * per-pane error boundaries (the rows feed both the list and the triage
 * pane), so a thrown Dexie error would escape every pane boundary and blank
 * the whole Inbox instead of just the list. The list renders the error with
 * a retry; `retry` re-keys the query.
 */
export function useConversationRows(scope: ConversationRowsScope = {}): ConversationRowsState {
  // Workspace isolation: re-runs on a project switch because it is a dep.
  const activeProjectId = useProjectStore((state) => state.activeProjectId)
  const { adapterId, platformKind } = scope
  const [attempt, setAttempt] = useState(0)
  const result = useLiveQuery<{ rows?: ConversationRowItem[]; error?: Error }>(async () => {
    if (typeof window === "undefined") return { rows: [] }
    try {
      return { rows: await loadConversationRows({ adapterId, platformKind, activeProjectId }) }
    } catch (error) {
      return { error: asError(error) }
    }
  }, [adapterId, platformKind, activeProjectId, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { rows: result?.rows, error: result?.error ?? null, retry }
}
