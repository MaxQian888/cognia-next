"use client"

/**
 * Consume a session-only `/?session=…` link: open that conversation.
 *
 * `buildSessionHref` (`lib/chat/message-permalink.ts`) produces this shape for
 * every "open this conversation" link that has no message to land on: plan
 * notifications, a memory's jump to its source, an issue run, a collaboration
 * approval request (ADR-0207). Only the `&message=` form had a consumer
 * (`useMessagePermalink`), so these links navigated to the root and opened
 * nothing.
 *
 * The session is read from Dexie before it is focused: a stale id (deleted
 * conversation, a link from another device) must say so instead of focusing a
 * session that does not exist. Its workspace becomes the active project first,
 * the same order a sidebar click uses, so the conversation is listed where it
 * opens. The link is consumed either way so a re-render cannot re-fire it.
 */

import { useEffect, useRef } from "react"

import {
  PERMALINK_MESSAGE_PARAM,
  PERMALINK_SESSION_PARAM,
  type ReadableParams,
} from "@/lib/chat/message-permalink"
import { getSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"

/** The session a session-only link names, or null (no link, or a permalink). */
export function parseSessionLink(params: ReadableParams | null): string | null {
  if (!params) return null
  const sessionId = params.get(PERMALINK_SESSION_PARAM)?.trim()
  if (!sessionId || params.get(PERMALINK_MESSAGE_PARAM)) return null
  return sessionId
}

export interface UseSessionLinkOptions {
  /** Usually `useSearchParams()`. */
  params: ReadableParams | null
  /** Called once the link is spent, opened or not; the caller strips it. */
  onConsumed: () => void
  /** Called after `onConsumed` when the conversation does not exist here. */
  onUnresolved: () => void
  /** Called after a conversation was focused, to bring the chat on screen. */
  onOpened?: () => void
  /** Injected for tests. */
  lookup?: (sessionId: string) => Promise<{ projectId?: string } | undefined>
}

export function useSessionLink({
  params,
  onConsumed,
  onUnresolved,
  onOpened,
  lookup = getSession,
}: UseSessionLinkOptions): void {
  const sessionId = parseSessionLink(params)
  const callbacks = useRef({ onConsumed, onUnresolved, onOpened })
  useEffect(() => {
    callbacks.current = { onConsumed, onUnresolved, onOpened }
  }, [onConsumed, onUnresolved, onOpened])

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const unresolved = () => {
      callbacks.current.onConsumed()
      callbacks.current.onUnresolved()
    }
    lookup(sessionId).then(
      (session) => {
        if (cancelled) return
        if (!session) {
          unresolved()
          return
        }
        if (session.projectId && useProjectStore.getState().activeProjectId !== session.projectId) {
          useProjectStore.getState().setActiveProject(session.projectId)
        }
        if (useChatStore.getState().activeSessionId !== sessionId) {
          useChatStore.getState().setActiveSession(sessionId)
        }
        callbacks.current.onConsumed()
        callbacks.current.onOpened?.()
      },
      () => {
        if (!cancelled) unresolved()
      }
    )
    return () => {
      cancelled = true
    }
  }, [sessionId, lookup])
}
