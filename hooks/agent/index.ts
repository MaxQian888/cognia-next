/**
 * Agent hooks barrel.
 *
 * Mode resolution (built-in / custom / plugin), MCP-agent file status,
 * and external agent runtime control all live here.
 */

export {
  useAgentMode,
  type UnifiedAgentMode,
  type UseAgentModeOptions,
  type UseAgentModeResult,
} from "./use-agent-mode"

export {
  useExternalAgent,
  useExternalAgentById,
  useConnectedExternalAgents,
  useExternalAgentConnectionStatus,
  type UseExternalAgentState,
  type UseExternalAgentActions,
  type UseExternalAgentReturn,
} from "./use-external-agent"

export {
  useAgentStatuses,
  refreshAgentStatuses,
  getDetectedWritableAgents,
  type AgentStatus,
  type DriftInfo,
  type UseAgentStatusesResult,
} from "./use-agent-status"
