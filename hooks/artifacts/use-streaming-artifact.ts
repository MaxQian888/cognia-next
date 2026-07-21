"use client"

/**
 * useStreamingArtifact — the artifact the assistant is part-way through
 * writing, or null.
 *
 * Artifacts are only created once a turn seals (`autoCreateFromContent` in the
 * turn-complete handler), and the detector only matches closed fences, so
 * nothing exists in the artifact store while the model is mid-block. That is
 * why a finished artifact appears to pop into the dock from nowhere. This hook
 * reads the still-open fence out of the in-flight assistant message so the UI
 * can show a placeholder in the spot the artifact is about to land.
 */

import { useMemo } from "react"
import type { UIMessage } from "ai"
import { useChatStore } from "@/stores/chat"
import { useSettingsStore } from "@/stores/settings"
import {
  DEFAULT_DETECTION_CONFIG,
  detectStreamingArtifact,
  type StreamingArtifact,
} from "@/lib/ai/generation/artifact-detector"

/**
 * Plain assistant text out of a UIMessage's parts.
 *
 * Deliberately re-stated here rather than imported from `use-claude-chat`:
 * that module is the whole chat engine, and pulling it into a panel component
 * would drag the engine and its side effects along. `lib/inbox`'s
 * `extractPlainText` is not usable either — it collapses whitespace, which
 * destroys the newlines this detector counts.
 */
function assistantText(message: UIMessage | undefined): string {
  if (!message || message.role !== "assistant") return ""
  return message.parts
    .map((part) => {
      const candidate = part as { type?: string; text?: string }
      return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : ""
    })
    .filter(Boolean)
    .join("\n")
}

/**
 * @param sessionId Scope guard. The chat store only holds the active session's
 * messages, so a list rendered for a different session must not claim that
 * session is generating something.
 */
export function useStreamingArtifact(sessionId?: string): StreamingArtifact | null {
  const status = useChatStore((state) => state.status)
  const messages = useChatStore((state) => state.messages)
  const activeSessionId = useChatStore((state) => state.activeSessionId)
  const artifacts = useSettingsStore((state) => state.settings?.artifacts)

  return useMemo(() => {
    if (status !== "streaming") return null
    if (sessionId && sessionId !== activeSessionId) return null
    // Honour the same opt-out auto-creation honours, so the placeholder never
    // promises an artifact the turn-complete handler will decline to create.
    if (artifacts?.autoCreate === false) return null

    const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant")
    const text = assistantText(lastAssistant)
    if (!text) return null

    return detectStreamingArtifact(text, {
      ...DEFAULT_DETECTION_CONFIG,
      autoCreate: true,
      minLines: artifacts?.minLines ?? DEFAULT_DETECTION_CONFIG.minLines,
      enabledTypes: artifacts?.enabledTypes ?? DEFAULT_DETECTION_CONFIG.enabledTypes,
    })
  }, [
    activeSessionId,
    artifacts?.autoCreate,
    artifacts?.enabledTypes,
    artifacts?.minLines,
    messages,
    sessionId,
    status,
  ])
}
