"use client"

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import type { UIMessage } from "ai"
import type { Character } from "@cognia/agent-config-types"

import { SessionMediaProvider } from "@/hooks/chat/session-media-provider"
import { useTranscriptController } from "@/hooks/chat/use-transcript-controller"
import { useTranscriptLiveTurn } from "@/hooks/chat/use-transcript-live-turn"
import { withLiveTurn } from "@/lib/chat/transcript/live-turn-view"
import { getDb } from "@/lib/db/schema"
import {
  refusedHostMessageOf,
  withoutRefusedHostMessages,
  isHostEnqueuePlaceholder,
} from "@/lib/chat/refused-host-message"
import { useStableCharacterById } from "@/hooks/data/use-stable-character-by-id"
import { createRemoteTranscriptSource } from "@/lib/chat/transcript/source"
import { useCharacters } from "@/lib/data-hooks/context"
import { onTransportChange, transport } from "@/lib/tauri/transport-instance"
import { TranscriptTimelineSurface } from "./transcript-timeline-surface"
import { RefusedHostMessages } from "./refused-host-messages"
import type { RewindFilesResult } from "@/lib/claude/ipc"
import { useMessageDisplay } from "@/hooks/chat/use-message-display"
import type { MessageDisplayPreferences } from "@/types/appearance"

type ChatStatus = "idle" | "streaming" | "awaiting_approval" | "error"

// Resolved per call: a browser that pairs after this module loaded swaps the
// transport, and a captured instance would keep reading the pre-pairing stub.
const companionTranscriptSource = createRemoteTranscriptSource(() => transport, {
  onTransportChange,
})

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
  onRegenerate?: () => void | Promise<void>
  onEditResend?: (messageId: string, newText: string) => void | Promise<void>
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
  const refusedMessages = useLiveQuery(
    async () => {
      const db = getDb()
      const retained = await db.messages
        .where("sessionId")
        .equals(sessionId)
        .filter((message) => refusedHostMessageOf(message) !== null)
        .sortBy("createdAt")
      const originals = await db.messages.bulkGet(
        retained.map((message) => refusedHostMessageOf(message)?.messageId ?? message.id)
      )
      return retained.filter(
        (message, index) =>
          !originals[index] ||
          originals[index]?.id === message.id ||
          isHostEnqueuePlaceholder(
            originals[index],
            (message.metadata?.hostState as { actionId?: unknown } | undefined)?.actionId
          )
      )
    },
    [sessionId],
    []
  )
  const characterById = useStableCharacterById(useCharacters())
  const messageDisplay = useMessageDisplay(messageDisplayOverride)
  // A member agent's reply arrives live from the person brain (P6e), never
  // through this store: draw it in place of the timeline's older copy.
  const liveReply = useTranscriptLiveTurn(
    sessionId,
    companionTranscriptSource,
    transcript.snapshot.revision
  )
  const drawnReply =
    liveReply &&
    (liveReply.state === "settled" || status === "streaming" || status === "awaiting_approval")
      ? liveReply
      : null
  const view = useMemo(
    () =>
      withLiveTurn({
        items: withoutRefusedHostMessages(
          transcript.snapshot.items,
          new Set(
            refusedMessages.map((message) => refusedHostMessageOf(message)?.messageId ?? message.id)
          )
        ),
        tail: selectActiveTurnMessages(messages, drawnReply ? "streaming" : status),
        live: drawnReply,
      }),
    [transcript.snapshot.items, messages, status, drawnReply, refusedMessages]
  )
  const liveMessages = view.liveMessages
  const mutableMessageIds = useMemo(
    () => new Set(messages.map((message) => message.id)),
    [messages]
  )

  return (
    <SessionMediaProvider sessionId={sessionId} transport={transport}>
      <TranscriptTimelineSurface
        sessionId={sessionId}
        items={view.items}
        expandedTurnKeys={transcript.snapshot.expandedTurnKeys}
        getDetail={transcript.getDetail}
        onPageTurn={(turnKey, direction) => void transcript.pageTurn(turnKey, direction)}
        loadingTurnKeys={transcript.snapshot.loadingTurnKeys}
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
      <RefusedHostMessages messages={refusedMessages} />
    </SessionMediaProvider>
  )
}
