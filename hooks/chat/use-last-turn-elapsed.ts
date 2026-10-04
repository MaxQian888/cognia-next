"use client"

/**
 * `useLastTurnElapsedMs` — how long the session's most recent finished turn
 * took, for the Run Panel's "last run" summary. `null` when it is not known,
 * so the panel can omit the duration instead of printing `0s`.
 *
 * Two sources, best first:
 *
 * 1. **The live clock, banked at settle.** `RunTiming` is cleared to idle the
 *    instant a turn ends, so the panel could never read it afterwards — the
 *    summary fell back to `formatRunElapsed(0)` for every turn. This hook
 *    watches the slice and, on the transition out of a running clock, records
 *    the same *active* elapsed the ticker was showing (approval waits
 *    excluded), keyed by session and run id so it can only describe the turn
 *    it was measured on.
 * 2. **The transcript's own timestamps** (`lastTurnElapsedMs`), for a turn
 *    this mount never watched run — after a reload, a session switch, or a
 *    turn another surface drove.
 *
 * The capture is a store subscription, not an effect over `useSessionRunTiming`:
 * by the render after a turn settles the timing has already been reset, and
 * the duration has to be read from the state it was reset *from*.
 */

import { useEffect, useMemo, useState } from "react"
import type { UIMessage } from "ai"

import { toRunStatus } from "@/lib/claude/run-record"
import { activeElapsedMs, lastTurnElapsedMs } from "@/lib/claude/run-status"
import { useChatStore } from "@/stores/chat"

interface SettledTurn {
  sessionId: string
  runId: number
  elapsedMs: number
}

export interface UseLastTurnElapsedArgs {
  sessionId: string | null
  /** The slice's run id; the banked clock only answers for the run it timed. */
  runId: number
  messages: readonly UIMessage[]
  toolTimestamps?: Readonly<Record<string, { startedAt: number; endedAt?: number }>>
}

export function useLastTurnElapsedMs({
  sessionId,
  runId,
  messages,
  toolTimestamps,
}: UseLastTurnElapsedArgs): number | null {
  const [settled, setSettled] = useState<SettledTurn | null>(null)

  useEffect(() => {
    if (!sessionId) return undefined
    let previous = useChatStore.getState().sessions[sessionId]
    return useChatStore.subscribe((state) => {
      const next = state.sessions[sessionId]
      const before = previous
      previous = next
      if (!before || before === next) return
      const wasTiming = before.runTiming?.startedAt != null
      const stillTiming = next?.runTiming?.startedAt != null
      if (!wasTiming || stillTiming) return
      const elapsedMs = activeElapsedMs(before.runTiming, toRunStatus(before.status), Date.now())
      if (elapsedMs == null) return
      setSettled({ sessionId, runId: before.runId ?? 0, elapsedMs })
    })
  }, [sessionId])

  const fromTranscript = useMemo(
    () => lastTurnElapsedMs(messages, toolTimestamps),
    [messages, toolTimestamps]
  )

  if (settled && settled.sessionId === sessionId && settled.runId === runId) {
    return settled.elapsedMs
  }
  return fromTranscript
}
