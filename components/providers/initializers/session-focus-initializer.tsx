"use client"

/**
 * The single seam that reacts to "the user is now looking at a different
 * conversation".
 *
 * Two stores hold right-rail state that describes a conversation without being
 * keyed by one, so both leak across a switch:
 *
 * - `artifactDockLayoutStore` — the pending reveals (panel intent, workspace
 *   request, retained workspace target). See `clearSessionScopedReveals`.
 * - `artifactStore` — the artifact list's search query and type/runtime filters
 *   are one global blob, so narrowing typed in one conversation silently keeps
 *   narrowing every conversation after it.
 *
 * Both need the same trigger, so they share one subscriber rather than each
 * store growing its own chat-store dependency. Doing it here rather than inside
 * the consuming components is what makes it survive their remount: switching
 * conversation changes the workbench scope key, which tears the whole right
 * rail down and back up.
 *
 * Renders nothing; mounted once in `app/layout.tsx`.
 */

import { useEffect } from "react"

import { useChatStore } from "@/stores/chat"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"

/**
 * Apply the per-switch resets. Exported for the test and for any future caller
 * that switches conversations without going through the store (there is none
 * today — `setActiveSession` is the only writer).
 */
export function applySessionFocusChange(sessionId: string | null): void {
  useArtifactDockLayoutStore.getState().clearSessionScopedReveals()
  useArtifactStore.getState().resetSessionScopedWorkspaceFilters(sessionId)
}

export function SessionFocusInitializer() {
  useEffect(() => {
    // Subscribe rather than depend on a rendered `activeSessionId`: the reset
    // must land before the dock re-renders for the new conversation, and an
    // effect keyed on the value would run after it.
    return useChatStore.subscribe((state, prevState) => {
      if (state.activeSessionId === prevState.activeSessionId) return
      applySessionFocusChange(state.activeSessionId)
    })
  }, [])

  return null
}

export default SessionFocusInitializer
