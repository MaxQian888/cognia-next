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
 *
 * A link may also carry a files view (`&view=files[&path=…][&line=…]`,
 * ADR-0222): once the conversation is focused, the linked file opens — or, with
 * no path, its Files panel. The conversation opening is the link's first
 * promise; a file that cannot be shown is reported, not a reason to stay put.
 */

import { useEffect, useRef } from "react"

import {
  PERMALINK_MESSAGE_PARAM,
  PERMALINK_SESSION_PARAM,
  type ReadableParams,
} from "@/lib/chat/message-permalink"
import { getSession } from "@/lib/db/sessions"
import { parseFilesViewParams, type ParsedFilesView } from "@/lib/filespace/link-params"
import type { OpenFileSpacePathArgs } from "@/lib/filespace/open"
import type { OpenFileSpacePathResult } from "@/types/filespace"
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
  /** Called when a files link's conversation opened but its file did not. */
  onFilesUnresolved?: (result: Exclude<OpenFileSpacePathResult, "opened">) => void
  /** Injected for tests. */
  lookup?: (sessionId: string) => Promise<{ projectId?: string } | undefined>
  /** Injected for tests; defaults to `openFileSpacePath`. */
  openFiles?: (args: OpenFileSpacePathArgs) => Promise<OpenFileSpacePathResult>
}

async function defaultOpenFiles(args: OpenFileSpacePathArgs): Promise<OpenFileSpacePathResult> {
  const { openFileSpacePath } = await import("@/lib/filespace/open")
  return openFileSpacePath(args)
}

export function useSessionLink({
  params,
  onConsumed,
  onUnresolved,
  onOpened,
  onFilesUnresolved,
  lookup = getSession,
  openFiles = defaultOpenFiles,
}: UseSessionLinkOptions): void {
  const sessionId = parseSessionLink(params)
  const filesView = sessionId ? parseFilesViewParams(params) : null
  // Primitive keys: the parsed object is new on every render.
  const filesPath = filesView?.path
  const filesLine = filesView?.line
  const wantsFiles = filesView !== null
  const callbacks = useRef({ onConsumed, onUnresolved, onOpened, onFilesUnresolved, openFiles })
  useEffect(() => {
    callbacks.current = { onConsumed, onUnresolved, onOpened, onFilesUnresolved, openFiles }
  }, [onConsumed, onUnresolved, onOpened, onFilesUnresolved, openFiles])

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
        if (!wantsFiles) return
        const view: ParsedFilesView = {
          ...(filesPath ? { path: filesPath } : {}),
          ...(filesLine ? { line: filesLine } : {}),
        }
        void callbacks.current
          .openFiles({ sessionId, ...view })
          .catch((): OpenFileSpacePathResult => "not-found")
          .then((result) => {
            if (result !== "opened") callbacks.current.onFilesUnresolved?.(result)
          })
      },
      () => {
        if (!cancelled) unresolved()
      }
    )
    return () => {
      cancelled = true
    }
  }, [sessionId, lookup, wantsFiles, filesPath, filesLine])
}
