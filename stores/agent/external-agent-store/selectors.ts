import type { ExternalAgentStore } from "./types"

// Selectors
// ============================================================================

export const selectAgents = (state: ExternalAgentStore) => state.agents
export const selectConnectionStatus = (state: ExternalAgentStore) => state.connectionStatus
export const selectAgentValidity = (state: ExternalAgentStore) => state.agentValidity
export const selectBenchmarkCapabilityMap = (state: ExternalAgentStore) =>
  state.benchmarkCapabilityMap
export const selectActiveAgentId = (state: ExternalAgentStore) => state.activeAgentId
export const selectDelegationRules = (state: ExternalAgentStore) => state.delegationRules
export const selectEnabled = (state: ExternalAgentStore) => state.enabled
export const selectDefaultPermissionMode = (state: ExternalAgentStore) =>
  state.defaultPermissionMode

export const selectConnectedAgents = (state: ExternalAgentStore) =>
  Object.entries(state.agents)
    .filter(([id]) => state.connectionStatus[id] === "connected")
    .map(([_, config]) => ({
      ...config,
      createdAt: new Date(config.createdAt),
      updatedAt: new Date(config.updatedAt),
    }))

export const selectEnabledAgents = (state: ExternalAgentStore) =>
  Object.values(state.agents)
    .filter((config) => config.enabled)
    .map((config) => ({
      ...config,
      createdAt: new Date(config.createdAt),
      updatedAt: new Date(config.updatedAt),
    }))

export const selectAgentById = (id: string) => (state: ExternalAgentStore) => {
  const config = state.agents[id]
  if (!config) return undefined
  return {
    ...config,
    createdAt: new Date(config.createdAt),
    updatedAt: new Date(config.updatedAt),
  }
}

export const selectActiveAgent = (state: ExternalAgentStore) => {
  if (!state.activeAgentId) return undefined
  return selectAgentById(state.activeAgentId)(state)
}

export const selectAgentValidityById = (id: string) => (state: ExternalAgentStore) =>
  state.agentValidity[id]
export const selectBenchmarkCapabilitiesById = (id: string) => (state: ExternalAgentStore) =>
  state.benchmarkCapabilityMap[id] || []

// Runtime selectors
export const selectRunningAgents = (state: ExternalAgentStore) =>
  state.runningAgentIds.map((id) => state.runningAgents[id]).filter(Boolean)

export const selectActiveRunningAgents = (state: ExternalAgentStore) =>
  selectRunningAgents(state).filter((agent) => agent.status === "running")

export const selectTerminals = (state: ExternalAgentStore) =>
  state.terminalIds.map((id) => state.terminals[id]).filter(Boolean)

export const selectRunningTerminals = (state: ExternalAgentStore) =>
  selectTerminals(state).filter((terminal) => terminal.isRunning)

export const selectSessionTerminals = (sessionId: string) => (state: ExternalAgentStore) =>
  selectTerminals(state).filter((terminal) => terminal.sessionId === sessionId)

export const selectIsLoading = (state: ExternalAgentStore) => state.isLoading
export const selectLastError = (state: ExternalAgentStore) => state.lastError
