"use client"

/**
 * Auto-play the latest assistant reply aloud.
 *
 * Two paths, both gated by `ttsEnabled && ttsAutoPlay`:
 *  - **Streaming** (W7): while a turn is in flight, the assistant's text is fed
 *    to `speakChatMessageStream` as it grows (diffed off the chat store), so the
 *    first audio starts before the reply is finished. Starting a stream marks
 *    the message id as spoken so the turn-complete path below skips it — no
 *    double-speak.
 *  - **Turn-complete** (fallback): on the `<non-idle> → idle` edge, if the
 *    streaming path never spoke the message (e.g. it started after streaming, or
 *    a manual read), it reads the completed text via `speakChatMessage`.
 *
 * A side-effect-only hook: returns nothing and never throws into the chat loop
 * (synthesis errors are caught + logged; the orchestrator arbitrates a user
 * manually starting a different read).
 */

import { useEffect, useRef } from "react"
import type { UIMessage } from "ai"

import { useSettingsStore } from "@/stores/settings"
import { canAutoPlayTTS } from "@cognia/tts/auto-play-gates"
import { speakChatMessage, speakChatMessageStream } from "@/lib/tts/speak-chat-message"
import { createPushableStream, type PushableStream } from "@/lib/tts/pushable-stream"
import type { Character } from "@cognia/agent-config-types"
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

interface StreamSession {
  id: string
  /** Characters of the message already handed to the stream. */
  fedLen: number
  pushable: PushableStream
}

function lastAssistant(messages: UIMessage[]): UIMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") return messages[i]
  }
  return null
}

function isAudioModality(message: UIMessage): boolean {
  return (message as { metadata?: { modality?: string } }).metadata?.modality === "audio"
}

function extractText(message: UIMessage): string {
  return message.parts
    .filter((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text")
    .map((p) => p.text)
    .join("\n\n")
}

function resolveCharacter(
  message: UIMessage,
  characterById?: Map<string, Character>,
  directCharacter?: Character | null
): Character | null {
  const senderId = (message as { metadata?: { senderId?: string } }).metadata?.senderId
  return (senderId ? characterById?.get(senderId) : undefined) ?? directCharacter ?? null
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
  const streamSession = useRef<StreamSession | null>(null)

  // Streaming path: feed the growing assistant text to speakStream as it
  // arrives, so the first audio starts before the reply finishes.
  useEffect(() => {
    const gateOn = ttsEnabled && ttsAutoPlay
    const sess = streamSession.current

    // Terminal / gated-off: flush the tail and end the session. "streaming" and
    // "awaiting_approval" both mean the turn is still in flight — keep feeding.
    if (!gateOn || status === "idle" || status === "error") {
      if (sess) {
        sess.pushable.close()
        streamSession.current = null
      }
      return
    }

    const last = lastAssistant(messages)
    if (!last || isAudioModality(last)) return
    const text = extractText(last)

    // Close a session that belonged to an earlier message.
    if (sess && sess.id !== last.id) {
      sess.pushable.close()
      streamSession.current = null
    }

    if (!streamSession.current) {
      // Wait until the reply actually has text — a tool-only message shouldn't
      // spin up an empty stream.
      if (!text) return
      const pushable = createPushableStream()
      streamSession.current = { id: last.id, fedLen: 0, pushable }
      // Mark spoken up front so the turn-complete effect doesn't re-read it.
      lastAutoPlayedId.current = last.id
      const character = resolveCharacter(last, characterById, directCharacter)
      void speakChatMessageStream(pushable.stream, { messageId: last.id, character }).catch(
        (err) => {
          loggers.tts.warn("streaming auto-play failed", {
            err: err instanceof Error ? err.message : String(err),
          })
        }
      )
    }

    const current = streamSession.current
    if (current && current.id === last.id && text.length > current.fedLen) {
      current.pushable.push(text.slice(current.fedLen))
      current.fedLen = text.length
    }
  }, [status, messages, ttsEnabled, ttsAutoPlay, characterById, directCharacter])

  // Close any active stream when the hook unmounts.
  useEffect(
    () => () => {
      streamSession.current?.pushable.close()
      streamSession.current = null
    },
    []
  )

  // Turn-complete fallback: read the finished message unless streaming already did.
  useEffect(() => {
    const prev = prevStatus.current
    prevStatus.current = status

    // Only fire on the turn-completes edge: something → idle.
    if (!(status === "idle" && prev !== "idle")) return

    if (!canAutoPlayTTS({ ttsEnabled, ttsAutoPlay, isLoading: false, isStreaming: false })) return

    const last = lastAssistant(messages)
    if (!last || isAudioModality(last) || lastAutoPlayedId.current === last.id) return
    const text = extractText(last)
    if (!text.trim()) return

    lastAutoPlayedId.current = last.id
    const character = resolveCharacter(last, characterById, directCharacter)

    void speakChatMessage({ messageId: last.id, text, character }).catch((err) => {
      loggers.tts.warn("auto-play failed", {
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }, [status, messages, ttsEnabled, ttsAutoPlay, characterById, directCharacter])
}
