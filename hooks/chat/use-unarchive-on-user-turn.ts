"use client"

/**
 * Restore an archived conversation when the user writes into it (ADR-0213,
 * decision D2).
 *
 * Every turn the user starts from an open conversation counts: a composer
 * send, an edit-and-resend, a regenerate, a retry from the error card, plan
 * feedback and a plan approval that resumes the run. Each is the user choosing
 * to keep working in this conversation, so leaving it in the archive would hide
 * a conversation that is live again. Background writers (bots, the scheduler,
 * connectors, workflow nodes) never pass through the chat pane and so never
 * call this: their writes leave the conversation archived.
 *
 * The restore is started, not awaited. The turn must not wait on (or fail
 * because of) a metadata write: the routed writer only clears `archivedAt`
 * with a field-level modify (or a Host intent), so it cannot clobber or be
 * clobbered by the send's own row updates whichever lands first. A failure is
 * already toasted by `useSessionArchiveActions`, which never rejects.
 */

import { useCallback, useEffect, useRef } from "react"
import type { ChatSession } from "@cognia/agent-config-types"

import { useSessionArchiveActions } from "@/hooks/chat/use-session-archive-actions"

/**
 * Returns a stable `restoreIfArchived()` to call at the start of every
 * user-initiated turn in `session`. It does nothing for an active row.
 */
export function useUnarchiveOnUserTurn(session: ChatSession | null | undefined): () => void {
  const { unarchive } = useSessionArchiveActions()
  const latest = useRef(session)
  useEffect(() => {
    latest.current = session
  })
  // One restore per archive stamp. The row prop stays archived until the live
  // query catches up, so a second quick send would otherwise write (and toast)
  // again. A re-archive (Undo included) gets a new stamp and restores again; a
  // failed restore forgets its stamp so the next turn retries.
  const started = useRef(new Set<string>())

  return useCallback(() => {
    const row = latest.current
    if (!row || row.archivedAt == null) return
    // A conversation handed off to another device refuses the turn itself
    // (session write guard). Restoring it would only add a second
    // "read-only" toast for the same refusal.
    if (row.handoffLock) return
    const key = `${row.id}:${row.archivedAt}`
    if (started.current.has(key)) return
    started.current.add(key)
    void unarchive([row], { reason: "send" }).then(
      (landed) => {
        if (!landed) started.current.delete(key)
      },
      () => {
        started.current.delete(key)
      }
    )
  }, [unarchive])
}
