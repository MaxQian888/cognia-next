"use client"

/**
 * Per-message "read aloud" control for assistant chat messages.
 *
 * Intentionally does NOT use `useTTS` (which subscribes to the full
 * orchestrator state and would re-render on every progress tick). Instead it
 * pairs the focused `useReadAloudStatus` selector for its icon with the
 * imperative `speakChatMessage` helper for the action, so a virtualized chat
 * list full of these buttons stays cheap. Progress is shown only by the global
 * `TtsNowPlayingBar`.
 */

import { useCallback } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon, SquareIcon, Volume2Icon } from "lucide-react"

import { MessageAction } from "@/components/ai-elements/message"
import { useReadAloudStatus } from "@/hooks/media/use-read-aloud-status"
import { speakChatMessage } from "@/lib/tts/speak-chat-message"
import { ttsOrchestrator } from "@/lib/tts/tts-orchestrator"
import type { CharacterVoiceSource } from "@/lib/plugin/character-pack/character-voice"
import { loggers } from "@cognia/logging"
import { cn } from "@/lib/utils"

interface ReadAloudButtonProps {
  messageId: string
  /** Plain text of the message (already extracted from its parts). */
  text: string
  /** The character that spoke this message — drives per-character voice. */
  character?: CharacterVoiceSource | null
  className?: string
}

export function ReadAloudButton({ messageId, text, character, className }: ReadAloudButtonProps) {
  const t = useTranslations("chat.message")
  const { isActive, isLoading } = useReadAloudStatus(messageId)

  const onClick = useCallback(() => {
    if (isActive) {
      ttsOrchestrator.stop()
      return
    }
    void speakChatMessage({ messageId, text, character }).catch((err) => {
      loggers.tts.warn("read-aloud failed", {
        err: err instanceof Error ? err.message : String(err),
      })
    })
  }, [isActive, messageId, text, character])

  const label = isActive ? t("stopReading") : t("readAloud")

  return (
    <MessageAction
      tooltip={label}
      label={label}
      onClick={onClick}
      className={cn(isActive && "text-primary", className)}
    >
      {isLoading ? (
        <Loader2Icon className="size-3.5 animate-spin" />
      ) : isActive ? (
        <SquareIcon className="size-3.5" />
      ) : (
        <Volume2Icon className="size-3.5" />
      )}
    </MessageAction>
  )
}
