import type {
  ExternalAgentStore,
  LifecycleExternalAgentConfig,
  StoredExternalAgentConfig,
} from "./types"

// Config hydration
// ============================================================================

/**
 * The store persists `createdAt`/`updatedAt` as ISO strings; consumers expect
 * `Date`s. Hydrating inline in a selector minted a fresh config object on every
 * call, so a selector could never return an equal snapshot for unchanged state.
 * `useSyncExternalStore` re-reads the snapshot after each render and forces
 * another render whenever it changed — a never-equal snapshot is an infinite
 * render loop that hard-freezes the renderer, and `useShallow` cannot save it
 * because it compares *element* references. An empty result compares equal, so
 * this only bit once at least one agent existed.
 *
 * Keying the cache on the stored object's identity fixes that: zustand replaces
 * the stored object only when the agent actually changes, so unchanged agents
 * keep yielding the same hydrated instance, and a changed one re-hydrates.
 */
const hydratedConfigs = new WeakMap<StoredExternalAgentConfig, LifecycleExternalAgentConfig>()

export function hydrateAgentConfig(
  stored: StoredExternalAgentConfig
): LifecycleExternalAgentConfig {
  const cached = hydratedConfigs.get(stored)
  if (cached) return cached
  const hydrated: LifecycleExternalAgentConfig = {
    ...stored,
    createdAt: new Date(stored.createdAt),
    updatedAt: new Date(stored.updatedAt),
  }
  hydratedConfigs.set(stored, hydrated)
  return hydrated
}

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
    .map(([_, config]) => hydrateAgentConfig(config))

export const selectEnabledAgents = (state: ExternalAgentStore) =>
  Object.values(state.agents)
    .filter((config) => config.enabled)
    .map((config) => hydrateAgentConfig(config))

export const selectAgentById = (id: string) => (state: ExternalAgentStore) => {
  const config = state.agents[id]
  if (!config) return undefined
  return hydrateAgentConfig(config)
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
