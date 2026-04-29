import type {
  ExternalAgentBenchmarkCapabilityEntry,
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentDelegationRule,
  ExternalAgentLastRunSnapshot,
  ExternalAgentValiditySnapshot,
  CreateExternalAgentInput,
  UpdateExternalAgentInput,
} from "@/types/agent/external-agent"
import type {
  ExternalAgentSpawnConfig,
  TerminalInfo,
  TerminalOutputResult,
} from "@/lib/native/external-agent"

export interface StoredExternalAgentConfig extends Omit<
  ExternalAgentConfig,
  "createdAt" | "updatedAt"
> {
  createdAt: string
  updatedAt: string
}

/**
 * Running agent instance (runtime state)
 */
export interface RunningAgentInstance {
  id: string
  status: "running" | "stopped" | "error"
  output: string[]
  exitCode?: number
  spawnedAt: number
}

/**
 * ACP Terminal instance (runtime state)
 */
export interface TerminalInstance {
  id: string
  sessionId: string
  command: string
  isRunning: boolean
  output: string
  exitCode: number | null
  createdAt: number
}

/**
 * External agent store state
 */
export interface ExternalAgentState {
  /** Stored agent configurations */
  agents: Record<string, StoredExternalAgentConfig>
  /** Connection status for each agent */
  connectionStatus: Record<string, ExternalAgentConnectionStatus>
  /** Runtime validity snapshot for each agent (projected from manager/hook) */
  agentValidity: Record<string, ExternalAgentValiditySnapshot>
  /** Benchmark capability map for external-agent adaptation tracking */
  benchmarkCapabilityMap: Record<string, ExternalAgentBenchmarkCapabilityEntry[]>
  /** Durable last-run snapshot for each agent */
  lastRunSnapshots: Record<string, ExternalAgentLastRunSnapshot>
  /** Currently active agent ID */
  activeAgentId: string | null
  /** Delegation rules */
  delegationRules: ExternalAgentDelegationRule[]
  /** Whether external agents are globally enabled */
  enabled: boolean
  /** Default permission mode */
  defaultPermissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan"
  /** Auto-connect on startup */
  autoConnectOnStartup: boolean
  /** Show connection notifications */
  showConnectionNotifications: boolean
  /** Chat-time failure handling policy for external agent execution */
  chatFailurePolicy: "fallback" | "strict"

  // Runtime state (spawned processes)
  /** Running agent instances */
  runningAgents: Record<string, RunningAgentInstance>
  /** Running agent IDs */
  runningAgentIds: string[]
  /** ACP Terminal instances */
  terminals: Record<string, TerminalInstance>
  /** Terminal IDs */
  terminalIds: string[]
  /** Loading state for async operations */
  isLoading: boolean
  /** Last error message */
  lastError: string | null
}

/**
 * External agent store actions
 */
export interface ExternalAgentActions {
  // Agent CRUD
  addAgent: (input: CreateExternalAgentInput) => string
  addAgentFromPreset: (
    presetId: string,
    overrides?: Partial<CreateExternalAgentInput>
  ) => string | null
  updateAgent: (id: string, updates: UpdateExternalAgentInput) => void
  removeAgent: (id: string) => void
  getAgent: (id: string) => ExternalAgentConfig | undefined
  getAllAgents: () => ExternalAgentConfig[]

  // Connection status
  setConnectionStatus: (id: string, status: ExternalAgentConnectionStatus) => void
  getConnectionStatus: (id: string) => ExternalAgentConnectionStatus
  setAgentValidity: (id: string, snapshot: ExternalAgentValiditySnapshot) => void
  getAgentValidity: (id: string) => ExternalAgentValiditySnapshot | undefined
  setLastRunSnapshot: (id: string, snapshot: ExternalAgentLastRunSnapshot) => void
  getLastRunSnapshot: (id: string) => ExternalAgentLastRunSnapshot | undefined
  setBenchmarkCapabilities: (id: string, entries: ExternalAgentBenchmarkCapabilityEntry[]) => void
  upsertBenchmarkCapability: (id: string, entry: ExternalAgentBenchmarkCapabilityEntry) => void
  getBenchmarkCapabilities: (id: string) => ExternalAgentBenchmarkCapabilityEntry[]

  // Active agent
  setActiveAgent: (id: string | null) => void

  // Delegation rules
  addDelegationRule: (rule: Omit<ExternalAgentDelegationRule, "id">) => string
  updateDelegationRule: (id: string, updates: Partial<ExternalAgentDelegationRule>) => void
  removeDelegationRule: (id: string) => void
  reorderDelegationRules: (ruleIds: string[]) => void

  // Settings
  setEnabled: (enabled: boolean) => void
  setDefaultPermissionMode: (mode: ExternalAgentState["defaultPermissionMode"]) => void
  setAutoConnectOnStartup: (enabled: boolean) => void
  setShowConnectionNotifications: (enabled: boolean) => void
  setChatFailurePolicy: (policy: ExternalAgentState["chatFailurePolicy"]) => void

  // Bulk operations
  importAgents: (agents: ExternalAgentConfig[]) => void
  exportAgents: () => ExternalAgentConfig[]
  clearAllAgents: () => void

  // Reset
  reset: () => void

  // Runtime Operations - Spawned Agents
  spawnAgent: (config: ExternalAgentSpawnConfig) => Promise<string>
  sendToAgent: (agentId: string, message: string) => Promise<void>
  killRunningAgent: (agentId: string) => Promise<void>
  getRunningAgentStatus: (agentId: string) => Promise<string>
  refreshRunningAgents: () => Promise<void>
  killAllRunningAgents: () => Promise<void>

  // Runtime Operations - ACP Terminals
  createTerminal: (
    sessionId: string,
    command: string,
    args?: string[],
    cwd?: string
  ) => Promise<string>
  writeToTerminal: (terminalId: string, data: string) => Promise<void>
  getTerminalOutput: (terminalId: string) => Promise<TerminalOutputResult>
  killTerminal: (terminalId: string) => Promise<void>
  releaseTerminal: (terminalId: string) => Promise<void>
  waitForTerminalExit: (terminalId: string, timeout?: number) => Promise<number | null>
  getSessionTerminals: (sessionId: string) => Promise<string[]>
  killSessionTerminals: (sessionId: string) => Promise<void>
  isTerminalRunning: (terminalId: string) => Promise<boolean>
  getTerminalInfo: (terminalId: string) => Promise<TerminalInfo>
  refreshTerminals: () => Promise<void>

  // Error handling
  clearLastError: () => void
}

/**
 * Combined store type
 */
export type ExternalAgentStore = ExternalAgentState & ExternalAgentActions
