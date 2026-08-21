"use client"

import { useEffect } from "react"

import { useUIStore } from "@/stores/ui"

/**
 * One narrowing dimension of the conversation list, and how to undo it.
 *
 * Order matters: the ladder undoes the first `active` step it finds, so put the
 * cheapest / least destructive one first (the archive view and the search field
 * are transient; a saved filter set is closer to a preference).
 */
export interface ConversationRevealStep {
  /** True while this narrowing is capable of hiding the row. */
  active: boolean
  /** Undo it. Must clear `active` on the next render, or the ladder stalls. */
  undo: () => void
}

export interface UseConversationRevealParams {
  /** The conversation the chat pane is showing, if any. */
  activeSessionId: string | null
  /**
   * Whether the surface's own session list carries this row yet. The list comes
   * from a live query, so a conversation created a moment ago is `activeSessionId`
   * a full render before its row arrives — deciding "hidden" before then would
   * clear the user's filters every single time.
   */
  listed: (sessionId: string) => boolean
  /** Whether the row is actually rendered (present in the model's `orderedIds`). */
  visible: (sessionId: string) => boolean
  /**
   * Narrowing dimensions for this row, in the order they should be undone.
   * Resolved per session because the last rung — the collapsed section the row
   * sits in — depends on which row is being revealed.
   */
  steps: (sessionId: string) => readonly ConversationRevealStep[]
}

/**
 * Make a freshly created conversation visible in the list that has to show it.
 *
 * `startNewSession` marks the new conversation in the UI store
 * (`pendingConversationReveal`); every surface that renders the list runs this
 * hook and undoes **one** narrowing dimension per render pass, re-checking
 * against the recomputed model in between. Consequences that matter:
 *
 * - Nothing is reset when the row was visible all along — the common case.
 * - Only what is actually hiding it gets undone: a search still in the field
 *   does not cost the user their quick filters.
 * - It converges. Each step clears its own `active` flag, and the marker is
 *   dropped as soon as the row is on screen (or the user moved on to another
 *   conversation), so no pass can repeat forever.
 *
 * Deliberately keyed on *creation*, not on activation: a row that disappears
 * because the user read it under an "unread" filter is the filter doing its
 * job, and must not tear the filter down.
 */
export function useConversationReveal({
  activeSessionId,
  listed,
  visible,
  steps,
}: UseConversationRevealParams): void {
  const pending = useUIStore((s) => s.pendingConversationReveal)
  const clearReveal = useUIStore((s) => s.clearConversationReveal)

  useEffect(() => {
    if (!pending) return
    // The user opened something else in the meantime (or another surface
    // already revealed it) — the request is stale, not a reason to reset.
    if (activeSessionId !== pending) {
      clearReveal()
      return
    }
    // Still waiting for the live query to hand us the row.
    if (!listed(pending)) return
    if (visible(pending)) {
      clearReveal()
      return
    }
    const step = steps(pending).find((candidate) => candidate.active)
    if (!step) {
      // Hidden by something this surface cannot undo (a collapsed section it
      // does not own, a guild filter mid-reconcile). Let go rather than spin.
      clearReveal()
      return
    }
    step.undo()
  }, [pending, activeSessionId, listed, visible, steps, clearReveal])
}
