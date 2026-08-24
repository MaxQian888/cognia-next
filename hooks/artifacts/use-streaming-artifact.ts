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

/** Stable empty reference — a fresh array per render would re-trigger the memo. */
const NO_MESSAGES: UIMessage[] = []

/**
 * @param sessionId Which conversation to detect for. Omitted means the focused
 * one.
 *
 * This used to bail out entirely for any session that was not focused, on the
 * grounds that "the chat store only holds the active session's messages". That
 * stopped being true when the store grew per-session slices, and the guard
 * outlived it: a background pane streaming a long code block showed no
 * artifact placeholder at all, then produced one on turn-complete out of
 * nowhere. Reads the named session's own slice instead — with the projection
 * preferred for the focused one, whose slice is materialised lazily and can
 * still be missing while `messages` is live.
 */
export function useStreamingArtifact(sessionId?: string): StreamingArtifact | null {
  const status = useChatStore((state) =>
    !sessionId || sessionId === state.activeSessionId
      ? state.status
      : (state.sessions[sessionId]?.status ?? "idle")
  )
  const messages = useChatStore((state) =>
    !sessionId || sessionId === state.activeSessionId
      ? state.messages
      : (state.sessions[sessionId]?.messages ?? NO_MESSAGES)
  )
  const artifacts = useSettingsStore((state) => state.settings?.artifacts)

  return useMemo(() => {
    if (status !== "streaming") return null
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
  }, [artifacts?.autoCreate, artifacts?.enabledTypes, artifacts?.minLines, messages, status])
}
