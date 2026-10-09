/**
 * The store-reading half of {@link resolveActiveAgentModel}: which of its own
 * models an external agent runs for a conversation, and what its catalog says
 * about that model.
 *
 * Kept outside React so a synchronous reader (`effortSurfaceForSession`, which a
 * plugin's effort dial calls) composes the same answer as the composer's hook,
 * `useExternalAgentActiveModel`. Both read the same three places the model
 * picker reads: the conversation row, the agent configuration's own Cognia
 * binding, and the app defaults.
 */

import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import { useSettingsStore } from "@/stores/settings"
import {
  resolveActiveAgentModel,
  resolveExternalAgentModelSelection,
  type ActiveAgentModel,
  type ExternalAgentModelSelectionInput,
  type ExternalAgentModelSurface,
} from "./session-models"

/** The selection inputs a conversation's agent model resolves from, read now. */
export function agentModelSelectionInput(
  agentId: string,
  session: ExternalAgentModelSelectionInput["session"]
): ExternalAgentModelSelectionInput {
  const agent = useExternalAgentStore.getState().agents[agentId]
  const settings = useSettingsStore.getState().settings
  return {
    agentId,
    session,
    // `undefined` for a configuration the paired Host owns: its default is
    // the Host's to apply, and this client does not know it.
    ...(agent ? { agentDefault: agent.cogniaModel ?? null } : {}),
    appDefaults: {
      externalAgentModelDefaults: settings?.externalAgentModelDefaults,
      defaultModel: settings?.defaultModel,
      defaultProvider: settings?.defaultProvider,
    },
  }
}

/** {@link resolveActiveAgentModel} over the stores, for `agentId`'s lane. */
export function activeAgentModelFor(
  agentId: string,
  session: ExternalAgentModelSelectionInput["session"],
  surface: ExternalAgentModelSurface | null | undefined
): ActiveAgentModel {
  const { choice } = resolveExternalAgentModelSelection(agentModelSelectionInput(agentId, session))
  return resolveActiveAgentModel({ choice, surface })
}
