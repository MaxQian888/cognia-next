/**
 * The plugin contract's share of `lib/plugin/api/external-agents-api.ts`, which re-exports these.
 */
import type {
  AcpPermissionMode,
  CodexAgentOptions,
  ExternalAgentCogniaModelBinding,
  ExternalAgentConnectionStatus,
  ExternalAgentDelegationRule,
  ExternalAgentProtocol,
  ExternalAgentRetryConfig,
  ExternalAgentStateIsolation,
  ExternalAgentTransport,
} from "../../../types/agent/external-agent"
import type { AgentModelRoleOverrides } from "@cognia/agent-contracts/model-binding"
import type {
  AgentReadinessAction,
  AgentReadinessState,
  AgentReadinessStep,
} from "../../ai/agent/external/agent-readiness"
import type {
  ExternalAgentCapabilityId,
  ExternalAgentCapabilityLevel,
} from "@cognia/agent-config-types/external-agent-capability"
import type { ExternalAgentChangeEvent } from "./external-agents-changes"
import type {
  ExternalAgentCredentialSlot,
  ExternalAgentLifecycleErrorCode,
  ExternalAgentLifecycleStatus,
} from "../../../types/agent/external-agent-lifecycle"
import type { ExternalAgentStore } from "../../../stores/agent/external-agent-store/types"
import type { RuntimeResolution } from "../../ai/agent/external/config/installed-runtimes"

/** The projected readiness of one configuration (the Settings row model). */
export interface PluginExternalAgentReadinessSummary {
  state: AgentReadinessState
  nextAction: AgentReadinessAction | null
  blockReason: string | null
}

/** A configuration as a plugin sees it. Never carries a secret. */
export interface PluginExternalAgentSummary {
  id: string
  name: string
  description: string | null
  protocol: ExternalAgentProtocol
  transport: ExternalAgentTransport
  enabled: boolean
  /** The preset it was created from (`metadata.preset`), if any. */
  presetId: string | null
  /** Absent on the stored config means `shared`. */
  stateIsolation: ExternalAgentStateIsolation
  duplicatedFromAgentId: string | null
  createdByPluginId: string | null
  defaultPermissionMode: AcpPermissionMode | null
  /** Command, arguments (credential-looking values redacted) and working directory. Never env. */
  process: { command: string; args: string[]; cwd: string | null } | null
  /** The endpoint, with any URL credential redacted. Never headers or proxy settings. */
  network: { endpoint: string } | null
  cogniaModel: ExternalAgentCogniaModelBinding | null
  modelRoles: AgentModelRoleOverrides | null
  /** The bound subscription account id; `null` follows the active account. */
  subscriptionAccountId: string | null
  maxConcurrentSessions: number | null
  sessionIdleTimeout: number | null
  timeout: number | null
  tags: string[]
  connectionStatus: ExternalAgentConnectionStatus
  readiness: PluginExternalAgentReadinessSummary
  lifecycleStatus: ExternalAgentLifecycleStatus | null
  lifecycleReasonCode: ExternalAgentLifecycleErrorCode | null
  /** Credential slots the user has filled. Names only, never values. */
  credentialSlots: ExternalAgentCredentialSlot[]
  createdAt: string | null
  updatedAt: string | null
}

/** Full readiness: the row model plus the lifecycle service's live verdict. */
export interface PluginExternalAgentReadiness extends PluginExternalAgentReadinessSummary {
  agentId: string
  blockTransient: boolean
  steps: AgentReadinessStep[]
  /** `assessReadiness` run now: platform, adapter, consent, credentials. */
  verdict: {
    status: ExternalAgentLifecycleStatus
    reasonCode: ExternalAgentLifecycleErrorCode | null
    reason: string | null
  }
}

export interface PluginExternalAgentPreset {
  id: string
  name: string
  description: string
  protocol: ExternalAgentProtocol
  transport: ExternalAgentTransport
  /** False for documented-only presets: discoverable, never creatable. */
  runnable: boolean
  supportTier: string | null
  defaultPermissionMode: AcpPermissionMode
  tags: string[]
  docsUrl: string | null
  envVarHint: string | null
  setupHint: string | null
  /** The plugin that contributed it; `null` for a built-in preset. */
  contributedByPluginId: string | null
}

export interface PluginExternalAgentRuntime {
  runtimeId: string
  command: string | null
  resolution: RuntimeResolution
  executablePath: string | null
  version: string | null
}

export interface PluginExternalAgentRuntimeReport {
  /**
   * False when no host that could start an agent is reachable from here (a
   * browser with no paired Host). `runtimes` is then empty, which is not the
   * same claim as "every runtime is missing".
   */
  available: boolean
  runtimes: PluginExternalAgentRuntime[]
}

export interface PluginExternalAgentSettings {
  defaultPermissionMode: ExternalAgentStore["defaultPermissionMode"]
  autoConnectOnStartup: boolean
  showConnectionNotifications: boolean
  chatFailurePolicy: ExternalAgentStore["chatFailurePolicy"]
}

export type PluginExternalAgentDelegationRule = ExternalAgentDelegationRule

export type PluginExternalAgentDelegationRuleInput = Omit<ExternalAgentDelegationRule, "id">

/** Process fields a plugin may set. Env names that look secret are refused. */
export interface PluginExternalAgentProcessInput {
  command?: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
  bare?: boolean
  debug?: boolean
}

/** OpenCode connection metadata a plugin may set. `serverPassword` is refused. */
export interface PluginExternalAgentMetadataInput {
  autoSpawnServer?: boolean
  port?: number
  hostname?: string
  serverUsername?: string
  model?: string
}

export interface PluginExternalAgentSharedInput {
  name?: string
  description?: string
  /** Default `true`. A created config registers (and connects) when enabled. */
  enabled?: boolean
  /** Default `isolated` (ADR-0216). */
  stateIsolation?: ExternalAgentStateIsolation
  subscriptionAccountId?: string | null
  /** Adapted to what the protocol can enforce, never upward. */
  defaultPermissionMode?: AcpPermissionMode
  process?: PluginExternalAgentProcessInput
  network?: { endpoint: string }
  cogniaModel?: ExternalAgentCogniaModelBinding | null
  modelRoles?: AgentModelRoleOverrides
  timeout?: number
  retryConfig?: Partial<ExternalAgentRetryConfig>
  maxConcurrentSessions?: number
  sessionIdleTimeout?: number
  tags?: string[]
  codexOptions?: CodexAgentOptions
  declaredCapabilities?: Partial<Record<ExternalAgentCapabilityId, ExternalAgentCapabilityLevel>>
  metadata?: PluginExternalAgentMetadataInput
}

export interface PluginExternalAgentCreateInput extends PluginExternalAgentSharedInput {
  name: string
  protocol: ExternalAgentProtocol
  /** Defaults to what the protocol needs (`sse` for OpenCode, `http` for A2A, else `stdio`). */
  transport?: ExternalAgentTransport
}

export type PluginExternalAgentPresetOverrides = PluginExternalAgentSharedInput

/** The secret-free edit surface. Env, headers and every credential stay in Settings. */
export interface PluginExternalAgentUpdatePatch {
  name?: string
  description?: string
  enabled?: boolean
  defaultPermissionMode?: AcpPermissionMode
  process?: { command?: string; args?: string[]; cwd?: string }
  network?: { endpoint: string }
  timeout?: number
  retryConfig?: Partial<ExternalAgentRetryConfig>
  codexOptions?: CodexAgentOptions
  cogniaModel?: ExternalAgentCogniaModelBinding | null
  modelRoles?: AgentModelRoleOverrides | null
  stateIsolation?: ExternalAgentStateIsolation
  subscriptionAccountId?: string | null
  maxConcurrentSessions?: number
  sessionIdleTimeout?: number
  tags?: string[]
  declaredCapabilities?: Partial<Record<ExternalAgentCapabilityId, ExternalAgentCapabilityLevel>>
}

export interface PluginExternalAgentDuplicateOptions {
  /** Defaults to the first free localized "<name> (copy)" / "(copy 2)" … */
  name?: string
  /** Defaults to `isolated`. */
  stateIsolation?: ExternalAgentStateIsolation
  /** Defaults to the source's state. A duplicate is never auto-connected. */
  enabled?: boolean
}

export type PluginExternalAgentSettingsPatch = Partial<PluginExternalAgentSettings>

/** External-agent configuration API exposed to plugins as `ctx.externalAgents`. */
export interface PluginExternalAgentsAPI {
  // ------------------------------------------------- reads (agent:external:read)
  /** Every configuration, projected. */
  list(): Promise<PluginExternalAgentSummary[]>
  /** One configuration, or `null` when the id names none. */
  get(id: string): Promise<PluginExternalAgentSummary | null>
  /** Row readiness plus the lifecycle service's verdict, computed now. */
  getReadiness(id: string): Promise<PluginExternalAgentReadiness>
  /** Built-in and plugin-contributed presets. */
  listPresets(): Promise<PluginExternalAgentPreset[]>
  /** What the machine that will run agents has installed. */
  listRuntimes(options?: { refresh?: boolean }): Promise<PluginExternalAgentRuntimeReport>
  getSettings(): Promise<PluginExternalAgentSettings>
  listDelegationRules(): Promise<PluginExternalAgentDelegationRule[]>
  /**
   * Observe configuration, connection, settings and delegation changes.
   * Returns a disposer; the plugin scope also releases it on disable.
   * TypeScript only — Python plugins declare the `onExternalAgentConfigChange` hook.
   */
  onChange(listener: (event: ExternalAgentChangeEvent) => void): () => void

  // --------------------------------------------- writes (agent:external:manage)
  create(input: PluginExternalAgentCreateInput): Promise<PluginExternalAgentSummary>
  createFromPreset(
    presetId: string,
    overrides?: PluginExternalAgentPresetOverrides
  ): Promise<PluginExternalAgentSummary>
  update(id: string, patch: PluginExternalAgentUpdatePatch): Promise<PluginExternalAgentSummary>
  duplicate(
    id: string,
    options?: PluginExternalAgentDuplicateOptions
  ): Promise<PluginExternalAgentSummary>
  remove(id: string): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<PluginExternalAgentSummary>
  connect(id: string): Promise<PluginExternalAgentSummary>
  disconnect(id: string): Promise<PluginExternalAgentSummary>
  addDelegationRule(
    rule: PluginExternalAgentDelegationRuleInput
  ): Promise<PluginExternalAgentDelegationRule>
  updateDelegationRule(
    id: string,
    patch: Partial<PluginExternalAgentDelegationRuleInput>
  ): Promise<PluginExternalAgentDelegationRule>
  removeDelegationRule(id: string): Promise<void>
  /** `ruleIds` must name every rule exactly once; the first gets the highest priority. */
  reorderDelegationRules(ruleIds: string[]): Promise<PluginExternalAgentDelegationRule[]>
  updateSettings(patch: PluginExternalAgentSettingsPatch): Promise<PluginExternalAgentSettings>
}

export type PluginExternalAgentInputErrorCode =
  "inline_credentials" | "invalid_input" | "unknown_agent" | "unknown_preset" | "unknown_rule"
