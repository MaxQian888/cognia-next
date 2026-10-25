"use client"

/**
 * A member agent's live reply for one conversation (P6e).
 *
 * Folds the Host's `transcript://live` frames (`lib/chat/transcript/live-frames.ts`)
 * into the reply to draw, and lets go of a finished one once the timeline has
 * read past it (`settledReplyCaughtUp`), or after
 * {@link SETTLED_LIVE_REPLY_MAX_MS} when it never does: a Host that keeps no
 * revision, or a refetch that failed, must not pin an old reply on screen.
 */

import { useEffect, useRef, useState } from "react"

import {
  applyTranscriptLiveFrame,
  type TranscriptLiveTurn,
} from "@/lib/chat/transcript/live-frames"
import { settledReplyCaughtUp } from "@/lib/chat/transcript/live-turn-view"
import type { TranscriptSource } from "@/lib/chat/transcript/source"

/** How long a finished reply stays drawn when the timeline never catches up. */
export const SETTLED_LIVE_REPLY_MAX_MS = 10_000

interface LiveState {
  sessionId: string
  turn: TranscriptLiveTurn | null
  /** The timeline revision on screen when the reply settled. */
  revisionAtSettle: number | null
}

export function useTranscriptLiveTurn(
  sessionId: string,
  source: Pick<TranscriptSource, "subscribeLive">,
  timelineRevision: number | null
): TranscriptLiveTurn | null {
  const [state, setState] = useState<LiveState | null>(null)
  const revision = useRef(timelineRevision)
  useEffect(() => {
    revision.current = timelineRevision
  }, [timelineRevision])

  useEffect(
    () =>
      source.subscribeLive?.(sessionId, (frame) =>
        setState((previous) => {
          const before = previous?.sessionId === sessionId ? previous : null
          const turn = applyTranscriptLiveFrame(before?.turn ?? null, frame)
          const settledBefore =
            before?.turn?.state === "settled" && before.turn.messageId === turn?.messageId
          return {
            sessionId,
            turn,
            revisionAtSettle:
              turn?.state !== "settled"
                ? null
                : settledBefore
                  ? before.revisionAtSettle
                  : revision.current,
          }
        })
      ),
    [sessionId, source]
  )

  const current = state?.sessionId === sessionId ? state : null
  const settledId = current?.turn?.state === "settled" ? current.turn.messageId : null
  useEffect(() => {
    if (!settledId) return
    const timer = setTimeout(
      () =>
        setState((previous) =>
          previous?.turn?.messageId === settledId && previous.turn.state === "settled"
            ? { ...previous, turn: null, revisionAtSettle: null }
            : previous
        ),
      SETTLED_LIVE_REPLY_MAX_MS
    )
    return () => clearTimeout(timer)
  }, [settledId])

  if (!current?.turn) return null
  return settledReplyCaughtUp(current.turn, timelineRevision, current.revisionAtSettle)
    ? null
    : current.turn
}
