/**
 * Resolve an Agent Mode record by id.
 *
 * Extracted from `lib/claude/build-options.ts`, which was its only caller until
 * `lib/claude/turn-agent-mode.ts` needed the same three-source lookup. The
 * precedence — built-in registry, then the user's custom modes, then enabled
 * plugin contributions — is the definition of "which record does this id name",
 * and having two copies of it is how the send path and the pickers disagree.
 */

import { BUILT_IN_AGENT_MODES } from "@/types/agent/agent-mode"
import { useCustomModeStore } from "@/stores/agent/custom-mode-store"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import type { AgentModeConfig } from "@/types/agent/agent-mode"

/** Returns `undefined` when no mode is active or the id is unknown. */
export function resolveActiveAgentMode(
  modeId: string | undefined | null
): AgentModeConfig | undefined {
  if (!modeId) return undefined
  const builtIn = BUILT_IN_AGENT_MODES.find((m) => m.id === modeId)
  if (builtIn) return builtIn
  // Custom modes live in a Zustand store that's persisted to localStorage.
  // Reading via getState() is safe here because this only runs client-side.
  const custom = useCustomModeStore.getState().customModes[modeId]
  if (custom) return custom
  return usePluginStore
    .getState()
    .getAllModes()
    .find((mode) => mode.id === modeId)
}
