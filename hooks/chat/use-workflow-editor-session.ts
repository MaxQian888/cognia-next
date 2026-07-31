"use client"

/**
 * Workflow-editor session pinning hook (Phase D.2).
 *
 * The Chat tab inside the visual workflow editor reuses the main chat
 * `Composer` + `MessageList` + `useChatStore` singleton verbatim — to
 * scope state to "this workflow" we maintain a per-workflow ChatSession
 * row with the deterministic id `workflow:${workflowId}` and pin the
 * an embedded session without changing the global active conversation.
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
import { getDb } from "@/lib/db/schema"
import type { ChatSession } from "@cognia/agent-config-types"

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
 * True when `id` is a session belonging to `workflowId` — either the
 * deterministic default (`workflow:${workflowId}`) or one of the additional
 * sessions spun off from the session bar (`workflow:${workflowId}:${suffix}`).
 * The `:` separator guard avoids a false positive between sibling workflows
 * whose ids share a prefix (e.g. `wf_a` vs `wf_ab`).
 */
export function isWorkflowEditorSessionId(
  id: string | null | undefined,
  workflowId: string
): id is string {
  if (!id) return false
  const base = workflowSessionId(workflowId)
  return id === base || id.startsWith(`${base}:`)
}

/**
 * Create a new additional embedded session for this workflow. The caller owns
 * the scoped selection and decides when to show it.
 *
 * Shared by the session bar's "+" button and the chat tab's "new session"
 * affordances (welcome state + composer) so every create path is identical:
 * deterministic id contract, `kind: "workflow-editor"` discriminator (what
 * `resolveSendOptions` keys on), and an immediate focus switch.
 */
export async function createWorkflowEditorSession(
  workflowId: string,
  title: string
): Promise<string> {
  const now = Date.now()
  const id = `${workflowSessionId(workflowId)}:${Math.random().toString(36).slice(2, 8)}`
  const row: ChatSession = {
    id,
    title,
    kind: "workflow-editor",
    visibility: "embedded",
    surfaceBinding: { kind: "workflow", workflowId },
    createdAt: now,
    updatedAt: now,
  }
  await getDb().sessions.put(row)
  return id
}

/**
 * Ensure an embedded `ChatSession` exists for this workflow id. Idempotent
 * across remounts and deliberately independent of global chat focus.
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
    ;(async () => {
      const db = getDb()
      const existing = await db.sessions.get(sessionId)
      const now = Date.now()
      const row: ChatSession = existing ?? {
        id: sessionId,
        title: workflowName ? `${workflowName} — chat` : "Workflow chat",
        kind: "workflow-editor",
        visibility: "embedded",
        surfaceBinding: { kind: "workflow", workflowId },
        createdAt: now,
        updatedAt: now,
      }
      if (!existing) {
        await db.sessions.put(row)
      } else if (
        existing.kind !== "workflow-editor" ||
        existing.visibility !== "embedded" ||
        existing.surfaceBinding?.kind !== "workflow"
      ) {
        // Defensive: an older row with the same deterministic id missing
        // the kind discriminator. Re-stamp so resolveSendOptions can
        // recognise it.
        await db.sessions.update(sessionId, {
          kind: "workflow-editor",
          visibility: "embedded",
          surfaceBinding: { kind: "workflow", workflowId },
          updatedAt: now,
        })
        row.kind = "workflow-editor"
        row.visibility = "embedded"
        row.surfaceBinding = { kind: "workflow", workflowId }
      }
      if (cancelled) return
      setSession(row)
      setLoading(false)
    })().catch((err) => {
      if (cancelled) return
      console.error("useWorkflowEditorSession: failed to pin session", err)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [workflowId, workflowName])

  return {
    sessionId: workflowId ? workflowSessionId(workflowId) : null,
    session,
    loading,
  }
}
