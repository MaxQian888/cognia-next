/**
 * Shared helper for applying an agent mode switch to a session update payload.
 *
 * Both the welcome surface and the in-chat header must produce identical session
 * state when the user selects the same mode.  Centralising the logic here
 * prevents the two entry points from drifting again.
 */
import type { AgentModeConfig } from "@/types/agent/agent-mode"

export interface AgentModeSessionFields {
  agentModeId: string
  model?: string
  temperature?: number
  maxTokens?: number
}

/**
 * Build the session-update fields for an agent mode switch.
 * Handles both built-in modes (no overrides) and custom modes
 * (which may carry modelOverride, temperatureOverride, maxTokensOverride).
 */
export function buildAgentModeSessionUpdate(agentMode: AgentModeConfig): AgentModeSessionFields {
  // The mode's prompt is not a session field: the send path reads it off the
  // turn's preset and resolves a built-in one through the Prompt Center.
  const update: AgentModeSessionFields = { agentModeId: agentMode.id }

  if ("modelOverride" in agentMode && agentMode.modelOverride) {
    update.model = agentMode.modelOverride as string
  }
  if (
    "temperatureOverride" in agentMode &&
    (agentMode as Record<string, unknown>).temperatureOverride !== undefined
  ) {
    update.temperature = (agentMode as Record<string, unknown>).temperatureOverride as number
  }
  if (
    "maxTokensOverride" in agentMode &&
    (agentMode as Record<string, unknown>).maxTokensOverride !== undefined
  ) {
    update.maxTokens = (agentMode as Record<string, unknown>).maxTokensOverride as number
  }

  return update
}
