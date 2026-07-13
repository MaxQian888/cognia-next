"use client"

/**
 * Hook: resolve the effective ConnectorMode for a platform-bound session.
 *
 * Runs the same three-layer binding lookup the bus uses:
 *   adapter row → character platformDefaults → conversation override.
 *
 * Returns `null` when the session has no platformBinding (i.e. it's a plain
 * chat session, not a connector-managed one).
 */

import { useState, useEffect } from "react"
import type { ChatSession } from "@cognia/agent-config-types"
import type { ConnectorMode } from "@/types/connectors/policy"
import { getAdapterInstance } from "@/lib/db/adapter-instances"
import { getCharacter } from "@/lib/db/characters"
import { readForResolution } from "@/lib/db/conversation-overrides"
import { resolveBinding } from "@/lib/connectors/policy-resolve"

export function useResolvedConnectorMode(
  session: ChatSession | null | undefined
): ConnectorMode | null {
  const [mode, setMode] = useState<ConnectorMode | null>(null)

  useEffect(() => {
    if (!session?.platformBinding) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMode(null)
      return
    }

    let cancelled = false
    const { adapterId, conversationKey } = session.platformBinding

    void (async () => {
      const adapterRow = await getAdapterInstance(adapterId)
      if (cancelled || !adapterRow) {
        if (!cancelled) setMode(null)
        return
      }

      const charId = session.characterId ?? adapterRow.defaultCharacterId
      const [character, override] = await Promise.all([
        charId ? getCharacter(charId).then((c) => c ?? null) : Promise.resolve(null),
        readForResolution(conversationKey).then((r) => r ?? null),
      ])
      if (cancelled) return

      const resolved = resolveBinding({ adapter: adapterRow, character, override })
      setMode(resolved.mode)
    })()

    return () => {
      cancelled = true
    }
  }, [
    session?.platformBinding,
    session?.platformBinding?.adapterId,
    session?.platformBinding?.conversationKey,
    session?.characterId,
  ])

  return mode
}
