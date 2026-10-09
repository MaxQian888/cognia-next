// Pet chat with the DESKTOP's pet from a paired device (ADR-0219).
//
// The transcript is not mirrored (`petConversationV2` holds the user's own
// words and stays on the desktop), so this reads it live with `pet_chat_list`
// and sends each turn with `pet_chat_send`, which runs `respondAsPet` on the
// desktop with its settings, PII gate and speak limiter.
//
// A reply can outlive the bridge window: the desktop then answers `pending`
// and records the turn when it lands. The user's text stays on screen as
// pending, with a note that the reply is coming, and the transcript is polled
// a few times until the recorded turn appears. A later refresh (re-entering
// the tab, the window regaining focus) settles it too.
//
// Returns outcomes and never toasts: the remote actions hook decides what the
// user is told.

"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CHAT_TRANSCRIPT_LIMIT } from "@/hooks/pet/use-pet-chat"
import type { PetRemoteClient } from "@/lib/pet/remote/client"
import { livePetRemoteClient } from "@/lib/pet/remote/live-transport"
import type { PetChatLocale, PetRemoteChatTurn } from "@/lib/pet/remote/types"
import type { PetChatDegradeReason } from "@/lib/pet/chat/respond"
import {
  PET_ACTION_OK,
  PET_REMOTE_UNREACHABLE,
  petActionFailed,
  petRemoteRefusalMessage,
  type PetActionOutcome,
} from "@/lib/pet/console/outcome-messages"
import type { PetConversationRow } from "@/types/pet"

/** When to look for a reply the desktop answered `pending`, after sending. */
export const REMOTE_CHAT_PENDING_POLLS_MS: readonly number[] = [3_000, 7_000, 15_000, 30_000]

export interface UseRemotePetChatDeps {
  getClient?: () => PetRemoteClient
  now?: () => number
  pendingPollsMs?: readonly number[]
}

export interface RemotePetChat {
  /** Undefined until the first list arrives. */
  turns: PetConversationRow[] | undefined
  /** The text being sent, or left on screen after a degrade / a pending reply. */
  pending: string | null
  inFlight: boolean
  degradeReason: PetChatDegradeReason | null
  /** The desktop accepted the turn and is still producing the reply. */
  awaitingReply: boolean
  refresh: () => Promise<PetActionOutcome>
  send: (text: string) => Promise<PetActionOutcome>
  clear: () => Promise<PetActionOutcome>
}

const systemNow = () => Date.now()

function toRow(turn: PetRemoteChatTurn): PetConversationRow {
  return { id: turn.id, at: turn.at, userText: turn.userText, reply: turn.reply }
}

export function useRemotePetChat(
  { enabled, locale }: { enabled: boolean; locale: PetChatLocale },
  deps: UseRemotePetChatDeps = {}
): RemotePetChat {
  const getClient = deps.getClient ?? livePetRemoteClient
  const now = deps.now ?? systemNow
  const polls = deps.pendingPollsMs ?? REMOTE_CHAT_PENDING_POLLS_MS

  const [turns, setTurns] = useState<PetConversationRow[] | undefined>(undefined)
  const [pending, setPending] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [degradeReason, setDegradeReason] = useState<PetChatDegradeReason | null>(null)
  const [awaitingReply, setAwaitingReply] = useState(false)

  const inFlightRef = useRef(false)
  const mounted = useRef(true)
  // The turn the desktop is still answering: its text and when it was sent.
  const awaiting = useRef<{ text: string; sentAt: number } | null>(null)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    mounted.current = true
    const pendingTimers = timers.current
    return () => {
      mounted.current = false
      for (const timer of pendingTimers) clearTimeout(timer)
      pendingTimers.clear()
    }
  }, [])

  const stopPolling = useCallback(() => {
    for (const timer of timers.current) clearTimeout(timer)
    timers.current.clear()
  }, [])

  const refresh = useCallback(async (): Promise<PetActionOutcome> => {
    if (!enabled) return PET_ACTION_OK
    try {
      const page = await getClient().listChat({ pageSize: CHAT_TRANSCRIPT_LIMIT })
      if (!mounted.current) return PET_ACTION_OK
      const rows = page.items.map(toRow)
      setTurns(rows)
      // The pending reply has landed once a turn with the sent text was
      // recorded at or after the send.
      const waiting = awaiting.current
      if (
        waiting &&
        rows.some((row) => row.userText === waiting.text && row.at >= waiting.sentAt - 60_000)
      ) {
        awaiting.current = null
        stopPolling()
        setAwaitingReply(false)
        setPending(null)
      }
      return PET_ACTION_OK
    } catch {
      return petActionFailed("unreachable", PET_REMOTE_UNREACHABLE)
    }
  }, [enabled, getClient, stopPolling])

  const send = useCallback(
    async (raw: string): Promise<PetActionOutcome> => {
      const text = raw.trim()
      if (!text || inFlightRef.current) return PET_ACTION_OK
      inFlightRef.current = true
      setInFlight(true)
      setDegradeReason(null)
      setAwaitingReply(false)
      awaiting.current = null
      stopPolling()
      setPending(text)
      const sentAt = now()
      try {
        const result = await getClient().sendChat(text, locale)
        if (!mounted.current) return PET_ACTION_OK
        if (!result.ok) {
          setPending(null)
          return petActionFailed("refused", petRemoteRefusalMessage(result.refusal))
        }
        if (result.status === "replied") {
          // Shown at once; the refresh below swaps in the desktop's own row.
          setTurns((previous) => [
            ...(previous ?? []),
            { id: `pending:${sentAt}`, at: sentAt, userText: text, reply: result.reply },
          ])
          setPending(null)
          void refresh()
          return PET_ACTION_OK
        }
        if (result.status === "degraded") {
          // Kept on screen under the reason, as the desktop console does.
          setDegradeReason(result.reason)
          return PET_ACTION_OK
        }
        awaiting.current = { text, sentAt }
        setAwaitingReply(true)
        for (const delay of polls) {
          const timer = setTimeout(() => {
            timers.current.delete(timer)
            void refresh()
          }, delay)
          timers.current.add(timer)
        }
        return { ok: true, pending: true }
      } catch {
        if (mounted.current) setPending(null)
        return petActionFailed("unreachable", PET_REMOTE_UNREACHABLE)
      } finally {
        inFlightRef.current = false
        if (mounted.current) setInFlight(false)
      }
    },
    [getClient, locale, now, polls, refresh, stopPolling]
  )

  const clear = useCallback(async (): Promise<PetActionOutcome> => {
    try {
      const result = await getClient().clearChat()
      if (!result.ok) return petActionFailed("refused", petRemoteRefusalMessage(result.refusal))
      if (mounted.current) {
        awaiting.current = null
        stopPolling()
        setTurns([])
        setPending(null)
        setDegradeReason(null)
        setAwaitingReply(false)
      }
      return PET_ACTION_OK
    } catch {
      return petActionFailed("unreachable", PET_REMOTE_UNREACHABLE)
    }
  }, [getClient, stopPolling])

  return { turns, pending, inFlight, degradeReason, awaitingReply, refresh, send, clear }
}
