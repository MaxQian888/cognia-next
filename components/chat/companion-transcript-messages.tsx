"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import type { UIMessage } from "ai"
import type { Character } from "@cognia/agent-config-types"

import { SessionMediaProvider } from "@/hooks/chat/session-media-provider"
import { useTranscriptController } from "@/hooks/chat/use-transcript-controller"
import { useStableCharacterById } from "@/hooks/data/use-stable-character-by-id"
import { createRemoteTranscriptSource } from "@/lib/chat/transcript/source"
import { useCharacters } from "@/lib/data-hooks/context"
import { transport } from "@/lib/tauri/transport-instance"
import { TranscriptTimelineSurface } from "./transcript-timeline-surface"
import type { RewindFilesResult } from "@/lib/claude/ipc"
import { useMessageDisplay } from "@/hooks/chat/use-message-display"
import type { MessageDisplayPreferences } from "@/types/appearance"

type ChatStatus = "idle" | "streaming" | "awaiting_approval" | "error"

const companionTranscriptSource = createRemoteTranscriptSource(transport)

/** Keep only the unfinished tail beside folded, host-projected history. */
export function selectActiveTurnMessages(messages: UIMessage[], status: ChatStatus): UIMessage[] {
  if (status !== "streaming" && status !== "awaiting_approval") return []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return messages.slice(index)
  }
  const last = messages.at(-1)
  return last ? [last] : []
}

export interface CompanionTranscriptMessagesProps {
  sessionId: string
  messages: UIMessage[]
  status: ChatStatus
  messageDisplayOverride?: MessageDisplayPreferences
  directCharacter?: Character | null
  projectRoot?: string | null
  onCopy: () => void
  onRegenerate: () => void | Promise<void>
  onEditResend: (messageId: string, newText: string) => void | Promise<void>
  onRewindFiles?: (
    sessionId: string,
    checkpointId: string,
    dryRun: boolean
  ) => Promise<RewindFilesResult>
}

/**
 * Main-chat surface for a browser attached to a transcript-capable companion.
 * History stays on the host as folded pages; Zustand retains only the recent
 * sync tail needed to render the active turn.
 */
export function CompanionTranscriptMessages({
  sessionId,
  messages,
  status,
  messageDisplayOverride,
  directCharacter,
  projectRoot,
  onCopy,
  onRegenerate,
  onEditResend,
  onRewindFiles,
}: CompanionTranscriptMessagesProps) {
  const t = useTranslations("chat.transcript")
  const transcript = useTranscriptController(sessionId, companionTranscriptSource)
  const characterById = useStableCharacterById(useCharacters())
  const messageDisplay = useMessageDisplay(messageDisplayOverride)
  const liveMessages = useMemo(() => selectActiveTurnMessages(messages, status), [messages, status])
  const mutableMessageIds = useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages]
  )

  return (
    <SessionMediaProvider sessionId={sessionId} transport={transport}>
      <TranscriptTimelineSurface
        sessionId={sessionId}
        items={transcript.snapshot.items}
        expandedTurnKeys={transcript.snapshot.expandedTurnKeys}
        getDetail={transcript.getDetail}
        onExpand={(turnKey, revision, detailRevision) => {
          void transcript.expandTurn(turnKey, revision, detailRevision)
        }}
        onCollapse={transcript.collapseTurn}
        onLoadOlder={() => void transcript.loadOlder()}
        onRetry={() => void transcript.retry()}
        hasMore={transcript.snapshot.hasMore}
        loading={transcript.snapshot.loading}
        loadingOlder={transcript.snapshot.loadingOlder}
        error={transcript.snapshot.error}
        liveMessages={liveMessages}
        liveStatus={status}
        labels={{
          expand: t("expandTurn"),
          collapse: t("collapseTurn"),
          loadOlder: t("loadOlder"),
          loading: t("loading"),
          retry: t("retry"),
        }}
        renderAdapters={{
          characterById,
          directCharacter,
          onCopy,
          onRegenerate,
          onEditResend,
          onRewindFiles,
          projectRoot,
          mutableMessageIds,
          messageDisplay,
        }}
      />
    </SessionMediaProvider>
  )
}
