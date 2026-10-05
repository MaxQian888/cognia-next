/**
 * Plugin External Agents API (`ctx.externalAgents`, ADR-0216 decision 2).
 *
 * Lets a plugin see and manage the user's external-agent configurations —
 * several configurations of one runtime, each with its own credentials and
 * (optionally) its own state root — without ever touching a credential.
 *
 * Rules this module holds, each pinned by its test:
 *
 *  - **Projections never carry a secret.** Every config a plugin reads goes
 *    through `redactConfigForLogging` (inline secrets scrubbed, keyring refs
 *    dropped, populated slot NAMES kept), then an allowlist: process env,
 *    headers and proxy settings are never projected at all, a credential-looking
 *    argument value or endpoint userinfo / query value reads back as
 *    {@link EXTERNAL_AGENT_REDACTED}.
 *  - **Inputs refuse inline credentials.** An API key, bearer token,
 *    secret-named header or env var, proxy auth, server password, credential
 *    in an endpoint URL or a credential-looking argument fails with
 *    `PluginExternalAgentInputError("inline_credentials")`. Credentials, and
 *    the Windows unsandboxed-launch consent, are entered by the user in
 *    Settings; there is no plugin path to either.
 *  - **Writes go through the lifecycle service.** Create, update, duplicate,
 *    remove, enable and connect reach `ExternalAgentLifecycleService`, which is
 *    what keeps the runtime manager, the keyring and the store in step. Only
 *    the global settings and the delegation rules — which have no runtime
 *    half — are written to the store's own actions.
 *  - **A plugin-created configuration says so**: `metadata.createdByPluginId`.
 *  - **Gated** by `agent:external:read` (reads, `onChange`) and
 *    `agent:external:manage` (every write; dangerous, consent-tier).
 */

import type {
  AcpPermissionMode,
  CodexAgentOptions,
  CreateExternalAgentInput,
  ExternalAgentCogniaModelBinding,
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentDelegationRule,
  ExternalAgentProtocol,
  ExternalAgentRetryConfig,
  ExternalAgentStateIsolation,
  ExternalAgentTransport,
  UpdateExternalAgentInput,
} from "@/types/agent/external-agent"
import type {
  ExternalAgentCredentialSlot,
  ExternalAgentLifecycleErrorCode,
  ExternalAgentLifecycleStatus,
} from "@/types/agent/external-agent-lifecycle"
import type {
  ExternalAgentCapabilityId,
  ExternalAgentCapabilityLevel,
} from "@cognia/agent-config-types/external-agent-capability"
import type { AddAgentFormData } from "@/types/agent/component-types"
import type {
  AgentReadinessAction,
  AgentReadinessState,
  AgentReadinessStep,
} from "@/lib/ai/agent/external/agent-readiness"
import type { RuntimeResolution } from "@/lib/ai/agent/external/config/installed-runtimes"
import type { ExternalAgentStore } from "@/stores/agent/external-agent-store"
import {
  extractInlineCredentials,
  occupiedSlots,
  redactConfigForLogging,
  type LifecycleAgentConfig,
} from "@/lib/ai/agent/external/lifecycle/credentials"
import { looksSecret } from "@/lib/plugin/convert/secrets"
import { createGuardedAPI } from "@/lib/plugin/security/permission-guard"
import { recordSilentFailure } from "@/lib/plugin/contracts/diagnostics-store"
import {
  EXTERNAL_AGENT_SETTING_KEYS,
  subscribeExternalAgentChanges,
  type ExternalAgentChangeEvent,
} from "./external-agents-changes"

export type {
  ExternalAgentChangeEvent as PluginExternalAgentChangeEvent,
  ExternalAgentChangeType as PluginExternalAgentChangeType,
} from "./external-agents-changes"

// =============================================================================
// Public types
// =============================================================================

/** What a credential-looking value reads back as in a projection. */
export const EXTERNAL_AGENT_REDACTED = "[redacted]"

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
  /** The master switch. Off, no external agent runs. */
  enabled: boolean
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

interface PluginExternalAgentSharedInput {
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
  | "inline_credentials"
  | "invalid_input"
  | "unknown_agent"
  | "unknown_preset"
  | "unknown_rule"
  | "external_agents_disabled"

/** A refused plugin request. `code` is stable; `message` is for the plugin author. */
export class PluginExternalAgentInputError extends Error {
  readonly code: PluginExternalAgentInputErrorCode

  constructor(code: PluginExternalAgentInputErrorCode, message: string) {
    super(message)
    this.name = "PluginExternalAgentInputError"
    this.code = code
  }
}

// =============================================================================
// Constants
// =============================================================================

const READ = "agent:external:read" as const
const MANAGE = "agent:external:manage" as const

const CREDENTIALS_ARE_HOST_ONLY =
  "Credentials are entered by the user in Settings → Agents → External agents; a plugin can neither write nor read them."

const PERMISSION_MODES: readonly AcpPermissionMode[] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
]
const GLOBAL_PERMISSION_MODES: readonly PluginExternalAgentSettings["defaultPermissionMode"][] = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]
const TRANSPORTS: readonly ExternalAgentTransport[] = ["stdio", "http", "websocket", "sse"]
const STATE_ISOLATIONS: readonly ExternalAgentStateIsolation[] = ["shared", "isolated"]
const DELEGATION_CONDITIONS: readonly ExternalAgentDelegationRule["condition"][] = [
  "task-type",
  "capability",
  "keyword",
  "tool-needed",
  "always",
  "custom",
]
const CHAT_FAILURE_POLICIES: readonly PluginExternalAgentSettings["chatFailurePolicy"][] = [
  "fallback",
  "strict",
]
const CAPABILITY_LEVELS: readonly ExternalAgentCapabilityLevel[] = [
  "native",
  "equivalent",
  "unsupported",
  "unknown",
]
const CODEX_SANDBOX_MODES = ["readOnly", "workspaceWrite", "dangerFullAccess"] as const
const CODEX_REASONING_SUMMARIES = ["auto", "concise", "detailed", "none"] as const

const SHARED_INPUT_KEYS = [
  "name",
  "description",
  "enabled",
  "stateIsolation",
  "subscriptionAccountId",
  "defaultPermissionMode",
  "process",
  "network",
  "cogniaModel",
  "timeout",
  "retryConfig",
  "maxConcurrentSessions",
  "sessionIdleTimeout",
  "tags",
  "codexOptions",
  "declaredCapabilities",
  "metadata",
] as const
const CREATE_KEYS = [...SHARED_INPUT_KEYS, "protocol", "transport"] as const
const UPDATE_KEYS = [
  "name",
  "description",
  "enabled",
  "defaultPermissionMode",
  "process",
  "network",
  "timeout",
  "retryConfig",
  "codexOptions",
  "cogniaModel",
  "stateIsolation",
  "subscriptionAccountId",
  "maxConcurrentSessions",
  "sessionIdleTimeout",
  "tags",
  "declaredCapabilities",
] as const
const PROCESS_INPUT_KEYS = ["command", "args", "cwd", "env", "bare", "debug"] as const
const PROCESS_UPDATE_KEYS = ["command", "args", "cwd"] as const
const METADATA_INPUT_KEYS = [
  "autoSpawnServer",
  "port",
  "hostname",
  "serverUsername",
  "model",
] as const
const RETRY_KEYS = [
  "maxRetries",
  "retryDelay",
  "exponentialBackoff",
  "maxRetryDelay",
  "retryOnErrors",
] as const
const CODEX_OPTION_KEYS = [
  "sandboxMode",
  "networkAccess",
  "writableRoots",
  "extraSkillRoots",
  "defaultReasoningEffort",
  "reasoningSummary",
  "serviceTier",
  "threadSource",
] as const
const RULE_KEYS = [
  "name",
  "condition",
  "matcher",
  "targetAgentId",
  "priority",
  "enabled",
  "description",
] as const

const MAX_TEXT = 4_096
const MAX_LIST = 256

// =============================================================================
// Lazy module access
// =============================================================================

// Every runtime module is loaded on first use: `createFullPluginContext` builds
// this API for every plugin, and most never ask about external agents.
async function store(): Promise<ExternalAgentStore> {
  const { useExternalAgentStore } = await import("@/stores/agent/external-agent-store")
  return useExternalAgentStore.getState()
}

async function lifecycle() {
  const { getExternalAgentLifecycleService } =
    await import("@/lib/ai/agent/external/lifecycle/service")
  return getExternalAgentLifecycleService()
}

// =============================================================================
// Redaction (projection side)
// =============================================================================

const ASSIGNMENT_ARG = /^(--?[A-Za-z0-9][A-Za-z0-9_.-]*|[A-Za-z_][A-Za-z0-9_.-]*)=(.+)$/s
const FLAG_ARG = /^--?[A-Za-z][A-Za-z0-9_.-]*$/

/**
 * Arguments with credential-looking values redacted: `--api-key=…`,
 * `--token …`, `OPENAI_API_KEY=…`. Uses the app's one `looksSecret` heuristic
 * so this agrees with the env and header split in `credentials.ts`.
 */
export function redactSecretArgs(args: readonly string[]): string[] {
  const out: string[] = []
  let redactNext = false
  for (const arg of args) {
    if (redactNext) {
      redactNext = false
      // A following flag is not the secret flag's value.
      if (!FLAG_ARG.test(arg)) {
        out.push(EXTERNAL_AGENT_REDACTED)
        continue
      }
    }
    const assignment = ASSIGNMENT_ARG.exec(arg)
    if (assignment && looksSecret(assignment[1].replace(/^-+/, ""))) {
      out.push(`${assignment[1]}=${EXTERNAL_AGENT_REDACTED}`)
      continue
    }
    if (FLAG_ARG.test(arg) && looksSecret(arg.replace(/^-+/, ""))) redactNext = true
    out.push(arg)
  }
  return out
}

/** An endpoint with URL userinfo and secret-named query values redacted. */
export function redactEndpoint(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  let changed = false
  if (url.username || url.password) {
    url.username = "redacted"
    url.password = ""
    changed = true
  }
  for (const name of [...url.searchParams.keys()]) {
    if (looksSecret(name)) {
      url.searchParams.set(name, "redacted")
      changed = true
    }
  }
  return changed ? url.toString() : raw
}

function iso(value: Date | string | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

type ComputeReadiness =
  typeof import("@/lib/ai/agent/external/agent-readiness").computeAgentReadiness

function rowReadiness(
  config: LifecycleAgentConfig,
  state: ExternalAgentStore,
  computeAgentReadiness: ComputeReadiness
) {
  return computeAgentReadiness({
    agent: config,
    connectionStatus: state.connectionStatus[config.id],
    delegatedRuleCount: state.delegationRules.filter(
      (rule) => rule.targetAgentId === config.id && rule.enabled
    ).length,
    validity: state.agentValidity[config.id] ?? config.validitySnapshot,
  })
}

/**
 * The secret-free projection. Built from the scrubbed config, then narrowed
 * to an allowlist — anything not named here (env, headers, proxy, metadata,
 * consent, keyring refs) cannot reach a plugin by being added to the config
 * later.
 */
export function projectExternalAgentConfig(
  config: LifecycleAgentConfig,
  state: ExternalAgentStore,
  computeAgentReadiness: ComputeReadiness
): PluginExternalAgentSummary {
  const { config: scrubbed, populatedSlots } = redactConfigForLogging(config)
  const readiness = rowReadiness(config, state, computeAgentReadiness)
  const metadata = scrubbed.metadata ?? {}
  return {
    id: scrubbed.id,
    name: scrubbed.name,
    description: text(scrubbed.description),
    protocol: scrubbed.protocol,
    transport: scrubbed.transport,
    enabled: scrubbed.enabled !== false,
    presetId: text(metadata.preset),
    stateIsolation: scrubbed.stateIsolation ?? "shared",
    duplicatedFromAgentId: text(scrubbed.duplicatedFromAgentId),
    createdByPluginId: text(metadata.createdByPluginId),
    defaultPermissionMode: scrubbed.defaultPermissionMode ?? null,
    process: scrubbed.process
      ? {
          command: scrubbed.process.command,
          args: redactSecretArgs(scrubbed.process.args ?? []),
          cwd: text(scrubbed.process.cwd),
        }
      : null,
    network: scrubbed.network?.endpoint
      ? { endpoint: redactEndpoint(scrubbed.network.endpoint) }
      : null,
    cogniaModel: scrubbed.cogniaModel ? { ...scrubbed.cogniaModel } : null,
    subscriptionAccountId: text(scrubbed.subscriptionAccountId),
    maxConcurrentSessions: scrubbed.maxConcurrentSessions ?? null,
    sessionIdleTimeout: scrubbed.sessionIdleTimeout ?? null,
    timeout: scrubbed.timeout ?? null,
    tags: [...(scrubbed.tags ?? [])],
    connectionStatus: state.connectionStatus[config.id] ?? "disconnected",
    readiness: {
      state: readiness.state,
      nextAction: readiness.nextAction,
      blockReason: readiness.blockReason,
    },
    lifecycleStatus: scrubbed.lifecycleStatus ?? null,
    lifecycleReasonCode: scrubbed.lifecycleReasonCode ?? null,
    credentialSlots: populatedSlots,
    createdAt: iso(scrubbed.createdAt),
    updatedAt: iso(scrubbed.updatedAt),
  }
}

// =============================================================================
// Validation (input side)
// =============================================================================

function invalid(method: string, message: string): never {
  throw new PluginExternalAgentInputError(
    "invalid_input",
    `ctx.externalAgents.${method}: ${message}`
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireRecord(method: string, path: string, value: unknown): Record<string, unknown> {
  if (!isRecord(value)) invalid(method, `${path} must be an object`)
  return value
}

function assertKnownKeys(
  method: string,
  path: string,
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unknown.length > 0) {
    invalid(
      method,
      `${path} has unsupported field(s) ${unknown.join(", ")}; allowed: ${allowed.join(", ")}`
    )
  }
}

function requireString(method: string, path: string, value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > MAX_TEXT || value.includes("\0")) {
    invalid(method, `${path} must be a string of at most ${MAX_TEXT} characters`)
  }
  if (!allowEmpty && value.trim().length === 0) invalid(method, `${path} must not be empty`)
  return value
}

function requireBoolean(method: string, path: string, value: unknown): boolean {
  if (typeof value !== "boolean") invalid(method, `${path} must be a boolean`)
  return value
}

function requireInteger(
  method: string,
  path: string,
  value: unknown,
  { min, max }: { min: number; max: number }
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    invalid(method, `${path} must be an integer between ${min} and ${max}`)
  }
  return value
}

function requireOneOf<T extends string>(
  method: string,
  path: string,
  value: unknown,
  allowed: readonly T[]
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    invalid(method, `${path} must be one of ${allowed.join(", ")}`)
  }
  return value as T
}

function requireStringList(method: string, path: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_LIST) {
    invalid(method, `${path} must be an array of at most ${MAX_LIST} strings`)
  }
  return value.map((entry, index) => requireString(method, `${path}[${index}]`, entry, true))
}

function refuseCredentials(method: string, where: string[]): never {
  throw new PluginExternalAgentInputError(
    "inline_credentials",
    `ctx.externalAgents.${method}: refusing inline credentials (${where.join(", ")}). ${CREDENTIALS_ARE_HOST_ONLY}`
  )
}

/**
 * Refuse anything that would carry a credential into a configuration.
 *
 * Runs on the raw input before any allowlist narrowing, so a credential is
 * named in the error rather than silently dropped — a plugin that thinks it
 * configured a token must learn that it did not.
 */
function assertNoInlineCredentials(method: string, input: Record<string, unknown>): void {
  const found: string[] = []
  const network = isRecord(input.network) ? input.network : undefined
  const process = isRecord(input.process) ? input.process : undefined
  const metadata = isRecord(input.metadata) ? input.metadata : undefined

  const slots = occupiedSlots(
    extractInlineCredentials({
      ...(network ? { network } : {}),
      ...(process ? { process } : {}),
      ...(metadata ? { metadata } : {}),
    } as unknown as ExternalAgentConfig)
  )
  const slotPath: Record<ExternalAgentCredentialSlot, string> = {
    apiKey: "network.apiKey",
    bearerToken: "network.bearerToken",
    headers: "network.headers",
    proxyAuth: "network.proxy.auth",
    processEnv: "process.env",
    serverPassword: "metadata.serverPassword",
  }
  found.push(...slots.map((slot) => slotPath[slot]))
  // Present but empty still names the field a plugin must not set.
  if (network && ("apiKey" in network || "bearerToken" in network)) {
    for (const key of ["apiKey", "bearerToken"] as const) {
      if (key in network && !found.includes(`network.${key}`)) found.push(`network.${key}`)
    }
  }
  if (metadata && "serverPassword" in metadata && !found.includes("metadata.serverPassword")) {
    found.push("metadata.serverPassword")
  }
  if (network && typeof network.endpoint === "string") {
    if (redactEndpoint(network.endpoint) !== network.endpoint) found.push("network.endpoint")
  }
  if (process && Array.isArray(process.args)) {
    const args = process.args.filter((arg): arg is string => typeof arg === "string")
    if (redactSecretArgs(args).some((arg, index) => arg !== args[index])) {
      found.push("process.args")
    }
  }
  if (found.length > 0) refuseCredentials(method, found)
}

function validatePermissionMode(method: string, value: unknown): AcpPermissionMode {
  return requireOneOf(method, "defaultPermissionMode", value, PERMISSION_MODES)
}

function validateRetry(method: string, value: unknown): Partial<ExternalAgentRetryConfig> {
  const retry = requireRecord(method, "retryConfig", value)
  assertKnownKeys(method, "retryConfig", retry, RETRY_KEYS)
  const out: Partial<ExternalAgentRetryConfig> = {}
  if (retry.maxRetries !== undefined)
    out.maxRetries = requireInteger(method, "retryConfig.maxRetries", retry.maxRetries, {
      min: 0,
      max: 20,
    })
  if (retry.retryDelay !== undefined)
    out.retryDelay = requireInteger(method, "retryConfig.retryDelay", retry.retryDelay, {
      min: 0,
      max: 600_000,
    })
  if (retry.exponentialBackoff !== undefined)
    out.exponentialBackoff = requireBoolean(
      method,
      "retryConfig.exponentialBackoff",
      retry.exponentialBackoff
    )
  if (retry.maxRetryDelay !== undefined)
    out.maxRetryDelay = requireInteger(method, "retryConfig.maxRetryDelay", retry.maxRetryDelay, {
      min: 0,
      max: 3_600_000,
    })
  if (retry.retryOnErrors !== undefined)
    out.retryOnErrors = requireStringList(method, "retryConfig.retryOnErrors", retry.retryOnErrors)
  return out
}

function validateCodexOptions(method: string, value: unknown): CodexAgentOptions {
  const options = requireRecord(method, "codexOptions", value)
  assertKnownKeys(method, "codexOptions", options, CODEX_OPTION_KEYS)
  const out: CodexAgentOptions = {}
  if (options.sandboxMode !== undefined)
    out.sandboxMode = requireOneOf(
      method,
      "codexOptions.sandboxMode",
      options.sandboxMode,
      CODEX_SANDBOX_MODES
    )
  if (options.networkAccess !== undefined)
    out.networkAccess = requireBoolean(method, "codexOptions.networkAccess", options.networkAccess)
  if (options.writableRoots !== undefined)
    out.writableRoots = requireStringList(
      method,
      "codexOptions.writableRoots",
      options.writableRoots
    )
  if (options.extraSkillRoots !== undefined)
    out.extraSkillRoots = requireStringList(
      method,
      "codexOptions.extraSkillRoots",
      options.extraSkillRoots
    )
  for (const key of ["defaultReasoningEffort", "serviceTier", "threadSource"] as const) {
    if (options[key] !== undefined)
      out[key] = requireString(method, `codexOptions.${key}`, options[key])
  }
  if (options.reasoningSummary !== undefined)
    out.reasoningSummary = requireOneOf(
      method,
      "codexOptions.reasoningSummary",
      options.reasoningSummary,
      CODEX_REASONING_SUMMARIES
    )
  return out
}

async function validateDeclaredCapabilities(
  method: string,
  value: unknown
): Promise<Partial<Record<ExternalAgentCapabilityId, ExternalAgentCapabilityLevel>>> {
  const declared = requireRecord(method, "declaredCapabilities", value)
  const { EXTERNAL_AGENT_CAPABILITY_IDS } =
    await import("@cognia/agent-config-types/external-agent-capability")
  const out: Partial<Record<ExternalAgentCapabilityId, ExternalAgentCapabilityLevel>> = {}
  for (const [id, level] of Object.entries(declared)) {
    if (!(EXTERNAL_AGENT_CAPABILITY_IDS as readonly string[]).includes(id)) {
      invalid(method, `declaredCapabilities.${id} is not a known capability`)
    }
    out[id as ExternalAgentCapabilityId] = requireOneOf(
      method,
      `declaredCapabilities.${id}`,
      level,
      CAPABILITY_LEVELS
    )
  }
  return out
}

async function validateCogniaModel(
  method: string,
  value: unknown
): Promise<ExternalAgentCogniaModelBinding | null> {
  const { normalizeCogniaModelBinding } = await import("@/types/agent/external-agent")
  try {
    return normalizeCogniaModelBinding(value) ?? null
  } catch {
    return invalid(method, "cogniaModel must be { providerId, modelId, accountId? } or null")
  }
}

function validateSubscriptionAccount(method: string, value: unknown): string | null {
  if (value === null) return null
  return requireString(method, "subscriptionAccountId", value)
}

function validateTags(method: string, value: unknown): string[] {
  const tags = requireStringList(method, "tags", value)
  if (tags.length > 64) invalid(method, "tags must hold at most 64 entries")
  return tags.map((tag) => tag.trim()).filter(Boolean)
}

/** Fields both create paths layer onto the form-built input. */
interface SharedExtras {
  description?: string
  enabled?: boolean
  stateIsolation?: ExternalAgentStateIsolation
  subscriptionAccountId?: string | null
  defaultPermissionMode?: AcpPermissionMode
  maxConcurrentSessions?: number
  sessionIdleTimeout?: number
  tags?: string[]
  codexOptions?: CodexAgentOptions
  declaredCapabilities?: Partial<Record<ExternalAgentCapabilityId, ExternalAgentCapabilityLevel>>
  retryConfig?: Partial<ExternalAgentRetryConfig>
}

async function validateSharedExtras(
  method: string,
  input: Record<string, unknown>
): Promise<SharedExtras> {
  const out: SharedExtras = {}
  if (input.description !== undefined)
    out.description = requireString(method, "description", input.description, true)
  if (input.enabled !== undefined) out.enabled = requireBoolean(method, "enabled", input.enabled)
  if (input.stateIsolation !== undefined)
    out.stateIsolation = requireOneOf(
      method,
      "stateIsolation",
      input.stateIsolation,
      STATE_ISOLATIONS
    )
  if (input.subscriptionAccountId !== undefined)
    out.subscriptionAccountId = validateSubscriptionAccount(method, input.subscriptionAccountId)
  if (input.defaultPermissionMode !== undefined)
    out.defaultPermissionMode = validatePermissionMode(method, input.defaultPermissionMode)
  if (input.maxConcurrentSessions !== undefined)
    out.maxConcurrentSessions = requireInteger(
      method,
      "maxConcurrentSessions",
      input.maxConcurrentSessions,
      { min: 1, max: 64 }
    )
  if (input.sessionIdleTimeout !== undefined)
    out.sessionIdleTimeout = requireInteger(
      method,
      "sessionIdleTimeout",
      input.sessionIdleTimeout,
      { min: 1_000, max: 86_400_000 }
    )
  if (input.tags !== undefined) out.tags = validateTags(method, input.tags)
  if (input.codexOptions !== undefined)
    out.codexOptions = validateCodexOptions(method, input.codexOptions)
  if (input.declaredCapabilities !== undefined)
    out.declaredCapabilities = await validateDeclaredCapabilities(
      method,
      input.declaredCapabilities
    )
  if (input.retryConfig !== undefined) out.retryConfig = validateRetry(method, input.retryConfig)
  return out
}

/** The add-agent form fields a plugin input sets. */
async function applyFormFields(
  method: string,
  data: AddAgentFormData,
  input: Record<string, unknown>,
  { managedRuntime }: { managedRuntime: boolean }
): Promise<AddAgentFormData> {
  const { shellQuote } = await import("@/lib/mcp/config-transfer")
  const next: AddAgentFormData = { ...data }
  if (input.name !== undefined) next.name = requireString(method, "name", input.name)
  if (input.process !== undefined) {
    const process = requireRecord(method, "process", input.process)
    assertKnownKeys(method, "process", process, PROCESS_INPUT_KEYS)
    if (managedRuntime && (process.command !== undefined || process.args !== undefined)) {
      invalid(method, "this preset launches a managed runtime; its command and arguments are fixed")
    }
    if (process.command !== undefined)
      next.command = requireString(method, "process.command", process.command)
    if (process.args !== undefined)
      next.args = requireStringList(method, "process.args", process.args).map(shellQuote).join(" ")
    if (process.cwd !== undefined)
      next.processCwd = requireString(method, "process.cwd", process.cwd)
    if (process.env !== undefined) {
      const env = requireRecord(method, "process.env", process.env)
      const values: Record<string, string> = {}
      for (const [name, value] of Object.entries(env)) {
        values[name] = requireString(method, `process.env.${name}`, value, true)
      }
      next.processEnv = { ...next.processEnv, ...values }
    }
    if (process.bare !== undefined) next.bare = requireBoolean(method, "process.bare", process.bare)
    if (process.debug !== undefined)
      next.debug = requireBoolean(method, "process.debug", process.debug)
  }
  if (input.network !== undefined) {
    const network = requireRecord(method, "network", input.network)
    assertKnownKeys(method, "network", network, ["endpoint"])
    next.endpoint = requireString(method, "network.endpoint", network.endpoint)
  }
  if (input.metadata !== undefined) {
    const metadata = requireRecord(method, "metadata", input.metadata)
    assertKnownKeys(method, "metadata", metadata, METADATA_INPUT_KEYS)
    if (metadata.autoSpawnServer !== undefined)
      next.autoSpawnServer = requireBoolean(
        method,
        "metadata.autoSpawnServer",
        metadata.autoSpawnServer
      )
    if (metadata.port !== undefined)
      next.port = String(
        requireInteger(method, "metadata.port", metadata.port, { min: 1, max: 65_535 })
      )
    if (metadata.hostname !== undefined)
      next.hostname = requireString(method, "metadata.hostname", metadata.hostname)
    if (metadata.serverUsername !== undefined)
      next.serverUsername = requireString(
        method,
        "metadata.serverUsername",
        metadata.serverUsername
      )
    if (metadata.model !== undefined)
      next.model = requireString(method, "metadata.model", metadata.model)
  }
  if (input.cogniaModel !== undefined)
    next.cogniaModel = await validateCogniaModel(method, input.cogniaModel)
  if (input.timeout !== undefined)
    next.timeoutMs = String(
      requireInteger(method, "timeout", input.timeout, { min: 1_000, max: 86_400_000 })
    )
  if (input.retryConfig !== undefined) {
    const retry = validateRetry(method, input.retryConfig)
    if (retry.maxRetries !== undefined) next.retryMaxRetries = String(retry.maxRetries)
    if (retry.retryDelay !== undefined) next.retryDelayMs = String(retry.retryDelay)
    if (retry.exponentialBackoff !== undefined)
      next.retryExponentialBackoff = retry.exponentialBackoff
    if (retry.maxRetryDelay !== undefined) next.retryMaxDelayMs = String(retry.maxRetryDelay)
    if (retry.retryOnErrors !== undefined) next.retryOnErrors = retry.retryOnErrors.join("\n")
  }
  return next
}

/**
 * Run the add-agent form's own rules and builder over plugin input.
 *
 * The desktop dialog and the phone flow already share
 * `lib/ai/agent/external/config/add-agent-form.ts` so they cannot disagree
 * about what a valid new agent is. A plugin is a third surface adding agents;
 * going through the same validator and builder keeps it from being the one
 * that can create a config neither UI could.
 */
async function buildCreateInput(
  method: string,
  pluginId: string,
  data: AddAgentFormData,
  presetId: string,
  extras: SharedExtras
): Promise<CreateExternalAgentInput> {
  const [{ validateAddAgentForm, buildCreateExternalAgentInput }, { adaptPermissionMode }] =
    await Promise.all([
      import("@/lib/ai/agent/external/config/add-agent-form"),
      import("@/lib/ai/agent/external/policy/permission-modes"),
    ])
  const env = data.processEnv ?? {}
  const problem = validateAddAgentForm(data, presetId, {
    names: Object.keys(env),
    values: env,
  })
  if (problem) invalid(method, `the configuration is not valid (${problem})`)

  const defaultPermissionMode = extras.defaultPermissionMode
    ? adaptPermissionMode(extras.defaultPermissionMode, data.protocol).mode
    : undefined
  const built = buildCreateExternalAgentInput(data, { defaultPermissionMode })

  const input: CreateExternalAgentInput = {
    ...built,
    ...(extras.description !== undefined ? { description: extras.description } : {}),
    ...(extras.enabled !== undefined ? { enabled: extras.enabled } : {}),
    // ADR-0216: a new configuration defaults to its own state root.
    stateIsolation: extras.stateIsolation ?? "isolated",
    ...(extras.subscriptionAccountId !== undefined
      ? { subscriptionAccountId: extras.subscriptionAccountId }
      : {}),
    ...(extras.maxConcurrentSessions !== undefined
      ? { maxConcurrentSessions: extras.maxConcurrentSessions }
      : {}),
    ...(extras.sessionIdleTimeout !== undefined
      ? { sessionIdleTimeout: extras.sessionIdleTimeout }
      : {}),
    ...(extras.tags !== undefined ? { tags: extras.tags } : {}),
    ...(extras.codexOptions !== undefined ? { codexOptions: extras.codexOptions } : {}),
    ...(extras.declaredCapabilities !== undefined
      ? { declaredCapabilities: extras.declaredCapabilities }
      : {}),
    metadata: { ...built.metadata, createdByPluginId: pluginId },
  }

  // Defense in depth: the builder must not have introduced a credential
  // (a preset env or a managed-runtime key) the raw-input check never saw.
  const slots = occupiedSlots(extractInlineCredentials(input as unknown as ExternalAgentConfig))
  if (slots.length > 0) refuseCredentials(method, slots)
  return input
}

/** Validate an update patch into the lifecycle's input shape. */
async function validateUpdatePatch(
  method: string,
  config: LifecycleAgentConfig,
  raw: Record<string, unknown>
): Promise<UpdateExternalAgentInput> {
  if (isRecord(raw.process) && "env" in raw.process) {
    refuseCredentials(method, ["process.env"])
  }
  if (isRecord(raw.network)) {
    const secretKeys = ["apiKey", "bearerToken", "headers", "proxy"].filter(
      (key) => key in (raw.network as Record<string, unknown>)
    )
    if (secretKeys.length > 0)
      refuseCredentials(
        method,
        secretKeys.map((key) => `network.${key}`)
      )
  }
  assertNoInlineCredentials(method, raw)
  assertKnownKeys(method, "patch", raw, UPDATE_KEYS)

  const patch: UpdateExternalAgentInput = {}
  if (raw.name !== undefined) patch.name = requireString(method, "name", raw.name)
  if (raw.process !== undefined) {
    const process = requireRecord(method, "process", raw.process)
    assertKnownKeys(method, "process", process, PROCESS_UPDATE_KEYS)
    if (config.metadata?.requiresManagedRuntime === true && Object.keys(process).length > 0) {
      invalid(method, "this agent launches a managed runtime; its process is fixed")
    }
    const next: Partial<NonNullable<ExternalAgentConfig["process"]>> = {}
    if (process.command !== undefined)
      next.command = requireString(method, "process.command", process.command)
    if (process.args !== undefined)
      next.args = requireStringList(method, "process.args", process.args)
    if (process.cwd !== undefined)
      next.cwd = requireString(method, "process.cwd", process.cwd, true)
    patch.process = next
  }
  if (raw.network !== undefined) {
    const network = requireRecord(method, "network", raw.network)
    assertKnownKeys(method, "network", network, ["endpoint"])
    patch.network = { endpoint: requireString(method, "network.endpoint", network.endpoint) }
  }
  if (raw.cogniaModel !== undefined)
    patch.cogniaModel = await validateCogniaModel(method, raw.cogniaModel)
  if (raw.timeout !== undefined)
    patch.timeout = requireInteger(method, "timeout", raw.timeout, { min: 1_000, max: 86_400_000 })

  const extras = await validateSharedExtras(method, raw)
  if (extras.description !== undefined) patch.description = extras.description
  if (extras.enabled !== undefined) patch.enabled = extras.enabled
  if (extras.stateIsolation !== undefined) patch.stateIsolation = extras.stateIsolation
  if (extras.subscriptionAccountId !== undefined)
    patch.subscriptionAccountId = extras.subscriptionAccountId
  if (extras.maxConcurrentSessions !== undefined)
    patch.maxConcurrentSessions = extras.maxConcurrentSessions
  if (extras.sessionIdleTimeout !== undefined) patch.sessionIdleTimeout = extras.sessionIdleTimeout
  if (extras.tags !== undefined) patch.tags = extras.tags
  if (extras.codexOptions !== undefined) patch.codexOptions = extras.codexOptions
  if (extras.declaredCapabilities !== undefined)
    patch.declaredCapabilities = extras.declaredCapabilities
  if (extras.retryConfig !== undefined) patch.retryConfig = extras.retryConfig
  if (extras.defaultPermissionMode !== undefined) {
    const { adaptPermissionMode } = await import("@/lib/ai/agent/external/policy/permission-modes")
    patch.defaultPermissionMode = adaptPermissionMode(
      extras.defaultPermissionMode,
      config.protocol
    ).mode
  }

  // A stdio agent with no command, or a network agent with no endpoint, is a
  // config neither Settings surface would save.
  const command = patch.process?.command ?? config.process?.command
  if (patch.process && config.transport === "stdio" && !command?.trim()) {
    invalid(method, "a stdio agent needs process.command")
  }
  return patch
}

function validateRule(
  method: string,
  raw: Record<string, unknown>,
  state: ExternalAgentStore,
  { partial }: { partial: boolean }
): Partial<PluginExternalAgentDelegationRuleInput> {
  assertKnownKeys(method, "rule", raw, RULE_KEYS)
  const rule: Partial<PluginExternalAgentDelegationRuleInput> = {}
  const required = (key: keyof PluginExternalAgentDelegationRuleInput) =>
    !partial || raw[key] !== undefined
  if (required("name")) rule.name = requireString(method, "rule.name", raw.name)
  if (required("condition"))
    rule.condition = requireOneOf(method, "rule.condition", raw.condition, DELEGATION_CONDITIONS)
  if (required("matcher")) rule.matcher = requireString(method, "rule.matcher", raw.matcher, true)
  if (required("targetAgentId")) {
    rule.targetAgentId = requireString(method, "rule.targetAgentId", raw.targetAgentId)
    if (!state.agents[rule.targetAgentId]) {
      throw new PluginExternalAgentInputError(
        "unknown_agent",
        `ctx.externalAgents.${method}: rule.targetAgentId "${rule.targetAgentId}" names no configured agent`
      )
    }
  }
  if (raw.priority !== undefined || !partial)
    rule.priority = requireInteger(method, "rule.priority", raw.priority ?? 0, {
      min: -1_000_000,
      max: 1_000_000,
    })
  if (raw.enabled !== undefined || !partial)
    rule.enabled = requireBoolean(method, "rule.enabled", raw.enabled ?? true)
  if (raw.description !== undefined)
    rule.description = requireString(method, "rule.description", raw.description, true)
  return rule
}

/**
 * A keyword matcher is compiled as a regex on every delegated turn; refuse one
 * that does not compile instead of storing a rule that never matches.
 */
function assertKeywordMatcherCompiles(
  method: string,
  condition: ExternalAgentDelegationRule["condition"] | undefined,
  matcher: string | undefined
): void {
  if (condition !== "keyword" || matcher === undefined) return
  try {
    new RegExp(matcher, "i")
  } catch {
    invalid(method, "rule.matcher is not a valid regular expression")
  }
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create the External Agents API for a plugin. Reads need
 * `agent:external:read`; every write needs `agent:external:manage` (dangerous,
 * so it routes through per-call consent when the guard stamps it `confirm`).
 */
export function createExternalAgentsAPI(pluginId: string): PluginExternalAgentsAPI {
  const project = async (config: LifecycleAgentConfig): Promise<PluginExternalAgentSummary> => {
    const [state, { computeAgentReadiness }] = await Promise.all([
      store(),
      import("@/lib/ai/agent/external/agent-readiness"),
    ])
    return projectExternalAgentConfig(config, state, computeAgentReadiness)
  }

  const requireAgent = async (
    method: string,
    id: unknown
  ): Promise<{ config: LifecycleAgentConfig; state: ExternalAgentStore }> => {
    const agentId = requireString(method, "id", id)
    const state = await store()
    const config = state.getAgent(agentId) as LifecycleAgentConfig | undefined
    if (!config) {
      throw new PluginExternalAgentInputError(
        "unknown_agent",
        `ctx.externalAgents.${method}: no external agent "${agentId}"`
      )
    }
    return { config, state }
  }

  const readBack = async (method: string, id: string): Promise<PluginExternalAgentSummary> => {
    const { config } = await requireAgent(method, id)
    return project(config)
  }

  const requireRecordInput = (method: string, value: unknown): Record<string, unknown> =>
    requireRecord(method, "input", value)

  const api: PluginExternalAgentsAPI = {
    // ------------------------------------------------------------------ reads
    list: async () => {
      const [state, { computeAgentReadiness }] = await Promise.all([
        store(),
        import("@/lib/ai/agent/external/agent-readiness"),
      ])
      return state
        .getAllAgents()
        .map((config) =>
          projectExternalAgentConfig(config as LifecycleAgentConfig, state, computeAgentReadiness)
        )
    },

    get: async (id) => {
      const agentId = requireString("get", "id", id)
      const config = (await store()).getAgent(agentId) as LifecycleAgentConfig | undefined
      return config ? project(config) : null
    },

    getReadiness: async (id) => {
      const { config, state } = await requireAgent("getReadiness", id)
      const [{ computeAgentReadiness }, service] = await Promise.all([
        import("@/lib/ai/agent/external/agent-readiness"),
        lifecycle(),
      ])
      const readiness = rowReadiness(config, state, computeAgentReadiness)
      const verdict = await service.assessReadiness(config)
      return {
        agentId: config.id,
        state: readiness.state,
        nextAction: readiness.nextAction,
        blockReason: readiness.blockReason,
        blockTransient: readiness.blockTransient,
        steps: readiness.steps.map((step) => ({ ...step })),
        verdict: {
          status: verdict.status,
          reasonCode: verdict.reasonCode ?? null,
          reason: verdict.reason ?? null,
        },
      }
    },

    listPresets: async () => {
      const presets = await import("@/lib/ai/agent/external/config/presets")
      const runnable = new Set(presets.getRunnablePresets())
      return presets.getAvailablePresets().flatMap((id) => {
        const config = presets.getPresetConfig(id)
        const display = presets.getPresetDisplayInfo(id)
        if (!config || !display) return []
        return [
          {
            id,
            name: display.name,
            description: display.description,
            protocol: config.protocol,
            transport: config.transport,
            runnable: runnable.has(id),
            supportTier: config.supportTier ?? null,
            defaultPermissionMode: config.defaultPermissionMode,
            tags: [...display.tags],
            docsUrl: display.docsUrl ?? null,
            envVarHint: display.envVarHint ?? null,
            setupHint: display.setupHint ?? null,
            contributedByPluginId: presets.getDynamicPresetEntry(id)?.pluginId ?? null,
          },
        ]
      })
    },

    listRuntimes: async (options) => {
      const refresh =
        options?.refresh === undefined
          ? false
          : requireBoolean("listRuntimes", "options.refresh", options.refresh)
      const { detectInstalledRuntimes, ExternalAgentDetectionUnavailableError } =
        await import("@/lib/ai/agent/external/config/installed-runtimes")
      try {
        const runtimes = await detectInstalledRuntimes({ refresh })
        return {
          available: true,
          // `detail` is a host diagnostic note, not part of the plugin contract.
          runtimes: runtimes.map(({ runtimeId, command, resolution, executablePath, version }) => ({
            runtimeId,
            command,
            resolution,
            executablePath,
            version,
          })),
        }
      } catch (error) {
        if (error instanceof ExternalAgentDetectionUnavailableError) {
          return { available: false, runtimes: [] }
        }
        throw error
      }
    },

    getSettings: async () => {
      const state = await store()
      return {
        enabled: state.enabled,
        defaultPermissionMode: state.defaultPermissionMode,
        autoConnectOnStartup: state.autoConnectOnStartup,
        showConnectionNotifications: state.showConnectionNotifications,
        chatFailurePolicy: state.chatFailurePolicy,
      }
    },

    listDelegationRules: async () => (await store()).delegationRules.map((rule) => ({ ...rule })),

    onChange: (listener) => {
      if (typeof listener !== "function") invalid("onChange", "listener must be a function")
      return subscribeExternalAgentChanges(listener, (error) =>
        recordSilentFailure(
          pluginId,
          {
            site: "externalAgents.onChange",
            message: "An external-agent change listener threw",
            expected: false,
          },
          error
        )
      )
    },

    // ----------------------------------------------------------------- writes
    create: async (rawInput) => {
      const input = requireRecordInput("create", rawInput)
      assertNoInlineCredentials("create", input)
      assertKnownKeys("create", "input", input, CREATE_KEYS)
      const protocol = requireString("create", "protocol", input.protocol) as ExternalAgentProtocol
      const { DEFAULT_ADD_AGENT_FORM_DATA, transportForProtocol } =
        await import("@/lib/ai/agent/external/config/add-agent-form")
      const transport =
        input.transport === undefined
          ? transportForProtocol(protocol, "stdio")
          : requireOneOf("create", "transport", input.transport, TRANSPORTS)
      const seeded: AddAgentFormData = {
        ...DEFAULT_ADD_AGENT_FORM_DATA,
        protocol,
        transport,
      }
      const data = await applyFormFields("create", seeded, input, { managedRuntime: false })
      const extras = await validateSharedExtras("create", input)
      const createInput = await buildCreateInput("create", pluginId, data, "", extras)
      const id = await (await lifecycle()).createConfig(createInput)
      return readBack("create", id)
    },

    createFromPreset: async (presetId, rawOverrides) => {
      const id = requireString("createFromPreset", "presetId", presetId)
      const overrides =
        rawOverrides === undefined
          ? {}
          : requireRecord("createFromPreset", "overrides", rawOverrides)
      assertNoInlineCredentials("createFromPreset", overrides)
      assertKnownKeys("createFromPreset", "overrides", overrides, SHARED_INPUT_KEYS)
      const [presets, { DEFAULT_ADD_AGENT_FORM_DATA, addAgentFormForPreset, addAgentFormShape }] =
        await Promise.all([
          import("@/lib/ai/agent/external/config/presets"),
          import("@/lib/ai/agent/external/config/add-agent-form"),
        ])
      const seeded = addAgentFormForPreset(DEFAULT_ADD_AGENT_FORM_DATA, id)
      if (!seeded) {
        throw new PluginExternalAgentInputError(
          "unknown_preset",
          `ctx.externalAgents.createFromPreset: no preset "${id}"`
        )
      }
      if (!presets.getRunnablePresets().includes(id)) {
        throw new PluginExternalAgentInputError(
          "unknown_preset",
          `ctx.externalAgents.createFromPreset: preset "${id}" is documented-only and cannot be created`
        )
      }
      const base: AddAgentFormData = { ...seeded.data, preset: id }
      const { managedRuntime } = addAgentFormShape(base, id)
      const data = await applyFormFields("createFromPreset", base, overrides, { managedRuntime })
      const extras = await validateSharedExtras("createFromPreset", overrides)
      const createInput = await buildCreateInput("createFromPreset", pluginId, data, id, {
        ...extras,
        // The dialog adds no description; a preset-built config carries the preset's.
        description: extras.description ?? presets.getPresetDisplayInfo(id)?.description,
      })
      const created = await (await lifecycle()).createConfig(createInput)
      return readBack("createFromPreset", created)
    },

    update: async (id, rawPatch) => {
      const { config } = await requireAgent("update", id)
      const patch = await validateUpdatePatch(
        "update",
        config,
        requireRecord("update", "patch", rawPatch)
      )
      await (await lifecycle()).updateConfig(config.id, patch)
      return readBack("update", config.id)
    },

    duplicate: async (id, rawOptions) => {
      const { config, state } = await requireAgent("duplicate", id)
      const options =
        rawOptions === undefined ? {} : requireRecord("duplicate", "options", rawOptions)
      assertKnownKeys("duplicate", "options", options, ["name", "stateIsolation", "enabled"])
      let name: string
      if (options.name !== undefined) {
        name = requireString("duplicate", "options.name", options.name)
      } else {
        const [{ uniqueDuplicateName }, { getRuntimeTranslator }] = await Promise.all([
          import("@/lib/ai/agent/external/config/duplicate-config"),
          import("@/lib/i18n/runtime-translator"),
        ])
        const t = await getRuntimeTranslator("plugins.externalAgents")
        name = uniqueDuplicateName(
          state.getAllAgents().map((agent) => agent.name),
          (index) =>
            index === 1
              ? t("duplicateName", { name: config.name })
              : t("duplicateNameNumbered", { name: config.name, index })
        )
      }
      const service = await lifecycle()
      const copyId = await service.duplicateConfig(config.id, {
        name,
        ...(options.stateIsolation !== undefined
          ? {
              stateIsolation: requireOneOf(
                "duplicate",
                "options.stateIsolation",
                options.stateIsolation,
                STATE_ISOLATIONS
              ),
            }
          : {}),
        ...(options.enabled !== undefined
          ? { enabled: requireBoolean("duplicate", "options.enabled", options.enabled) }
          : {}),
      })
      // The copy is this plugin's creation, not the source's author's; a
      // metadata-only patch does not rebuild the runtime.
      await service.updateConfig(copyId, { metadata: { createdByPluginId: pluginId } })
      return readBack("duplicate", copyId)
    },

    remove: async (id) => {
      const { config } = await requireAgent("remove", id)
      await (await lifecycle()).removeConfig(config.id)
    },

    setEnabled: async (id, enabled) => {
      const { config } = await requireAgent("setEnabled", id)
      await (
        await lifecycle()
      ).updateConfig(config.id, {
        enabled: requireBoolean("setEnabled", "enabled", enabled),
      })
      return readBack("setEnabled", config.id)
    },

    connect: async (id) => {
      const { config, state } = await requireAgent("connect", id)
      if (!state.enabled) {
        throw new PluginExternalAgentInputError(
          "external_agents_disabled",
          "ctx.externalAgents.connect: external agents are turned off in Settings"
        )
      }
      await (await lifecycle()).connect(config.id)
      return readBack("connect", config.id)
    },

    disconnect: async (id) => {
      const { config } = await requireAgent("disconnect", id)
      await (await lifecycle()).disconnect(config.id)
      return readBack("disconnect", config.id)
    },

    addDelegationRule: async (rawRule) => {
      const state = await store()
      const rule = validateRule(
        "addDelegationRule",
        requireRecord("addDelegationRule", "rule", rawRule),
        state,
        { partial: false }
      ) as PluginExternalAgentDelegationRuleInput
      assertKeywordMatcherCompiles("addDelegationRule", rule.condition, rule.matcher)
      const ruleId = state.addDelegationRule(rule)
      const added = (await store()).delegationRules.find((entry) => entry.id === ruleId)
      if (!added) throw new Error("ctx.externalAgents.addDelegationRule: the rule was not stored")
      return { ...added }
    },

    updateDelegationRule: async (id, rawPatch) => {
      const ruleId = requireString("updateDelegationRule", "id", id)
      const state = await store()
      const existing = state.delegationRules.find((rule) => rule.id === ruleId)
      if (!existing) {
        throw new PluginExternalAgentInputError(
          "unknown_rule",
          `ctx.externalAgents.updateDelegationRule: no delegation rule "${ruleId}"`
        )
      }
      const patch = validateRule(
        "updateDelegationRule",
        requireRecord("updateDelegationRule", "patch", rawPatch),
        state,
        { partial: true }
      )
      assertKeywordMatcherCompiles(
        "updateDelegationRule",
        patch.condition ?? existing.condition,
        patch.matcher ?? existing.matcher
      )
      state.updateDelegationRule(ruleId, patch)
      const updated = (await store()).delegationRules.find((rule) => rule.id === ruleId)
      if (!updated) throw new Error("ctx.externalAgents.updateDelegationRule: the rule vanished")
      return { ...updated }
    },

    removeDelegationRule: async (id) => {
      const ruleId = requireString("removeDelegationRule", "id", id)
      const state = await store()
      if (!state.delegationRules.some((rule) => rule.id === ruleId)) {
        throw new PluginExternalAgentInputError(
          "unknown_rule",
          `ctx.externalAgents.removeDelegationRule: no delegation rule "${ruleId}"`
        )
      }
      state.removeDelegationRule(ruleId)
    },

    reorderDelegationRules: async (ruleIds) => {
      const ids = requireStringList("reorderDelegationRules", "ruleIds", ruleIds)
      const state = await store()
      const existing = new Set(state.delegationRules.map((rule) => rule.id))
      // The store drops every rule the list omits. A plugin reordering must
      // never double as a silent bulk delete.
      if (
        ids.length !== existing.size ||
        new Set(ids).size !== ids.length ||
        ids.some((ruleId) => !existing.has(ruleId))
      ) {
        invalid("reorderDelegationRules", "ruleIds must name every delegation rule exactly once")
      }
      state.reorderDelegationRules(ids)
      return (await store()).delegationRules.map((rule) => ({ ...rule }))
    },

    updateSettings: async (rawPatch) => {
      const patch = requireRecord("updateSettings", "patch", rawPatch)
      assertKnownKeys("updateSettings", "patch", patch, EXTERNAL_AGENT_SETTING_KEYS)
      const state = await store()
      // Validate everything before writing anything: a half-applied settings
      // patch is worse than a refused one.
      const enabled =
        patch.enabled === undefined
          ? undefined
          : requireBoolean("updateSettings", "enabled", patch.enabled)
      const mode =
        patch.defaultPermissionMode === undefined
          ? undefined
          : requireOneOf(
              "updateSettings",
              "defaultPermissionMode",
              patch.defaultPermissionMode,
              GLOBAL_PERMISSION_MODES
            )
      const autoConnect =
        patch.autoConnectOnStartup === undefined
          ? undefined
          : requireBoolean("updateSettings", "autoConnectOnStartup", patch.autoConnectOnStartup)
      const notifications =
        patch.showConnectionNotifications === undefined
          ? undefined
          : requireBoolean(
              "updateSettings",
              "showConnectionNotifications",
              patch.showConnectionNotifications
            )
      const failurePolicy =
        patch.chatFailurePolicy === undefined
          ? undefined
          : requireOneOf(
              "updateSettings",
              "chatFailurePolicy",
              patch.chatFailurePolicy,
              CHAT_FAILURE_POLICIES
            )
      if (enabled !== undefined) state.setEnabled(enabled)
      if (mode !== undefined) state.setDefaultPermissionMode(mode)
      if (autoConnect !== undefined) state.setAutoConnectOnStartup(autoConnect)
      if (notifications !== undefined) state.setShowConnectionNotifications(notifications)
      if (failurePolicy !== undefined) state.setChatFailurePolicy(failurePolicy)
      return api.getSettings()
    },
  }

  return createGuardedAPI(
    pluginId,
    api,
    {
      list: READ,
      get: READ,
      getReadiness: READ,
      listPresets: READ,
      listRuntimes: READ,
      getSettings: READ,
      listDelegationRules: READ,
      onChange: READ,
      create: MANAGE,
      createFromPreset: MANAGE,
      update: MANAGE,
      duplicate: MANAGE,
      remove: MANAGE,
      setEnabled: MANAGE,
      connect: MANAGE,
      disconnect: MANAGE,
      addDelegationRule: MANAGE,
      updateDelegationRule: MANAGE,
      removeDelegationRule: MANAGE,
      reorderDelegationRules: MANAGE,
      updateSettings: MANAGE,
    },
    // `onChange` subscribes and returns its disposer synchronously; a read
    // permission never needs per-call consent anyway, and keeping it off the
    // async consent path keeps the disposer a plain return value.
    { consentExempt: ["onChange"] }
  )
}
