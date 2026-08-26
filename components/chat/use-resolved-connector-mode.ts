"use client"

/**
 * Hook: resolve the effective ConnectorMode for a platform-bound session.
 *
 * A thin projection of {@link useResolvedBinding}, which runs the same
 * three-layer lookup the bus uses (adapter row → character `platformDefaults`
 * → conversation override). Loading the three rows lives there so the mode
 * chip and the policy read-out cannot drift into two different answers.
 *
 * Returns `null` when the session has no platformBinding (i.e. it's a plain
 * chat session, not a connector-managed one).
 */

import type { ChatSession } from "@cognia/agent-config-types"

import { useResolvedBinding } from "@/hooks/connectors/use-resolved-binding"
import type { ConnectorMode } from "@/types/connectors/policy"

export function useResolvedConnectorMode(
  session: ChatSession | null | undefined
): ConnectorMode | null {
  const binding = session?.platformBinding
  return (
    useResolvedBinding(
      binding
        ? {
            adapterId: binding.adapterId,
            conversationKey: binding.conversationKey,
            characterId: session?.characterId,
          }
        : null
    )?.mode ?? null
  )
}
