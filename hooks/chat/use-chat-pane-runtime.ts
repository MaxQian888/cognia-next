"use client"

import { useCallback, useEffect, useId } from "react"
import { useChatStore } from "@/stores/chat"
import { updateSession } from "@/lib/db/sessions"
import type { PlanResumeMode } from "@/components/agent/plan/plan-approval-card"
import { useClaudeChat } from "./use-claude-chat"

/** Shared runtime access for every conversation surface. React Activity tears
 * down this effect when a retained panel is hidden, releasing dialog ownership. */
export function useChatPaneRuntime(sessionId: string | null) {
  const runtime = useClaudeChat()
  const paneId = useId()
  useEffect(() => {
    if (!sessionId) return
    useChatStore.getState().retainPane(sessionId, paneId)
    return () => useChatStore.getState().releasePane(sessionId, paneId)
  }, [sessionId, paneId])
  const ownsDecisions = useChatStore(
    (state) => !!sessionId && state.paneIdsBySession[sessionId]?.[0] === paneId
  )
  const resumePlan = useCallback(
    async (prompt: string, mode: PlanResumeMode) => {
      if (!sessionId) return
      const store = useChatStore.getState()
      const previous = store.sessions[sessionId]?.permissionMode ?? null
      store.setPermissionMode(mode, sessionId)
      try {
        await updateSession(sessionId, { permissionMode: mode })
      } catch (error) {
        store.setPermissionMode(previous, sessionId)
        throw error
      }
      await runtime.send(prompt, undefined, { sessionId, skipUserAppend: true, throwOnError: true })
    },
    [runtime, sessionId]
  )
  return { runtime, ownsDecisions, resumePlan }
}
