"use client"

/**
 * The files one finished turn changed, read live from the turn record the
 * code-adoption tracker stamps with the turn's closing message
 * (`lib/code-adoption/turn-tracker.ts`). The record lands a moment after the
 * turn settles, and an undo rewrites it, so this is a live query rather than a
 * one-shot read.
 */

import { useLiveQuery } from "dexie-react-hooks"

import { getCodeAdoptionTurnForMessage } from "@/lib/code-adoption/persist"
import type { CodeAdoptionTurnRow } from "@/lib/code-adoption/types"

export function useTurnChanges(
  sessionId: string | null | undefined,
  messageId: string,
  enabled: boolean
): CodeAdoptionTurnRow | null {
  const row = useLiveQuery(
    async () =>
      enabled && sessionId
        ? ((await getCodeAdoptionTurnForMessage(sessionId, messageId)) ?? null)
        : null,
    [enabled, sessionId, messageId]
  )
  return row ?? null
}
