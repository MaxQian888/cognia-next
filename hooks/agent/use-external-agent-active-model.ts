"use client"

/**
 * Which of its own models the external agent runs for this conversation, and
 * what the agent's catalog says about it (context window, reasoning, vision).
 *
 * The React face of `activeAgentModelFor`, over the same inputs: the agent's
 * configured Cognia binding and the three app defaults, subscribed here so a
 * pick made in the model picker re-renders every reader. The surface comes
 * from the caller, who already holds a `useExternalAgentModels` result.
 */

import { useMemo } from "react"

import {
  resolveActiveAgentModel,
  resolveExternalAgentModelSelection,
  type ActiveAgentModel,
  type ExternalAgentModelSurface,
} from "@/lib/ai/agent/external/session/session-models"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useSettingsStore } from "@/stores/settings"
import type { ChatSession } from "@cognia/agent-config-types"

const NONE: ActiveAgentModel = Object.freeze({ modelId: undefined, model: undefined })

export function useExternalAgentActiveModel(
  agentId: string | null,
  session: ChatSession | null | undefined,
  surface: ExternalAgentModelSurface | null | undefined
): ActiveAgentModel {
  const agentDefault = useExternalAgentStore((s) =>
    agentId && s.agents[agentId] ? (s.agents[agentId].cogniaModel ?? null) : undefined
  )
  const modelDefaults = useSettingsStore((s) => s.settings?.externalAgentModelDefaults)
  const defaultModel = useSettingsStore((s) => s.settings?.defaultModel)
  const defaultProvider = useSettingsStore((s) => s.settings?.defaultProvider)

  return useMemo(() => {
    if (!agentId) return NONE
    const { choice } = resolveExternalAgentModelSelection({
      agentId,
      session,
      ...(agentDefault !== undefined ? { agentDefault } : {}),
      appDefaults: { externalAgentModelDefaults: modelDefaults, defaultModel, defaultProvider },
    })
    return resolveActiveAgentModel({ choice, surface })
  }, [agentId, session, surface, agentDefault, modelDefaults, defaultModel, defaultProvider])
}
