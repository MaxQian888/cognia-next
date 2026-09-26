"use client"

/**
 * React access to the window's one unread read (`lib/chat/unread-sessions.ts`).
 *
 * Every badge that counts unread conversations — the desktop guild badges and
 * the app badge through `useGuildUnread`, the mobile Chat tab badge and Inbox
 * dot through `useMobileUnread` — subscribes to the same refcounted Dexie
 * observer through `useSyncExternalStore`, so a window pays for one live query
 * however many badges it draws.
 */

import { useMemo, useSyncExternalStore } from "react"

import {
  getUnreadSessionsServerSnapshot,
  getUnreadSessionsSnapshot,
  subscribeUnreadSessions,
  type UnreadSessions,
} from "@/lib/chat/unread-sessions"
import {
  countMobileUnread,
  EMPTY_UNREAD_COUNTS,
  type MobileUnreadCounts,
} from "@/lib/inbox/unread-count"

/** The window's unread conversations, or `null` before the first read lands. */
export function useUnreadSessions(): UnreadSessions | null {
  return useSyncExternalStore(
    subscribeUnreadSessions,
    getUnreadSessionsSnapshot,
    getUnreadSessionsServerSnapshot
  )
}

/** The mobile shell's two unread counts, from the shared read. Zero until it lands. */
export function useMobileUnread(): MobileUnreadCounts {
  const unread = useUnreadSessions()
  return useMemo(
    () =>
      unread && unread.unreadBySession.size > 0
        ? countMobileUnread(unread.sessions, unread.unreadBySession)
        : EMPTY_UNREAD_COUNTS,
    [unread]
  )
}
