import type { ExternalAgentState } from "./types"

export const initialState: ExternalAgentState = {
  agents: {},
  connectionStatus: {},
  agentValidity: {},
  benchmarkCapabilityMap: {},
  lastRunSnapshots: {},
  activeAgentId: null,
  delegationRules: [],
  enabled: true,
  defaultPermissionMode: "default",
  autoConnectOnStartup: false,
  showConnectionNotifications: true,
  chatFailurePolicy: "fallback",
  // Runtime state
  runningAgents: {},
  runningAgentIds: [],
  terminals: {},
  terminalIds: [],
  isLoading: false,
  lastError: null,
  agentFailures: {},
}
