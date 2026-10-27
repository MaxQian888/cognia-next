"use client"

/**
 * A shared run's reply as a member watches it being written (ADR-0241).
 *
 * The frames come from the session's v2 stream through the member-side
 * registry (`lib/collab/shared-live-frames.ts`), which already applies the
 * silence, redaction, run-end and ended-reply rules. This hook maps their
 * server ids to this device's projection ids (R5) and folds them with the
 * same hook the paired transcript uses, against the projection's sync cursor:
 * a settled reply gives way once the pull has applied its final correction.
 *
 * On the device that executes the run there is nothing to watch: its own
 * chat store streams the reply, so frames are ignored there.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"

import { useTranscriptLiveTurn } from "@/hooks/chat/use-transcript-live-turn"
import type { TranscriptLiveFrame, TranscriptLiveTurn } from "@/lib/chat/transcript/live-frames"
import type { TranscriptSource } from "@/lib/chat/transcript/source"
import { sharedMessageLocalId } from "@/lib/collab/shared-chat-sync"
import { subscribeSharedLive } from "@/lib/collab/shared-live-frames"
import { hasActiveSharedRun } from "@/lib/collab/shared-run-coordinator"
import { getDb } from "@/lib/db/schema"
import { useChatStore } from "@/stores/chat"

/**
 * A server message id as this device projects it: the device that wrote the
 * message keeps the id it wrote under (which is the server's), every other
 * device holds it under the projection's formula.
 */
function localMessageId(localSessionId: string, remoteMessageId: string): string {
  const messages = useChatStore.getState().sessions[localSessionId]?.messages ?? []
  return messages.some((message) => message.id === remoteMessageId)
    ? remoteMessageId
    : sharedMessageLocalId(localSessionId, remoteMessageId)
}

export function localSharedLiveFrame(
  localSessionId: string,
  frame: TranscriptLiveFrame
): TranscriptLiveFrame {
  return {
    ...frame,
    sessionId: localSessionId,
    messageId: localMessageId(localSessionId, frame.messageId),
    replyTo: localMessageId(localSessionId, frame.replyTo),
  }
}

export function useSharedLiveReply(localSessionId: string | null): TranscriptLiveTurn | null {
  const binding = useLiveQuery(
    async () =>
      localSessionId ? (await getDb().sessions.get(localSessionId))?.collaboration : undefined,
    [localSessionId]
  )
  const sharedSessionId = binding?.sessionId
  const source = useMemo<Pick<TranscriptSource, "subscribeLive">>(
    () => ({
      subscribeLive: (sessionId, listener) =>
        sharedSessionId
          ? subscribeSharedLive(sharedSessionId, (frame) => {
              if (hasActiveSharedRun(sessionId)) return
              listener(localSharedLiveFrame(sessionId, frame))
            })
          : () => undefined,
    }),
    [sharedSessionId]
  )
  return useTranscriptLiveTurn(localSessionId ?? "", source, binding?.syncCursor ?? null)
}
