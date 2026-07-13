"use client"

/**
 * Auto-play the latest assistant reply aloud once a turn finishes.
 *
 * Connects the previously-dead `canAutoPlayTTS` gate to the chat surface. On
 * the `<non-idle> → idle` status transition it reads the last assistant
 * message, resolves its per-character voice (team `senderId` or the direct
 * session character), and hands off to the shared `speakChatMessage` path.
 *
 * A side-effect-only hook: it returns nothing and never throws into the chat
 * loop (synthesis errors are caught + logged; the orchestrator's own
 * cancellation arbitration handles a user manually starting a different read).
 */

import { useEffect, useRef } from "react"
import type { UIMessage } from "ai"

import { useSettingsStore } from "@/stores/settings"
import { canAutoPlayTTS } from "@cognia/tts/auto-play-gates"
import { speakChatMessage } from "@/lib/tts/speak-chat-message"
import type { Character } from "@/lib/claude/types"
import { loggers } from "@cognia/logging"

type ChatStatus = "idle" | "streaming" | "awaiting_approval" | "error"

export interface UseChatAutoPlayTTSArgs {
  messages: UIMessage[]
  status: ChatStatus
  /** senderId → Character for team sessions. */
  characterById?: Map<string, Character>
  /** The session-bound character in a 1:1 chat (no senderId). */
  directCharacter?: Character | null
}

function lastAssistant(messages: UIMessage[]): UIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i]
  }
  return null
}

function extractText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text")
    .map((p) => p.text)
    .join("\n\n")
}

export function useChatAutoPlayTTS({
  messages,
  status,
  characterById,
  directCharacter,
}: UseChatAutoPlayTTSArgs): void {
  const ttsEnabled = useSettingsStore((s) => s.settings?.ttsEnabled ?? false)
  const ttsAutoPlay = useSettingsStore((s) => s.settings?.ttsAutoPlay ?? false)

  const prevStatus = useRef<ChatStatus>(status)
  const lastAutoPlayedId = useRef<string | null>(null)

  useEffect(() => {
    const prev = prevStatus.current
    prevStatus.current = status

    // Only fire on the turn-completes edge: something → idle (not idle→idle,
    // which is just an unrelated re-render like a bookmark toggle).
    if (!(status === "idle" && prev !== "idle")) return

    // Gate is the single source of the auto-play rule. At this edge there is no
    // active stream/load, so it reduces to ttsEnabled && ttsAutoPlay.
    if (!canAutoPlayTTS({ ttsEnabled, ttsAutoPlay, isLoading: false, isStreaming: false })) return

    const last = lastAssistant(messages)
    if (!last || lastAutoPlayedId.current === last.id) return
    const text = extractText(last)
    if (!text.trim()) return

    lastAutoPlayedId.current = last.id

    const senderId = (last as { metadata?: { senderId?: string } }).metadata?.senderId
    const character =
      (senderId ? characterById?.get(senderId) : undefined) ?? directCharacter ?? null

    void speakChatMessage({ messageId: last.id, text, character }).catch((err) => {
      loggers.tts.warn("auto-play failed", {
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }, [status, messages, ttsEnabled, ttsAutoPlay, characterById, directCharacter])
}
