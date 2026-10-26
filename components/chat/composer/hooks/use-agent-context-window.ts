"use client"

/**
 * The context window of the model an external agent runs for this
 * conversation, from its native catalog or its selected Cognia binding.
 *
 * Feeds the composer's context ring before the first turn: without it the ring
 * sized itself from the built-in catalog until a turn reported a window (a 1M
 * agent model read as 200K). Cognia bindings own their configured window;
 * native catalogs are a fallback until a turn reports its runtime window.
 * An unknown Cognia capacity retains its source so old usage cannot size it.
 */

import { useExternalAgentModels } from "@/hooks/agent/use-external-agent-models"
import { useExternalAgentActiveModel } from "@/hooks/agent/use-external-agent-active-model"
import { resolveModelMeta } from "@/lib/ai/model-options"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@cognia/agent-config-types"

export interface AgentContextWindow {
  maxTokens?: number
  source: "cognia" | "native"
}

export function useAgentContextWindow(
  session: ChatSession | null | undefined
): AgentContextWindow | undefined {
  const agentModels = useExternalAgentModels(session?.id)
  const active = useExternalAgentActiveModel(agentModels.agentId, session, agentModels.surface)
  const providerSettings = useSettingsStore((s) => s.settings?.providerSettings)
  const customProviders = useSettingsStore((s) => s.settings?.customProviders)
  if (!agentModels.agentId) return undefined
  if (active.cognia) {
    const meta = resolveModelMeta(
      active.cognia.providerId,
      active.cognia.modelId,
      providerSettings,
      customProviders
    )
    // Match the window buildGatewayTaskConfig configures for the DSH route.
    return {
      maxTokens: meta.contextLength
        ? Math.min(meta.contextLength, meta.maxInputTokens ?? meta.contextLength)
        : undefined,
      source: "cognia",
    }
  }
  const maxTokens = active.model?.capabilities?.contextWindow
  return maxTokens === undefined ? undefined : { maxTokens, source: "native" }
}
