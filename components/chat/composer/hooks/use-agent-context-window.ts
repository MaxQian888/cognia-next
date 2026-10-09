"use client"

/**
 * The context window of the model an external agent runs for this
 * conversation, as the agent's own catalog reports it.
 *
 * Feeds the composer's context ring before the first turn: without it the ring
 * sized itself from the built-in catalog until a turn reported a window (a 1M
 * agent model read as 200K). A window a turn reports still wins
 * (`computeContextWindowUsage`). `undefined` off an agent's lane, and for a
 * model the catalog says nothing about.
 */

import { useExternalAgentModels } from "@/hooks/agent/use-external-agent-models"
import { useExternalAgentActiveModel } from "@/hooks/agent/use-external-agent-active-model"
import type { ChatSession } from "@cognia/agent-config-types"

export function useAgentContextWindow(session: ChatSession | null | undefined): number | undefined {
  const agentModels = useExternalAgentModels(session?.id)
  const active = useExternalAgentActiveModel(agentModels.agentId, session, agentModels.surface)
  return agentModels.agentId ? active.model?.capabilities?.contextWindow : undefined
}
