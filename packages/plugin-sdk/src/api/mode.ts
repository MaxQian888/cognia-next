/**
 * Plugin SDK - `mode` capability surface.
 *
 * Re-exports the declarative mode authoring helper and the built-in mode
 * catalog helpers used by the agent runtime.
 */

export { defineMode } from "../define/define-mode"

export { BUILT_IN_AGENT_MODES, getAgentMode, getAgentModeByType } from "@/lib/agent/modes/built-ins"

export type {
  AgentModeConfig,
  AgentModeType,
  CustomAgentMode,
} from "@cognia/plugin-contract/types/agent/agent-mode"
export type { PluginModeDef } from "@/types/plugin"
