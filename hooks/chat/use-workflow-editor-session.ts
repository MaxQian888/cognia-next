"use client"

/**
 * Workflow-editor session pinning hook (Phase D.2).
 *
 * The Chat tab inside the visual workflow editor reuses the main chat
 * `Composer` + `MessageList` + `useChatStore` singleton verbatim — to
 * scope state to "this workflow" we maintain a per-workflow ChatSession
 * row with the deterministic id `workflow:${workflowId}` and pin the
 * global store's `activeSessionId` to it while the editor is mounted.
 *
 * On unmount we restore whatever session was active before so leaving
 * the editor doesn't strand the user on a session they didn't pick.
 *
 * `kind: "workflow-editor"` is what `resolveSendOptions` keys on to
 * inject the workflow subagents + system-prompt snapshot block, and what
 * `ChannelList` filters out so these sessions don't leak into the main
 * sidebar.
 */

import { useEffect, useState } from "react"
import { useChatStore } from "@/stores/chat"
import { getDb } from "@/lib/db/schema"
import type { ChatSession } from "@/lib/claude/types"

export interface UseWorkflowEditorSessionResult {
  /** Stable id for the pinned ChatSession (`workflow:${workflowId}`). */
  sessionId: string | null
  /** The fully-hydrated ChatSession row, once ensured to exist. */
  session: ChatSession | null
  /** `true` while we're creating the session row for the first time. */
  loading: boolean
}

const PREFIX = "workflow:"

export function workflowSessionId(workflowId: string): string {
  return `${PREFIX}${workflowId}`
}

/**
 * Ensure a `ChatSession` exists for this workflow id, pin the global
 * store's `activeSessionId` to it, and restore the previous active
 * session id on unmount. Idempotent across remounts.
 */
export function useWorkflowEditorSession(
  workflowId: string | undefined,
  workflowName: string | undefined
): UseWorkflowEditorSessionResult {
  // Render-phase state reset on workflowId change — the canonical React
  // pattern for "adjust state when a prop changes" (see
  // https://react.dev/reference/react/useState#storing-information-from-previous-renders).
  // This lets us avoid synchronous setState inside the effect below, which
  // would otherwise trigger a cascading render.
  const [trackedWorkflowId, setTrackedWorkflowId] = useState<string | undefined>(workflowId)
  const [session, setSession] = useState<ChatSession | null>(null)
  const [loading, setLoading] = useState<boolean>(Boolean(workflowId))

  if (trackedWorkflowId !== workflowId) {
    setTrackedWorkflowId(workflowId)
    setSession(null)
    setLoading(Boolean(workflowId))
  }

  useEffect(() => {
    if (!workflowId) return
    const sessionId = workflowSessionId(workflowId)
    let cancelled = false
    const previousActiveSessionId = useChatStore.getState().activeSessionId
    ;(async () => {
      const db = getDb()
      const existing = await db.sessions.get(sessionId)
      const now = Date.now()
      const row: ChatSession = existing ?? {
        id: sessionId,
        title: workflowName ? `${workflowName} — chat` : "Workflow chat",
        kind: "workflow-editor",
        createdAt: now,
        updatedAt: now,
      }
      if (!existing) {
        await db.sessions.put(row)
      } else if (existing.kind !== "workflow-editor") {
        // Defensive: an older row with the same deterministic id missing
        // the kind discriminator. Re-stamp so resolveSendOptions can
        // recognise it.
        await db.sessions.update(sessionId, { kind: "workflow-editor", updatedAt: now })
        row.kind = "workflow-editor"
      }
      if (cancelled) return
      setSession(row)
      setLoading(false)
      useChatStore.getState().setActiveSession(sessionId)
    })().catch((err) => {
      if (cancelled) return
      console.error("useWorkflowEditorSession: failed to pin session", err)
      setLoading(false)
    })
    return () => {
      cancelled = true
      // Restore the previous active session id on the way out so leaving
      // the editor doesn't strand the user on a hidden workflow-editor
      // session.
      const current = useChatStore.getState().activeSessionId
      if (current === sessionId) {
        useChatStore.getState().setActiveSession(previousActiveSessionId)
      }
    }
  }, [workflowId, workflowName])

  return {
    sessionId: workflowId ? workflowSessionId(workflowId) : null,
    session,
    loading,
  }
}
