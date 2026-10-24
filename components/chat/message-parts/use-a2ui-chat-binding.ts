"use client"

/**
 * Bind a chat-rendered A2UI surface to the conversation it is rendered in, so
 * its gesture actions answer back there (ADR-0240,
 * `lib/a2ui/chat-action-routing.ts`). The transcript list's session wins; a
 * row's own `sessionId` (which may have fallen back to the focused session)
 * comes next, then the chat scope. Outside every one of them the surface
 * stays unbound and its actions stay local.
 */

import { useEffect } from "react"
import { useOptionalChatScope } from "@/components/chat/chat-scope-provider"
import { useTranscriptSessionId } from "@/components/chat/transcript-session-context"
import { bindA2UISurfaceToChat } from "@/lib/a2ui/chat-action-routing"

export function useA2UIChatBinding(
  surfaceId: string | null,
  options: { sessionId?: string; messageId?: string; enabled: boolean }
): string | undefined {
  const transcriptSessionId = useTranscriptSessionId()
  const chatScope = useOptionalChatScope()
  const sessionId = transcriptSessionId ?? options.sessionId ?? chatScope?.sessionId
  const { enabled, messageId } = options

  useEffect(() => {
    if (!enabled || !surfaceId || !sessionId) return
    return bindA2UISurfaceToChat(surfaceId, { sessionId, messageId })
  }, [enabled, surfaceId, sessionId, messageId])

  return sessionId
}
