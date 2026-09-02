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
import type { ExternalAgentLifecycleFields } from "@/types/agent/external-agent-lifecycle"
import type { ExternalAgentFailure } from "@/lib/ai/agent/external/agent-failure"
import type {
  ExternalAgentSpawnConfig,
  TerminalInfo,
  TerminalOutputResult,
} from "@/lib/native/external-agent"

/**
 * A persisted configuration.
 *
 * Carries the lifecycle-plane fields (runtime binding, credential references,
 * reconciliation verdict, Windows consent) alongside the Agent config itself.
 * They are stored, never edited directly: {@link ExternalAgentActions.patchLifecycle}
 * is the only writer, and the lifecycle service is its only caller.
 */
export interface StoredExternalAgentConfig
  extends Omit<ExternalAgentConfig, "createdAt" | "updatedAt">, ExternalAgentLifecycleFields {
  createdAt: string
  updatedAt: string
}

/** A configuration as callers read it back, lifecycle fields included. */
export type LifecycleExternalAgentConfig = ExternalAgentConfig & ExternalAgentLifecycleFields

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
  /**
   * The most recent failure per agent, so a report can be drawn beside the
   * agent it belongs to instead of as one banner above all of them.
   *
   * Runtime only. It is absent from `partialize` deliberately: a failure
   * describes an attempt, and replaying yesterday's attempt as the current
   * state of an agent is the same mistake a stored transport verdict made.
   */
  agentFailures: Record<string, ExternalAgentFailure>
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
  getAgent: (id: string) => LifecycleExternalAgentConfig | undefined
  getAllAgents: () => LifecycleExternalAgentConfig[]
  /**
   * Replace a stored configuration wholesale, preserving only `createdAt`.
   *
   * `updateAgent` MERGES `process` and `network`, which means it can add a
   * field but never remove one — so it cannot scrub a credential out of a
   * legacy config. This can, and the credential migration is its only caller.
   */
  replaceAgentConfig: (id: string, config: LifecycleExternalAgentConfig) => void
  /**
   * Persist lifecycle-plane fields that are not part of the user edit surface.
   *
   * An explicitly `undefined` field is DELETED rather than ignored, which is
   * what makes revoking a Windows consent actually remove it.
   */
  patchLifecycle: (id: string, fields: ExternalAgentLifecycleFields) => void

  // Connection status
  setConnectionStatus: (id: string, status: ExternalAgentConnectionStatus) => void
  /** Record what just failed for one agent, replacing any earlier report. */
  recordAgentFailure: (failure: ExternalAgentFailure) => void
  /** Forget one agent's failure, or every agent's when the id is omitted. */
  clearAgentFailure: (id?: string) => void
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
