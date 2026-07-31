// React shell for the multi-turn pet chat panel. The transcript is the durable
// `petConversation` history read via `useLiveQuery` (read-only — no cold-Dexie
// ReadOnlyError). `send` orchestrates one turn through the pure
// `respondAsPet` and surfaces WHY a turn degraded (the bubble path is silent).
// Main window only — the panel lives on the `/pet` console route.
//
// Optimistic echo: the user's text shows as `pending` while in flight; on a
// successful reply it clears (the recorded turn arrives via the live query); on
// a degrade it STAYS visible under a reason banner so the message isn't lost.

"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { useLocale } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"

import { listRecentPetTurns } from "@/lib/db/pet-conversation"
import { respondAsPet, type PetChatDegradeReason } from "@/lib/pet/chat/respond"
import { usePetStore } from "@/stores/pet/pet-store"
import { useSettingsStore } from "@/stores/settings"
import type { PetConversationRow, PetProfile } from "@/types/pet"
import type { PetView } from "@/lib/pet/runtime/pet-view"

/** Newest-N turns shown in the transcript. */
export const CHAT_TRANSCRIPT_LIMIT = 50

export interface UsePetChatArgs {
  profile: PetProfile | undefined
  view: PetView | undefined
  activeCharacterId?: string | null
}

export interface UsePetChatDeps {
  respond?: typeof respondAsPet
  now?: () => number
}

export interface UsePetChat {
  turns: PetConversationRow[]
  /** In-flight (or last-degraded) user text shown optimistically, else null. */
  pending: string | null
  degradeReason: PetChatDegradeReason | null
  inFlight: boolean
  send: (text: string) => Promise<void>
}

export function usePetChat(
  { profile, view, activeCharacterId }: UsePetChatArgs,
  deps: UsePetChatDeps = {}
): UsePetChat {
  const locale = useLocale()
  const appSettings = useSettingsStore((s) => s.settings)
  const turns = useLiveQuery(() => listRecentPetTurns(CHAT_TRANSCRIPT_LIMIT), [], [])

  const [pending, setPending] = useState<string | null>(null)
  const [degradeReason, setDegradeReason] = useState<PetChatDegradeReason | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const inFlightRef = useRef(false)

  const respond = deps.respond ?? respondAsPet
  // Stable clock: the `?? (() => Date.now())` fallback would otherwise be a
  // fresh function every render, invalidating `send`'s memoization each time.
  const now = useMemo(() => deps.now ?? (() => Date.now()), [deps.now])

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim()
      if (!text || inFlightRef.current) return
      inFlightRef.current = true
      setInFlight(true)
      setDegradeReason(null)
      setPending(text)

      const result = await respond(
        { userText: text, view, profile, appSettings, locale, activeCharacterId, at: now() },
        {}
      )

      if (result.status === "ok") {
        // The recorded turn now flows in through the live query.
        setPending(null)
        if (result.emotion) usePetStore.getState().enqueueOneShot(result.emotion)
      } else {
        // Keep `pending` visible so the failed message isn't lost.
        setDegradeReason(result.reason)
      }
      inFlightRef.current = false
      setInFlight(false)
    },
    [view, profile, appSettings, locale, activeCharacterId, respond, now]
  )

  return { turns: turns ?? [], pending, degradeReason, inFlight, send }
}
