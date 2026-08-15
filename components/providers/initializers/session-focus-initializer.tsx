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
 * - `artifactDockLayoutStore.dockCollapsed` — persisted and written `false` by
 *   every reveal, so a dock raised by one conversation's artifact stays open,
 *   empty, for every conversation after it. `parkIdleArtifactDock` folds it
 *   away when the incoming conversation has nothing to show in it.
 *
 * Both need the same trigger, so they share one subscriber rather than each
 * store growing its own chat-store dependency. Doing it here rather than inside
 * the consuming components is what makes it survive their remount: switching
 * conversation changes the workbench scope key, which tears the whole right
 * rail down and back up.
 *
 * Additionally handles retry of failed title generation: when a session becomes
 * active (or the app resumes to the foreground), we check if the session's
 * title needs upgrading and trigger a background retry if eligible.
 *
 * Renders nothing; mounted once in `app/layout.tsx`.
 */

import { useEffect } from "react"

import { useChatStore } from "@/stores/chat"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useArtifactDockLayoutStore } from "@/stores/artifact/artifact-dock-layout-store"
import { parkIdleArtifactDock } from "@/lib/artifacts/park-idle-dock"
import { retryTitleIfNeeded } from "@/lib/ai/generation/title-retry"
import { subscribeResume } from "@/lib/capacitor/app"

/**
 * Apply the per-switch resets. Exported for the test and for any future caller
 * that switches conversations without going through the store (there is none
 * today — `setActiveSession` is the only writer).
 */
export function applySessionFocusChange(sessionId: string | null): void {
  useArtifactDockLayoutStore.getState().clearSessionScopedReveals()
  useArtifactStore.getState().resetSessionScopedWorkspaceFilters(sessionId)
  // A dock left open by an earlier conversation's artifact must not follow the
  // user into one that has none — see `parkIdleArtifactDock`.
  parkIdleArtifactDock(sessionId)
  // Retry failed title generation when the user re-focuses a session.
  if (sessionId) void retryTitleIfNeeded(sessionId)
}

export function SessionFocusInitializer() {
  useEffect(() => {
    // Subscribe rather than depend on a rendered `activeSessionId`: the reset
    // must land before the dock re-renders for the new conversation, and an
    // effect keyed on the value would run after it.
    const unsubFocus = useChatStore.subscribe((state, prevState) => {
      if (state.activeSessionId === prevState.activeSessionId) return
      applySessionFocusChange(state.activeSessionId)
    })
    // `dockCollapsed` is persisted, so the conversation restored at start-up
    // never passes through the switch above — park an idle dock once here too,
    // or a reload lands on the empty panel the previous session left open.
    parkIdleArtifactDock(useChatStore.getState().activeSessionId)

    // On app resume (foreground), retry title for the currently active session.
    let disposed = false
    let unsubResume: (() => void) | undefined
    void subscribeResume(() => {
      const sessionId = useChatStore.getState().activeSessionId
      if (sessionId) void retryTitleIfNeeded(sessionId)
    }).then((off) => {
      if (disposed) off()
      else unsubResume = off
    })

    return () => {
      disposed = true
      unsubFocus()
      unsubResume?.()
    }
  }, [])

  return null
}

export default SessionFocusInitializer
