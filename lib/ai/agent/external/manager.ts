/**
 * External Agent Manager
 *
 * Centralized manager for all external agent connections and interactions.
 * Handles agent lifecycle, routing, and coordination.
 */

import type {
  ExternalAgentConfig,
  ExternalAgentSession,
  ExternalAgentMessage,
  ExternalAgentEvent,
  ExternalAgentResult,
  ExternalAgentExecutionOptions,
  ExternalAgentInstance,
  ExternalAgentDelegationRule,
  ExternalAgentDelegationResult,
  ExternalAgentConnectionStatus,
  ExternalAgentStatus,
  ExternalAgentBranchReasonCode,
  ExternalAgentBranchOutcome,
  ExternalAgentLastRunSnapshot,
  ExternalAgentCorrelationMetadata,
  ExternalAgentExecutionEligibility,
  ExternalAgentLifecycleCompletenessStage,
  ExternalAgentProtocol,
  ExternalAgentSessionExtensionSupport,
  ExternalAgentSupportState,
  ExternalAgentValiditySnapshot,
  AcpCapabilities,
  AcpToolInfo,
  AcpPermissionMode,
  AcpPermissionResponse,
  AcpAuthMethod,
  AcpSessionModelState,
  AcpConfigOption,
} from "@/types/agent/external-agent"
import type { AgentTool } from "@/lib/ai/agent"
import { loggers } from "@/lib/logging"
import {
  type ProtocolAdapter,
  protocolAdapterRegistry,
  type SessionCreateOptions,
} from "./protocol-adapter"
import { AcpClientAdapter } from "./acp-client"
import { CodexAppServerAdapter } from "./codex-app-server-client"
import { OpenCodeClientAdapter } from "./opencode-client"
import { A2aClientAdapter } from "./a2a-client"
import { acpToolsToAgentTools } from "./translators"
import { createExternalAgentTraceBridge } from "./agent-trace-bridge"
import {
  observeExternalAgentEvent,
  gateExternalAgentPermission,
  type AgentHookContext,
} from "./agent-hooks"
import {
  getExternalAgentExecutionBlock,
  getExternalAgentEcosystemReadiness,
  probeExternalAgentEcosystemReadiness,
  projectExternalAgentReadinessMetadata,
} from "./config-normalizer"
import {
  createExternalAgentUnsupportedSessionExtensionError,
  isExternalAgentMethodNotFoundError,
  isExternalAgentSessionExtensionUnsupportedForMethod,
} from "./session-extension-errors"
import {
  createUnknownSessionExtensionSupport,
  normalizeExternalAgentValiditySnapshot,
} from "./canonical-contract"
import { checkExternalAgentCommandExists } from "@/lib/native/external-agent"

const externalAgentManagerLogger = loggers.agent.child("external-manager")

// ============================================================================
// Capability Result Type
// ============================================================================

/**
 * Typed result for agent capability queries.
 * Distinguishes between "unsupported", "ok with data", and "error".
 */
export type AgentCapabilityResult<T> =
  | { status: "ok"; data: T }
  | { status: "unsupported" }
  | { status: "error"; error: Error }

// ============================================================================
// External Agent Manager
// ============================================================================

/**
 * Manager configuration
 */
export interface ExternalAgentManagerConfig {
  /** Maximum concurrent connections */
  maxConnections?: number
  /** Health check interval (ms) */
  healthCheckInterval?: number
  /** Enable automatic reconnection */
  autoReconnect?: boolean
  /** Enable connection pooling */
  connectionPooling?: boolean
}

/**
 * Default manager configuration
 */
const DEFAULT_MANAGER_CONFIG: Required<ExternalAgentManagerConfig> = {
  maxConnections: 10,
  healthCheckInterval: 30000,
  autoReconnect: true,
  connectionPooling: true,
}

const DEFAULT_RETRY_MAX_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 1000
const DEFAULT_RETRY_MAX_DELAY_MS = 30000
const DEFAULT_EXECUTION_TIMEOUT_MS = 300000

interface RetryRuntimeConfig {
  maxRetries: number
  retryDelay: number
  exponentialBackoff: boolean
  maxRetryDelay: number
  retryOnErrors: string[]
}

function createBaseValiditySnapshot(
  source: ExternalAgentValiditySnapshot["source"] = "config",
  protocol: ExternalAgentProtocol = "acp"
): ExternalAgentValiditySnapshot {
  return normalizeExternalAgentValiditySnapshot(
    {
      executable: false,
      checkedAt: new Date(),
      source,
      healthStatus: "unknown",
      sessionExtensions: createUnknownSessionExtensionSupport(),
      negotiation: {
        protocol,
      },
    },
    {
      fallbackProtocol: protocol,
      fallbackSource: source,
    }
  )
}

function buildCorrelationMetadata(
  updates?: Partial<ExternalAgentCorrelationMetadata>
): ExternalAgentCorrelationMetadata {
  return {
    source: updates?.source ?? "manager",
    sessionId: updates?.sessionId,
    turnId: updates?.turnId,
    traceId: updates?.traceId,
    observedAt: updates?.observedAt ?? new Date(),
  }
}

function inferBranchOutcomeFromReason(
  reasonCode: ExternalAgentBranchReasonCode | undefined,
  eligibility: ExternalAgentExecutionEligibility
): ExternalAgentBranchOutcome {
  if (reasonCode === "strict_failure") {
    return "strict_failure"
  }
  if (reasonCode === "fallback_to_builtin") {
    return "fallback"
  }
  if (reasonCode === "agent_not_found" || reasonCode === "configuration_missing") {
    return "builtin"
  }
  return eligibility === "blocked" ? "blocked" : "external"
}

export interface ExternalAgentLifecycleEvent {
  agentId: string
  connectionStatus: ExternalAgentConnectionStatus
  status: ExternalAgentStatus
  lastError?: string
  validity?: ExternalAgentValiditySnapshot
  branchReasonCode?: ExternalAgentBranchReasonCode
  branchReason?: string
  branchOutcome?: ExternalAgentBranchOutcome
  lastRunSnapshot?: ExternalAgentLastRunSnapshot
  lifecycleStage?: ExternalAgentLifecycleCompletenessStage
  blockedStage?: ExternalAgentLifecycleCompletenessStage
  executionEligibility?: ExternalAgentExecutionEligibility
  contractVersion?: number
  correlation?: ExternalAgentCorrelationMetadata
  timestamp: Date
}

/**
 * External Agent Manager
 *
 * Singleton manager for all external agent connections.
 * Provides a unified interface for connecting to, managing, and executing on external agents.
 */
export class ExternalAgentManager {
  private static _instance: ExternalAgentManager | null = null

  private config: Required<ExternalAgentManagerConfig>
  private instances: Map<string, ExternalAgentInstance> = new Map()
  private adapters: Map<string, ProtocolAdapter> = new Map()
  private delegationRules: ExternalAgentDelegationRule[] = []
  private healthCheckTimer?: ReturnType<typeof setInterval>
  private eventListeners: Map<string, Set<(event: ExternalAgentEvent) => void>> = new Map()
  private lifecycleListeners: Set<(event: ExternalAgentLifecycleEvent) => void> = new Set()

  private constructor(config: ExternalAgentManagerConfig = {}) {
    this.config = { ...DEFAULT_MANAGER_CONFIG, ...config }

    // Register default protocol adapters
    this.registerDefaultAdapters()

    // Start health check if interval is set
    if (this.config.healthCheckInterval > 0) {
      this.startHealthCheck()
    }
  }

  // ==========================================================================
  // ACP-specific helpers (optional)
  // ==========================================================================

  async respondToPermission(
    agentId: string,
    sessionId: string,
    response: AcpPermissionResponse
  ): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (!adapter) {
      throw new Error(`Agent not found: ${agentId}`)
    }
    await adapter.respondToPermission(sessionId, response)
  }

  async setSessionMode(
    agentId: string,
    sessionId: string,
    modeId: AcpPermissionMode
  ): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.setSessionMode) {
      throw new Error("Agent does not support session mode changes")
    }
    await adapter.setSessionMode(sessionId, modeId)
  }

  /**
   * Return the live Codex `app-server` adapter for an agent, or null when the
   * agent isn't connected through the native app-server protocol. Lets UI
   * surfaces read MCP-server / skills status (and the native methods) without
   * widening the generic {@link ProtocolAdapter} contract.
   */
  getCodexAppServerAdapter(agentId: string): CodexAppServerAdapter | null {
    const adapter = this.adapters.get(agentId)
    return adapter instanceof CodexAppServerAdapter ? adapter : null
  }

  async setSessionModel(agentId: string, sessionId: string, modelId: string): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.setSessionModel) {
      throw new Error("Agent does not support model selection")
    }
    await adapter.setSessionModel(sessionId, modelId)
  }

  getSessionModels(
    agentId: string,
    sessionId: string
  ): AgentCapabilityResult<AcpSessionModelState> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.getSessionModels) {
      return { status: "unsupported" }
    }
    try {
      const data = adapter.getSessionModels(sessionId)
      return data ? { status: "ok", data } : { status: "unsupported" }
    } catch (error) {
      return { status: "error", error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  /**
   * Set a session config option
   * @see https://agentclientprotocol.com/protocol/session-config-options
   */
  async setConfigOption(
    agentId: string,
    sessionId: string,
    configId: string,
    value: string
  ): Promise<AcpConfigOption[]> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.setConfigOption) {
      throw new Error("Agent does not support config options")
    }
    return adapter.setConfigOption(sessionId, configId, value)
  }

  /**
   * Get session config options
   * @see https://agentclientprotocol.com/protocol/session-config-options
   */
  getConfigOptions(agentId: string, sessionId: string): AgentCapabilityResult<AcpConfigOption[]> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.getConfigOptions) {
      return { status: "unsupported" }
    }
    try {
      const data = adapter.getConfigOptions(sessionId)
      return data ? { status: "ok", data } : { status: "unsupported" }
    } catch (error) {
      return { status: "error", error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  async listSessions(
    agentId: string
  ): Promise<Array<{ sessionId: string; title?: string; createdAt?: string; updatedAt?: string }>> {
    const adapter = this.adapters.get(agentId)
    const instance = this.instances.get(agentId)
    if (!adapter || !instance) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    const support = this.getSessionExtensionSupport(adapter, instance)["session/list"]
    if (support.state === "unsupported") {
      this.updateInstanceState(agentId, instance, {
        validity: {
          source: "execution",
          lifecycleStage: "session_extensions",
        },
        branchReasonCode: support.reasonCode ?? "extension_unsupported",
        branchReason: support.reason ?? "Agent does not support session listing",
        branchOutcome: "blocked",
        correlation: buildCorrelationMetadata(),
      })
      throw createExternalAgentUnsupportedSessionExtensionError("session/list")
    }
    if (!adapter.listSessions) {
      this.setSessionExtensionSupport(
        agentId,
        instance,
        "session/list",
        "unsupported",
        "extension_unsupported",
        "Agent does not support session listing"
      )
      throw createExternalAgentUnsupportedSessionExtensionError("session/list")
    }

    try {
      const sessions = await adapter.listSessions()
      this.setSessionExtensionSupport(agentId, instance, "session/list", "supported", "ok")
      return sessions
    } catch (error) {
      if (
        isExternalAgentMethodNotFoundError(error) ||
        isExternalAgentSessionExtensionUnsupportedForMethod(error, "session/list")
      ) {
        this.setSessionExtensionSupport(
          agentId,
          instance,
          "session/list",
          "unsupported",
          "extension_unsupported",
          "Agent does not support session listing"
        )
        throw createExternalAgentUnsupportedSessionExtensionError("session/list")
      } else {
        this.setSessionExtensionSupport(
          agentId,
          instance,
          "session/list",
          "unknown",
          "extension_unknown",
          this.normalizeErrorMessage(error)
        )
      }
      throw error
    }
  }

  async forkSession(agentId: string, sessionId: string): Promise<ExternalAgentSession> {
    const adapter = this.adapters.get(agentId)
    const instance = this.instances.get(agentId)
    if (!adapter?.forkSession || !instance) {
      if (instance) {
        this.setSessionExtensionSupport(
          agentId,
          instance,
          "session/fork",
          "unsupported",
          "extension_unsupported",
          "Agent does not support session forking"
        )
      }
      throw createExternalAgentUnsupportedSessionExtensionError("session/fork")
    }

    const support = this.getSessionExtensionSupport(adapter, instance)["session/fork"]
    if (support.state === "unsupported") {
      this.updateInstanceState(agentId, instance, {
        validity: {
          source: "execution",
          lifecycleStage: "session_extensions",
        },
        branchReasonCode: support.reasonCode ?? "extension_unsupported",
        branchReason: support.reason ?? "Agent does not support session forking",
        branchOutcome: "blocked",
        correlation: buildCorrelationMetadata(),
      })
      throw createExternalAgentUnsupportedSessionExtensionError("session/fork")
    }

    try {
      const forked = await adapter.forkSession(sessionId)
      instance.sessions.set(forked.id, forked)
      this.setSessionExtensionSupport(agentId, instance, "session/fork", "supported", "ok")
      return forked
    } catch (error) {
      if (
        isExternalAgentMethodNotFoundError(error) ||
        isExternalAgentSessionExtensionUnsupportedForMethod(error, "session/fork")
      ) {
        this.setSessionExtensionSupport(
          agentId,
          instance,
          "session/fork",
          "unsupported",
          "extension_unsupported",
          "Agent does not support session forking"
        )
        throw createExternalAgentUnsupportedSessionExtensionError("session/fork")
      } else {
        this.setSessionExtensionSupport(
          agentId,
          instance,
          "session/fork",
          "unknown",
          "extension_unknown",
          this.normalizeErrorMessage(error)
        )
      }
      throw error
    }
  }

  async resumeSession(
    agentId: string,
    sessionId: string,
    options?: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
    const adapter = this.adapters.get(agentId)
    const instance = this.instances.get(agentId)
    if (!adapter?.resumeSession || !instance) {
      if (instance) {
        this.setSessionExtensionSupport(
          agentId,
          instance,
          "session/resume",
          "unsupported",
          "extension_unsupported",
          "Agent does not support session resume"
        )
      }
      throw createExternalAgentUnsupportedSessionExtensionError("session/resume")
    }

    const support = this.getSessionExtensionSupport(adapter, instance)["session/resume"]
    if (support.state === "unsupported") {
      this.updateInstanceState(agentId, instance, {
        validity: {
          source: "execution",
          lifecycleStage: "session_extensions",
        },
        branchReasonCode: support.reasonCode ?? "extension_unsupported",
        branchReason: support.reason ?? "Agent does not support session resume",
        branchOutcome: "blocked",
        correlation: buildCorrelationMetadata(),
      })
      throw createExternalAgentUnsupportedSessionExtensionError("session/resume")
    }

    try {
      const resumed = await adapter.resumeSession(sessionId, options)
      instance.sessions.set(resumed.id, resumed)
      this.setSessionExtensionSupport(agentId, instance, "session/resume", "supported", "ok")
      return resumed
    } catch (error) {
      if (
        isExternalAgentMethodNotFoundError(error) ||
        isExternalAgentSessionExtensionUnsupportedForMethod(error, "session/resume")
      ) {
        this.setSessionExtensionSupport(
          agentId,
          instance,
          "session/resume",
          "unsupported",
          "extension_unsupported",
          "Agent does not support session resume"
        )
        throw createExternalAgentUnsupportedSessionExtensionError("session/resume")
      } else {
        this.setSessionExtensionSupport(
          agentId,
          instance,
          "session/resume",
          "unknown",
          "extension_unknown",
          this.normalizeErrorMessage(error)
        )
      }
      throw error
    }
  }

  getAuthMethods(agentId: string): AgentCapabilityResult<AcpAuthMethod[]> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.getAuthMethods) {
      return { status: "unsupported" }
    }
    try {
      const data = adapter.getAuthMethods()
      return { status: "ok", data }
    } catch (error) {
      return { status: "error", error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  isAuthenticationRequired(agentId: string): boolean {
    const adapter = this.adapters.get(agentId)
    return adapter?.isAuthenticationRequired ? adapter.isAuthenticationRequired() : false
  }

  async authenticate(
    agentId: string,
    methodId: string,
    credentials?: Record<string, unknown>
  ): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.authenticate) {
      throw new Error("Agent does not support authentication")
    }
    await adapter.authenticate(methodId, credentials)
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: ExternalAgentManagerConfig): ExternalAgentManager {
    if (!ExternalAgentManager._instance) {
      ExternalAgentManager._instance = new ExternalAgentManager(config)
    }
    return ExternalAgentManager._instance
  }

  /**
   * Reset singleton instance (for testing)
   */
  static resetInstance(): void {
    if (ExternalAgentManager._instance) {
      ExternalAgentManager._instance.dispose()
      ExternalAgentManager._instance = null
    }
  }

  /**
   * Register default protocol adapters
   */
  private registerDefaultAdapters(): void {
    protocolAdapterRegistry.register("acp", () => new AcpClientAdapter())
    protocolAdapterRegistry.register("codex-app-server", () => new CodexAppServerAdapter())
    protocolAdapterRegistry.register("opencode", () => new OpenCodeClientAdapter())
    protocolAdapterRegistry.register("a2a", () => new A2aClientAdapter())
    // Future: Register more adapters
    // protocolAdapterRegistry.register('http', () => new HttpClientAdapter());
  }

  private normalizeErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message
    }
    return String(error)
  }

  private isAbortError(error: unknown): boolean {
    const message = this.normalizeErrorMessage(error).toLowerCase()
    return (
      message.includes("aborted") || message.includes("cancelled") || message.includes("canceled")
    )
  }

  private resolveRetryConfig(instance: ExternalAgentInstance): RetryRuntimeConfig {
    const retryConfig = instance.config.retryConfig
    return {
      maxRetries: Math.max(0, retryConfig?.maxRetries ?? DEFAULT_RETRY_MAX_RETRIES),
      retryDelay: Math.max(0, retryConfig?.retryDelay ?? DEFAULT_RETRY_DELAY_MS),
      exponentialBackoff: retryConfig?.exponentialBackoff ?? true,
      maxRetryDelay: Math.max(0, retryConfig?.maxRetryDelay ?? DEFAULT_RETRY_MAX_DELAY_MS),
      retryOnErrors: (retryConfig?.retryOnErrors ?? [])
        .map((pattern) => pattern.trim().toLowerCase())
        .filter((pattern) => pattern.length > 0),
    }
  }

  private computeRetryDelayMs(config: RetryRuntimeConfig, retryAttempt: number): number {
    if (config.retryDelay <= 0) {
      return 0
    }
    if (!config.exponentialBackoff) {
      return Math.min(config.retryDelay, config.maxRetryDelay)
    }
    return Math.min(
      config.retryDelay * Math.pow(2, Math.max(0, retryAttempt - 1)),
      config.maxRetryDelay
    )
  }

  private isRetryableError(error: unknown, retryOnErrors: string[]): boolean {
    if (this.isAbortError(error)) {
      return false
    }

    const message = this.normalizeErrorMessage(error).toLowerCase()
    if (!message) {
      return false
    }

    if (retryOnErrors.some((pattern) => message.includes(pattern))) {
      return true
    }

    const nonRetryablePatterns = [
      "unsupported protocol",
      "agent not found",
      "does not support",
      "only available in the desktop",
      "agent is disabled",
      "configuration not found",
      "maximum connections reached",
    ]
    if (nonRetryablePatterns.some((pattern) => message.includes(pattern))) {
      return false
    }

    const retryablePatterns = [
      "timeout",
      "timed out",
      "temporary",
      "temporarily",
      "connection",
      "network",
      "socket",
      "broken pipe",
      "econn",
      "enet",
      "ehost",
      "503",
      "502",
      "504",
      "429",
      "too many requests",
      "unavailable",
      "reset by peer",
      "closed",
    ]
    return retryablePatterns.some((pattern) => message.includes(pattern))
  }

  private isTimeoutErrorMessage(message: string): boolean {
    const normalized = message.toLowerCase()
    return normalized.includes("timeout") || normalized.includes("timed out")
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  private resolveExecutionTimeoutMs(
    instance: ExternalAgentInstance,
    options?: ExternalAgentExecutionOptions
  ): number {
    const timeout = options?.timeout ?? instance.config.timeout
    if (typeof timeout === "number" && timeout > 0) {
      return timeout
    }
    return DEFAULT_EXECUTION_TIMEOUT_MS
  }

  private resolveStreamIdleTimeoutMs(
    instance: ExternalAgentInstance,
    options?: ExternalAgentExecutionOptions
  ): number {
    const timeoutCandidate =
      options?.timeout ?? instance.config.sessionIdleTimeout ?? instance.config.timeout
    if (typeof timeoutCandidate === "number" && timeoutCandidate > 0) {
      return timeoutCandidate
    }
    return DEFAULT_EXECUTION_TIMEOUT_MS
  }

  private async withTimeout<T>(
    operation: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
    onTimeout?: () => Promise<void> | void
  ): Promise<T> {
    if (timeoutMs <= 0) {
      return operation
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (onTimeout) {
          void Promise.resolve(onTimeout()).catch(() => undefined)
        }
        reject(new Error(timeoutMessage))
      }, timeoutMs)

      operation
        .then((value) => {
          clearTimeout(timeoutId)
          resolve(value)
        })
        .catch((error) => {
          clearTimeout(timeoutId)
          reject(error)
        })
    })
  }

  private getSessionExtensionSupport(
    adapter: ProtocolAdapter,
    instance: ExternalAgentInstance
  ): ExternalAgentSessionExtensionSupport {
    return (
      adapter.getSessionExtensionSupport?.() ||
      instance.validity?.sessionExtensions ||
      createUnknownSessionExtensionSupport()
    )
  }

  private mapConnectionErrorToReasonCode(message: string): ExternalAgentBranchReasonCode {
    const normalized = message.toLowerCase()
    if (normalized.includes("protocol") && normalized.includes("unsupported")) {
      return "protocol_unsupported"
    }
    if (normalized.includes("desktop") || normalized.includes("tauri")) {
      return "transport_blocked"
    }
    if (normalized.includes("health") && normalized.includes("failed")) {
      return "health_check_failed"
    }
    if (normalized.includes("timeout") || normalized.includes("timed out")) {
      return "external_unavailable"
    }
    return "initialization_failed"
  }

  private setSessionExtensionSupport(
    agentId: string,
    instance: ExternalAgentInstance,
    method: keyof ExternalAgentSessionExtensionSupport,
    state: ExternalAgentSupportState,
    reasonCode?: ExternalAgentBranchReasonCode,
    reason?: string
  ): void {
    const current = instance.validity?.sessionExtensions || createUnknownSessionExtensionSupport()
    const now = new Date()
    const next: ExternalAgentSessionExtensionSupport = {
      ...current,
      [method]: {
        state,
        reasonCode,
        reason,
        lastCheckedAt: now,
      },
    }

    this.updateInstanceState(agentId, instance, {
      validity: {
        source: "execution",
        checkedAt: now,
        sessionExtensions: next,
        lifecycleStage: "session_extensions",
      },
      branchReasonCode: reasonCode,
      branchReason: reason,
      branchOutcome:
        state === "unsupported"
          ? "blocked"
          : inferBranchOutcomeFromReason(
              reasonCode,
              instance.validity?.executionEligibility ?? "eligible"
            ),
      correlation: buildCorrelationMetadata({
        source: "manager",
        observedAt: now,
      }),
    })
  }

  /**
   * Capture the outcome of an execution turn as the agent's "last run" snapshot.
   * The settings/diagnostics surfaces read it through the lifecycle bridge
   * (`addLifecycleListener` → store). Set the field before the terminal
   * `updateInstanceState` call so the emitted event carries the fresh snapshot.
   */
  private recordLastRun(
    instance: ExternalAgentInstance,
    snapshot: {
      terminalOutcome: "ok" | "error"
      branchReasonCode: ExternalAgentBranchReasonCode
      branchOutcome: ExternalAgentBranchOutcome
      sessionId?: string
      traceId?: string
      diagnosticText?: string
    }
  ): void {
    const next: ExternalAgentLastRunSnapshot = {
      terminalOutcome: snapshot.terminalOutcome,
      branchReasonCode: snapshot.branchReasonCode,
      branchOutcome: snapshot.branchOutcome,
      timestamp: new Date(),
      linkedSessionId: snapshot.sessionId,
      linkedTraceId: snapshot.traceId,
      diagnosticText: snapshot.diagnosticText,
    }
    instance.lastRunSnapshot = next
  }

  private emitLifecycleEvent(agentId: string, instance: ExternalAgentInstance): void {
    if (this.lifecycleListeners.size === 0) {
      return
    }

    const payload: ExternalAgentLifecycleEvent = {
      agentId,
      connectionStatus: instance.connectionStatus,
      status: instance.status,
      lastError: instance.lastError,
      validity: instance.validity,
      branchReasonCode: instance.validity?.lastBranchReasonCode,
      branchReason: instance.validity?.lastBranchReason,
      branchOutcome: instance.validity?.branchOutcome,
      lastRunSnapshot: instance.lastRunSnapshot,
      lifecycleStage: instance.validity?.lifecycleStage,
      blockedStage: instance.validity?.blockedStage,
      executionEligibility: instance.validity?.executionEligibility,
      contractVersion: instance.validity?.contractVersion,
      correlation: instance.validity?.correlation,
      timestamp: new Date(),
    }

    for (const listener of this.lifecycleListeners) {
      try {
        listener(payload)
      } catch (error) {
        externalAgentManagerLogger.error("External agent lifecycle listener error", error, {
          agentId,
        })
      }
    }
  }

  private updateInstanceState(
    agentId: string,
    instance: ExternalAgentInstance,
    updates: {
      connectionStatus?: ExternalAgentConnectionStatus
      status?: ExternalAgentStatus
      lastError?: string
      validity?: Partial<ExternalAgentValiditySnapshot>
      branchReasonCode?: ExternalAgentBranchReasonCode
      branchReason?: string
      branchOutcome?: ExternalAgentBranchOutcome
      correlation?: Partial<ExternalAgentCorrelationMetadata>
    }
  ): void {
    let changed = false

    if (
      updates.connectionStatus !== undefined &&
      updates.connectionStatus !== instance.connectionStatus
    ) {
      instance.connectionStatus = updates.connectionStatus
      changed = true
    }

    if (updates.status !== undefined && updates.status !== instance.status) {
      instance.status = updates.status
      changed = true
    }

    if (Object.prototype.hasOwnProperty.call(updates, "lastError")) {
      if (updates.lastError !== instance.lastError) {
        instance.lastError = updates.lastError
        changed = true
      }
    }

    const hasValidityUpdate = Boolean(updates.validity)
    const hasBranchReasonCodeUpdate = Object.prototype.hasOwnProperty.call(
      updates,
      "branchReasonCode"
    )
    const hasBranchReasonUpdate = Object.prototype.hasOwnProperty.call(updates, "branchReason")
    const hasBranchOutcomeUpdate = Object.prototype.hasOwnProperty.call(updates, "branchOutcome")
    const hasCorrelationUpdate = Boolean(updates.correlation)

    if (
      hasValidityUpdate ||
      hasBranchReasonCodeUpdate ||
      hasBranchReasonUpdate ||
      hasBranchOutcomeUpdate ||
      hasCorrelationUpdate
    ) {
      const base =
        instance.validity ??
        createBaseValiditySnapshot(updates.validity?.source ?? "config", instance.config.protocol)
      const merged: ExternalAgentValiditySnapshot = {
        ...base,
        ...updates.validity,
        checkedAt: updates.validity?.checkedAt ?? new Date(),
        sessionExtensions:
          updates.validity?.sessionExtensions ??
          base.sessionExtensions ??
          createUnknownSessionExtensionSupport(),
      }

      if (hasBranchReasonCodeUpdate) {
        merged.lastBranchReasonCode = updates.branchReasonCode
      }
      if (hasBranchReasonUpdate) {
        merged.lastBranchReason = updates.branchReason
      }
      if (hasBranchReasonCodeUpdate || hasBranchReasonUpdate) {
        merged.lastBranchAt = new Date()
      }
      if (hasBranchOutcomeUpdate) {
        merged.branchOutcome = updates.branchOutcome
      }
      if (hasCorrelationUpdate) {
        merged.correlation = buildCorrelationMetadata({
          ...(base.correlation ?? {}),
          ...updates.correlation,
        })
      }
      if (!hasBranchOutcomeUpdate) {
        merged.branchOutcome = undefined
      }
      if (!updates.validity?.lifecycleStage) {
        merged.lifecycleStage = undefined
      }
      if (!updates.validity?.blockedStage) {
        merged.blockedStage = undefined
      }
      if (!updates.validity?.recoveryHints) {
        merged.recoveryHints = undefined
      }
      merged.canonicalReasonCode = undefined
      merged.canonicalReason = undefined

      const normalized = normalizeExternalAgentValiditySnapshot(merged, {
        fallbackProtocol: instance.config.protocol,
        fallbackSource: updates.validity?.source ?? base.source,
      })
      instance.validity = normalized
      instance.config.validitySnapshot = normalized
      changed = true
    }

    if (changed) {
      this.emitLifecycleEvent(agentId, instance)
    }
  }

  // ============================================================================
  // Agent Lifecycle
  // ============================================================================

  private async enrichConfigWithDynamicReadiness(
    config: ExternalAgentConfig
  ): Promise<ExternalAgentConfig> {
    const probedReadiness = await probeExternalAgentEcosystemReadiness(config, {
      checkCommandExists: checkExternalAgentCommandExists,
    })

    if (!probedReadiness) {
      return config
    }

    return {
      ...config,
      metadata: projectExternalAgentReadinessMetadata(config.metadata ?? {}, probedReadiness),
    }
  }

  /**
   * Add and connect to an external agent
   */
  async addAgent(config: ExternalAgentConfig): Promise<ExternalAgentInstance> {
    if (this.instances.has(config.id)) {
      throw new Error(`Agent already exists: ${config.id}`)
    }

    if (this.instances.size >= this.config.maxConnections) {
      throw new Error(`Maximum connections reached: ${this.config.maxConnections}`)
    }

    const hydratedConfig = await this.enrichConfigWithDynamicReadiness(config)

    // Create adapter for the protocol
    const adapter = protocolAdapterRegistry.create(hydratedConfig.protocol)
    if (!adapter) {
      const isPluginProtocol =
        typeof hydratedConfig.protocol === "string" && hydratedConfig.protocol.includes(":")
      throw new Error(
        isPluginProtocol
          ? `No protocol adapter registered for "${hydratedConfig.protocol}". This protocol is contributed by a plugin (external-agent-adapter) — enable the plugin that provides it, then reconnect.`
          : `Unsupported protocol: ${hydratedConfig.protocol}`
      )
    }

    // Create instance
    const blockAssessment = getExternalAgentExecutionBlock(hydratedConfig)
    const initialCheckedAt = new Date()
    const initialValidity = normalizeExternalAgentValiditySnapshot(
      {
        ...hydratedConfig.validitySnapshot,
        executable: !blockAssessment,
        checkedAt: hydratedConfig.validitySnapshot?.checkedAt ?? initialCheckedAt,
        source: "config",
        blockingReasonCode:
          blockAssessment?.code ?? hydratedConfig.validitySnapshot?.blockingReasonCode,
        blockingReason: blockAssessment?.reason ?? hydratedConfig.validitySnapshot?.blockingReason,
        healthStatus: hydratedConfig.validitySnapshot?.healthStatus ?? "unknown",
        sessionExtensions:
          hydratedConfig.validitySnapshot?.sessionExtensions ??
          createUnknownSessionExtensionSupport(),
        negotiation: hydratedConfig.validitySnapshot?.negotiation ?? {
          protocol: hydratedConfig.protocol,
        },
        ecosystem:
          hydratedConfig.validitySnapshot?.ecosystem ??
          getExternalAgentEcosystemReadiness(hydratedConfig),
        lastBranchReasonCode:
          blockAssessment?.code ?? hydratedConfig.validitySnapshot?.lastBranchReasonCode,
        lastBranchReason:
          blockAssessment?.reason ?? hydratedConfig.validitySnapshot?.lastBranchReason,
        lastBranchAt:
          blockAssessment?.code || hydratedConfig.validitySnapshot?.lastBranchAt
            ? (hydratedConfig.validitySnapshot?.lastBranchAt ?? initialCheckedAt)
            : undefined,
        canonicalReasonCode: undefined,
        canonicalReason: undefined,
      },
      {
        fallbackProtocol: hydratedConfig.protocol,
        fallbackSource: "config",
      }
    )
    const instance: ExternalAgentInstance = {
      config: hydratedConfig,
      connectionStatus: "disconnected",
      status: "idle",
      sessions: new Map(),
      validity: initialValidity,
      connectionAttempts: 0,
      stats: {
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        totalTokensUsed: 0,
        averageResponseTime: 0,
      },
    }

    this.instances.set(hydratedConfig.id, instance)
    this.adapters.set(hydratedConfig.id, adapter)
    this.emitLifecycleEvent(hydratedConfig.id, instance)

    // Connect if enabled
    if (hydratedConfig.enabled) {
      await this.connect(hydratedConfig.id)
    }

    externalAgentManagerLogger.info("Added external agent", {
      agentId: hydratedConfig.id,
      agentName: hydratedConfig.name,
    })
    return instance
  }

  /**
   * Remove an external agent
   */
  async removeAgent(agentId: string): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (adapter) {
      await adapter.disconnect()
      this.adapters.delete(agentId)
    }

    this.instances.delete(agentId)
    this.eventListeners.delete(agentId)

    externalAgentManagerLogger.info("Removed external agent", { agentId })
  }

  /**
   * Connect to an external agent
   */
  async connect(agentId: string): Promise<void> {
    const instance = this.instances.get(agentId)
    const adapter = this.adapters.get(agentId)

    if (!instance || !adapter) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    instance.config = await this.enrichConfigWithDynamicReadiness(instance.config)

    const blockAssessment = getExternalAgentExecutionBlock(instance.config)
    if (blockAssessment) {
      this.updateInstanceState(agentId, instance, {
        connectionStatus: "error",
        status: "failed",
        lastError: blockAssessment.reason,
        validity: {
          executable: false,
          source: "connect",
          blockingReasonCode: blockAssessment.code,
          blockingReason: blockAssessment.reason,
        },
        branchReasonCode: blockAssessment.code,
        branchReason: blockAssessment.reason,
      })
      throw new Error(blockAssessment.reason)
    }

    adapter.clearSessionExtensionSupportCache?.()
    this.updateInstanceState(agentId, instance, {
      connectionStatus: "connecting",
      status: "initializing",
      validity: {
        source: "connect",
        executable: true,
        checkedAt: new Date(),
        blockingReasonCode: undefined,
        blockingReason: undefined,
        sessionExtensions: this.getSessionExtensionSupport(adapter, instance),
      },
      branchReasonCode: "ok",
      branchReason: "Connecting external agent",
    })

    const retryConfig = this.resolveRetryConfig(instance)
    let lastError: unknown

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      instance.connectionAttempts++
      instance.lastConnectionAttempt = new Date()

      if (attempt > 0) {
        this.updateInstanceState(agentId, instance, {
          connectionStatus: "reconnecting",
        })
      }

      try {
        const connectTimeout = this.resolveExecutionTimeoutMs(instance)
        await this.withTimeout(
          adapter.connect(instance.config),
          connectTimeout,
          `Connection timed out after ${connectTimeout}ms`
        )
        this.updateInstanceState(agentId, instance, {
          connectionStatus: "connected",
          status: "ready",
          lastError: undefined,
          validity: {
            executable: true,
            source: "connect",
            checkedAt: new Date(),
            healthStatus: "healthy",
            lastHealthCheckAt: new Date(),
            blockingReasonCode: undefined,
            blockingReason: undefined,
            negotiation: {
              protocol: instance.config.protocol,
              ...adapter.getAcpInitializationMetadata?.(),
              authRequired: adapter.isAuthenticationRequired?.() ?? false,
            },
            sessionExtensions: this.getSessionExtensionSupport(adapter, instance),
          },
          branchReasonCode: "ok",
          branchReason: "External agent connected",
        })
        instance.capabilities = adapter.capabilities
        instance.tools = adapter.tools

        externalAgentManagerLogger.info("Connected to external agent", { agentId })
        return
      } catch (error) {
        lastError = error
        const errorMessage = this.normalizeErrorMessage(error)
        const reasonCode = this.mapConnectionErrorToReasonCode(errorMessage)
        this.updateInstanceState(agentId, instance, {
          lastError: errorMessage,
          validity: {
            executable: false,
            source: "connect",
            checkedAt: new Date(),
            blockingReasonCode: reasonCode,
            blockingReason: errorMessage,
            healthStatus:
              reasonCode === "health_check_failed" ? "unhealthy" : instance.validity?.healthStatus,
            sessionExtensions: this.getSessionExtensionSupport(adapter, instance),
          },
          branchReasonCode: reasonCode,
          branchReason: errorMessage,
        })

        const shouldRetry =
          attempt < retryConfig.maxRetries &&
          this.isRetryableError(error, retryConfig.retryOnErrors)

        if (!shouldRetry) {
          this.updateInstanceState(agentId, instance, {
            connectionStatus: "error",
            status: "failed",
            validity: {
              executable: false,
              source: "connect",
              checkedAt: new Date(),
            },
          })
          throw error
        }

        const retryDelay = this.computeRetryDelayMs(retryConfig, attempt + 1)
        externalAgentManagerLogger.warn("Retrying external agent connection", {
          agentId,
          attempt: attempt + 1,
          retryDelay,
          error: errorMessage,
        })

        try {
          await adapter.disconnect()
        } catch (cleanupError) {
          externalAgentManagerLogger.warn("Cleanup failed during retry", {
            agentId,
            attempt: attempt + 1,
            error: this.normalizeErrorMessage(cleanupError),
          })
        }
        await this.sleep(retryDelay)
      }
    }

    this.updateInstanceState(agentId, instance, {
      connectionStatus: "error",
      status: "failed",
      validity: {
        executable: false,
        source: "connect",
        checkedAt: new Date(),
      },
      branchReasonCode: "external_unavailable",
      branchReason: "Failed to connect external agent",
    })
    throw lastError instanceof Error
      ? lastError
      : new Error(`Failed to connect external agent "${agentId}"`)
  }

  /**
   * Disconnect from an external agent
   */
  async disconnect(agentId: string): Promise<void> {
    const adapter = this.adapters.get(agentId)
    const instance = this.instances.get(agentId)

    if (adapter) {
      await adapter.disconnect()
    }

    if (instance) {
      this.updateInstanceState(agentId, instance, {
        connectionStatus: "disconnected",
        status: "idle",
        validity: {
          executable: false,
          source: "connect",
          checkedAt: new Date(),
          healthStatus: "unknown",
        },
        branchReasonCode: "external_unavailable",
        branchReason: "External agent disconnected",
      })
      instance.sessions.clear()
    }

    externalAgentManagerLogger.info("Disconnected external agent", { agentId })
  }

  /**
   * Reconnect to an external agent
   */
  async reconnect(agentId: string): Promise<void> {
    const adapter = this.adapters.get(agentId)
    adapter?.clearSessionExtensionSupportCache?.()
    await this.disconnect(agentId)
    await this.connect(agentId)
  }

  // ==========================================================================
  // Session Management
  // ==========================================================================

  private buildSessionOptions(
    instance: ExternalAgentInstance,
    options?: ExternalAgentExecutionOptions
  ): SessionCreateOptions {
    const custom = options?.context?.custom as Record<string, unknown> | undefined
    const mcpServers = Array.isArray(custom?.mcpServers)
      ? (custom?.mcpServers as SessionCreateOptions["mcpServers"])
      : undefined
    const cwdCandidate =
      options?.workingDirectory ||
      (typeof custom?.workingDirectory === "string" ? custom.workingDirectory : undefined) ||
      (typeof custom?.cwd === "string" ? custom.cwd : undefined) ||
      instance.config.process?.cwd

    const metadataPayload = {
      ...(options?.traceContext?.metadata || {}),
      instructionEnvelope: options?.instructionEnvelope,
    } as Record<string, unknown>
    const metadata =
      Object.entries(metadataPayload).filter(([, value]) => value !== undefined).length > 0
        ? metadataPayload
        : undefined

    return {
      cwd: cwdCandidate,
      systemPrompt: options?.systemPrompt,
      context: options?.context as Record<string, unknown> | undefined,
      instructionEnvelope: options?.instructionEnvelope,
      permissionMode: options?.permissionMode,
      timeout: options?.timeout,
      mcpServers,
      metadata,
    }
  }

  private async resolveExecutionSession(
    adapter: ProtocolAdapter,
    instance: ExternalAgentInstance,
    options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentSession> {
    const preferredSessionId =
      options?.sessionId ??
      (typeof options?.context?.custom?.sessionId === "string"
        ? options.context.custom.sessionId
        : undefined)
    const sessionOptions = this.buildSessionOptions(instance, options)

    let session = preferredSessionId
      ? (instance.sessions.get(preferredSessionId) ?? adapter.getSession?.(preferredSessionId))
      : undefined

    if (!session && preferredSessionId) {
      const resumeSupport = this.getSessionExtensionSupport(adapter, instance)["session/resume"]
      const unsupportedByContract = resumeSupport.state === "unsupported"
      const resumeSession = adapter.resumeSession
      const missingResumeMethod = !resumeSession

      if (missingResumeMethod || unsupportedByContract) {
        if (missingResumeMethod) {
          this.setSessionExtensionSupport(
            instance.config.id,
            instance,
            "session/resume",
            "unsupported",
            "extension_unsupported",
            "Agent does not support session resume"
          )
        }
        this.updateInstanceState(instance.config.id, instance, {
          validity: {
            source: "execution",
            lifecycleStage: "session_extensions",
          },
          branchReasonCode: resumeSupport.reasonCode ?? "extension_unsupported",
          branchReason:
            resumeSupport.reason ??
            "Preferred external session cannot be resumed because session/resume is unsupported.",
          branchOutcome: "blocked",
          correlation: buildCorrelationMetadata({
            sessionId: preferredSessionId,
            source: "manager",
          }),
        })
      } else {
        try {
          session = await resumeSession(preferredSessionId, sessionOptions)
        } catch (error) {
          if (
            isExternalAgentMethodNotFoundError(error) ||
            isExternalAgentSessionExtensionUnsupportedForMethod(error, "session/resume")
          ) {
            this.setSessionExtensionSupport(
              instance.config.id,
              instance,
              "session/resume",
              "unsupported",
              "extension_unsupported",
              "Agent does not support session resume"
            )
            this.updateInstanceState(instance.config.id, instance, {
              validity: {
                source: "execution",
                lifecycleStage: "session_extensions",
              },
              branchReasonCode: "extension_unsupported",
              branchReason:
                "Preferred external session cannot be resumed because session/resume is unsupported.",
              branchOutcome: "blocked",
              correlation: buildCorrelationMetadata({
                sessionId: preferredSessionId,
                source: "manager",
              }),
            })
          } else {
            this.updateInstanceState(instance.config.id, instance, {
              branchReasonCode: "session_resolution_failed",
              branchReason: this.normalizeErrorMessage(error),
              branchOutcome: "blocked",
              correlation: buildCorrelationMetadata({
                sessionId: preferredSessionId,
                source: "manager",
              }),
            })
          }
          session = undefined
        }
      }
    }

    if (!session) {
      session = await adapter.createSession(sessionOptions)
      if (preferredSessionId) {
        const latestReasonCode = instance.validity?.lastBranchReasonCode
        const latestReason = instance.validity?.lastBranchReason
        const reasonCode =
          latestReasonCode === "extension_unsupported"
            ? latestReasonCode
            : "session_resolution_failed"
        const reason =
          latestReasonCode === "extension_unsupported"
            ? (latestReason ??
              "Preferred external session cannot be resumed because session/resume is unsupported.")
            : `Preferred external session "${preferredSessionId}" unavailable; created a new session.`
        this.updateInstanceState(instance.config.id, instance, {
          branchReasonCode: reasonCode,
          branchReason: reason,
          branchOutcome: reasonCode === "extension_unsupported" ? "blocked" : "external",
          correlation: buildCorrelationMetadata({
            sessionId: preferredSessionId,
            source: "manager",
          }),
        })
      }
    }

    instance.sessions.set(session.id, session)
    return session
  }

  private resolveTraceSessionId(
    options: ExternalAgentExecutionOptions | undefined,
    acpSessionId: string
  ): string {
    const traceSessionId = options?.traceContext?.sessionId
    if (typeof traceSessionId === "string" && traceSessionId.trim().length > 0) {
      return traceSessionId
    }

    if (typeof options?.sessionId === "string" && options.sessionId.trim().length > 0) {
      return options.sessionId
    }

    const legacySessionId = options?.context?.custom?.sessionId
    if (typeof legacySessionId === "string" && legacySessionId.trim().length > 0) {
      return legacySessionId
    }

    return acpSessionId
  }

  private createTraceBridge(
    agentId: string,
    instance: ExternalAgentInstance,
    session: ExternalAgentSession,
    options?: ExternalAgentExecutionOptions
  ) {
    const traceSessionId = this.resolveTraceSessionId(options, session.id)
    const traceMetadata = options?.traceContext?.metadata
    const modelIdFromMetadata =
      traceMetadata && typeof traceMetadata.modelId === "string" ? traceMetadata.modelId : undefined

    return createExternalAgentTraceBridge({
      sessionId: traceSessionId,
      turnId: options?.traceContext?.turnId ?? traceSessionId,
      traceId: options?.traceContext?.traceId,
      spanId: options?.traceContext?.spanId,
      parentSpanId: options?.traceContext?.parentSpanId,
      tracestate: options?.traceContext?.tracestate,
      modelId: modelIdFromMetadata,
      agentId,
      agentName: instance.config.name,
      protocol: instance.config.protocol,
      transport: instance.config.transport,
      acpSessionId: session.id,
      tags: ["external-agent", ...(options?.traceContext?.tags ?? [])],
      metadata: {
        ...traceMetadata,
      },
    })
  }

  /**
   * Create a session with an external agent
   */
  async createSession(
    agentId: string,
    options?: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
    const adapter = this.adapters.get(agentId)
    const instance = this.instances.get(agentId)

    if (!adapter || !instance) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    if (!adapter.isConnected()) {
      throw new Error(`Agent not connected: ${agentId}`)
    }

    const session = await adapter.createSession(options)
    instance.sessions.set(session.id, session)

    return session
  }

  /**
   * Close a session
   */
  async closeSession(agentId: string, sessionId: string): Promise<void> {
    const adapter = this.adapters.get(agentId)
    const instance = this.instances.get(agentId)

    if (adapter) {
      await adapter.closeSession(sessionId)
    }

    if (instance) {
      instance.sessions.delete(sessionId)
    }
  }

  /**
   * Get a session by ID
   */
  getSession(agentId: string, sessionId: string): ExternalAgentSession | undefined {
    const adapter = this.adapters.get(agentId)
    return adapter?.getSession(sessionId)
  }

  // ============================================================================
  // Execution
  // ============================================================================

  /**
   * Execute a prompt on an external agent (streaming)
   */
  async *executeStreaming(
    agentId: string,
    prompt: string,
    options?: ExternalAgentExecutionOptions
  ): AsyncIterable<ExternalAgentEvent> {
    const adapter = this.adapters.get(agentId)
    const instance = this.instances.get(agentId)

    if (!adapter || !instance) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    if (!adapter.isConnected()) {
      await this.connect(agentId)
    }

    this.updateInstanceState(agentId, instance, { status: "executing" })
    instance.stats.totalExecutions++
    const startTime = Date.now()

    const session = await this.resolveExecutionSession(adapter, instance, options)

    if (
      options?.permissionMode &&
      adapter.setSessionMode &&
      session.permissionMode !== options.permissionMode
    ) {
      await adapter.setSessionMode(session.id, options.permissionMode)
    }

    const traceBridge = this.createTraceBridge(agentId, instance, session, options)
    await traceBridge.onStart(prompt)

    // Create message
    const message: ExternalAgentMessage = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: new Date(),
    }

    const hookCtx: AgentHookContext = {
      agentId,
      sessionId: session.id,
      cwd: options?.workingDirectory || instance.config.process?.cwd || undefined,
    }
    const idleTimeoutMs = this.resolveStreamIdleTimeoutMs(instance, options)
    let streamSuccess = true
    let streamError: string | undefined

    try {
      const streamIterator = adapter.prompt(session.id, message, options)[Symbol.asyncIterator]()

      while (true) {
        const nextResult = await this.withTimeout(
          streamIterator.next(),
          idleTimeoutMs,
          `External agent stream idle timeout after ${idleTimeoutMs}ms`,
          async () => {
            try {
              await adapter.cancel(session.id)
            } catch (cancelError) {
              externalAgentManagerLogger.warn("Cancellation failed during stream timeout", {
                agentId,
                sessionId: session.id,
                error: this.normalizeErrorMessage(cancelError),
              })
            }
          }
        )

        if (nextResult.done) {
          break
        }

        const event = nextResult.value
        if (event.type === "session_start" && event.tools) {
          instance.tools = event.tools
        }

        if (event.type === "done") {
          streamSuccess = event.success
        } else if (event.type === "error") {
          streamSuccess = false
          streamError = event.error
        }

        // Settings.json (System B) + plugin (System A) hooks. A blocking
        // PreToolUse hook denies the permission and suppresses the event so the
        // user is never prompted for a tool the hook already rejected.
        if (event.type === "permission_request") {
          const blocked = await gateExternalAgentPermission(hookCtx, event, (requestId, reason) =>
            this.respondToPermission(agentId, session.id, {
              requestId,
              granted: false,
              reason: `hook denied: ${reason}`,
            })
          )
          if (blocked) continue
        } else {
          observeExternalAgentEvent(hookCtx, event)
        }

        // Emit to listeners
        this.emitEvent(agentId, event)
        options?.onEvent?.(event)
        void traceBridge.onEvent(event)

        // Yield to caller
        yield event
      }

      await traceBridge.onComplete({
        success: streamSuccess,
        finalResponse: "",
        duration: Date.now() - startTime,
        error: streamError,
        branchReasonCode: streamSuccess ? "ok" : "execution_failed",
        branchOutcome: streamSuccess ? "external" : "fallback",
      })

      if (streamSuccess) {
        instance.stats.successfulExecutions++
        this.recordLastRun(instance, {
          terminalOutcome: "ok",
          branchReasonCode: "ok",
          branchOutcome: "external",
          sessionId: session.id,
        })
        this.updateInstanceState(agentId, instance, {
          status: "ready",
          lastError: undefined,
          validity: {
            executable: true,
            source: "execution",
            checkedAt: new Date(),
            healthStatus: "healthy",
            lastHealthCheckAt: new Date(),
          },
          branchReasonCode: "ok",
          branchReason: "External agent streaming execution completed",
        })
      } else {
        instance.stats.failedExecutions++
        this.recordLastRun(instance, {
          terminalOutcome: "error",
          branchReasonCode: "execution_failed",
          branchOutcome: "fallback",
          sessionId: session.id,
          diagnosticText: streamError ?? "External agent execution failed",
        })
        this.updateInstanceState(agentId, instance, {
          status: "failed",
          lastError: streamError ?? "External agent execution failed",
          validity: {
            executable: false,
            source: "execution",
            checkedAt: new Date(),
            blockingReasonCode: "execution_failed",
            blockingReason: streamError ?? "External agent execution failed",
          },
          branchReasonCode: "execution_failed",
          branchReason: streamError ?? "External agent execution failed",
        })
      }
      const latestSession = adapter.getSession?.(session.id)
      if (latestSession) {
        instance.sessions.set(latestSession.id, latestSession)
      }
      instance.tools = adapter.tools ?? instance.tools
    } catch (error) {
      instance.stats.failedExecutions++
      const errorMessage = this.normalizeErrorMessage(error)
      const timeout = this.isTimeoutErrorMessage(errorMessage)
      this.recordLastRun(instance, {
        terminalOutcome: "error",
        branchReasonCode: timeout ? "external_unavailable" : "execution_failed",
        branchOutcome: "fallback",
        diagnosticText: errorMessage,
      })
      this.updateInstanceState(agentId, instance, {
        status: timeout ? "timeout" : "failed",
        lastError: errorMessage,
        validity: {
          executable: false,
          source: "execution",
          checkedAt: new Date(),
          blockingReasonCode: timeout ? "external_unavailable" : "execution_failed",
          blockingReason: errorMessage,
        },
        branchReasonCode: timeout ? "external_unavailable" : "execution_failed",
        branchReason: errorMessage,
      })
      await traceBridge.onError(
        Object.assign(error instanceof Error ? error : new Error(String(error)), {
          branchReasonCode: timeout ? "external_unavailable" : "execution_failed",
          branchOutcome: "fallback",
        })
      )
      throw error
    }
  }

  /**
   * Execute a prompt on an external agent (non-streaming)
   */
  async execute(
    agentId: string,
    prompt: string,
    options?: ExternalAgentExecutionOptions
  ): Promise<ExternalAgentResult> {
    const adapter = this.adapters.get(agentId)
    const instance = this.instances.get(agentId)

    if (!adapter || !instance) {
      throw new Error(`Agent not found: ${agentId}`)
    }

    if (!adapter.isConnected()) {
      await this.connect(agentId)
    }

    this.updateInstanceState(agentId, instance, { status: "executing" })
    instance.stats.totalExecutions++
    const startTime = Date.now()

    const session = await this.resolveExecutionSession(adapter, instance, options)

    if (
      options?.permissionMode &&
      adapter.setSessionMode &&
      session.permissionMode !== options.permissionMode
    ) {
      await adapter.setSessionMode(session.id, options.permissionMode)
    }

    const traceBridge = this.createTraceBridge(agentId, instance, session, options)
    await traceBridge.onStart(prompt)

    // Create message
    const message: ExternalAgentMessage = {
      id: `msg_${Date.now()}`,
      role: "user",
      content: [{ type: "text", text: prompt }],
      timestamp: new Date(),
    }

    const retryConfig = this.resolveRetryConfig(instance)
    const executionTimeoutMs = this.resolveExecutionTimeoutMs(instance, options)
    const hookCtx: AgentHookContext = {
      agentId,
      sessionId: session.id,
      cwd: options?.workingDirectory || instance.config.process?.cwd || undefined,
    }

    try {
      let result: ExternalAgentResult | null = null
      let lastError: unknown

      for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        if (options?.signal?.aborted) {
          throw new Error("External agent execution was aborted")
        }

        try {
          if (!adapter.isConnected()) {
            await this.connect(agentId)
          }

          const wrappedOptions: ExternalAgentExecutionOptions = {
            ...options,
            onEvent: (event) => {
              // Headless path: hooks fire-and-forget. A blocking PreToolUse hook
              // still denies the tool via respondToPermission; there is no
              // permission UI to suppress on this path.
              if (event.type === "permission_request") {
                void gateExternalAgentPermission(hookCtx, event, (requestId, reason) =>
                  this.respondToPermission(agentId, session.id, {
                    requestId,
                    granted: false,
                    reason: `hook denied: ${reason}`,
                  })
                )
              } else {
                observeExternalAgentEvent(hookCtx, event)
              }
              options?.onEvent?.(event)
              void traceBridge.onEvent(event)
            },
          }

          const attemptResult = await this.withTimeout(
            adapter.execute(session.id, message, wrappedOptions),
            executionTimeoutMs,
            `External agent execution timed out after ${executionTimeoutMs}ms`,
            async () => {
              try {
                await adapter.cancel(session.id)
              } catch (cancelError) {
                externalAgentManagerLogger.warn("Cancellation failed during execution timeout", {
                  agentId,
                  sessionId: session.id,
                  error: this.normalizeErrorMessage(cancelError),
                })
              }
            }
          )

          if (
            !attemptResult.success &&
            attempt < retryConfig.maxRetries &&
            this.isRetryableError(
              attemptResult.errorCode || attemptResult.error || "External agent execution failed",
              retryConfig.retryOnErrors
            )
          ) {
            const retryDelay = this.computeRetryDelayMs(retryConfig, attempt + 1)
            lastError = new Error(
              attemptResult.error || attemptResult.errorCode || "External agent execution failed"
            )
            externalAgentManagerLogger.warn(
              "Retrying external agent execution after recoverable failure",
              {
                agentId,
                attempt: attempt + 1,
                retryDelay,
              }
            )
            await this.sleep(retryDelay)
            continue
          }

          result = attemptResult
          break
        } catch (error) {
          lastError = error
          const shouldRetry =
            attempt < retryConfig.maxRetries &&
            this.isRetryableError(error, retryConfig.retryOnErrors) &&
            !(options?.signal?.aborted ?? false)

          if (!shouldRetry) {
            throw error
          }

          const retryDelay = this.computeRetryDelayMs(retryConfig, attempt + 1)
          externalAgentManagerLogger.warn("Retrying external agent execution after error", {
            agentId,
            attempt: attempt + 1,
            retryDelay,
            error: this.normalizeErrorMessage(error),
          })

          if (!adapter.isConnected() && this.config.autoReconnect) {
            try {
              await this.connect(agentId)
            } catch {
              // Continue retry loop with original error.
            }
          }

          await this.sleep(retryDelay)
        }
      }

      if (!result) {
        throw lastError instanceof Error
          ? lastError
          : new Error(`External agent execution failed for ${agentId}`)
      }

      await traceBridge.onComplete({
        ...result,
        branchReasonCode: result.success ? "ok" : "execution_failed",
        branchOutcome: result.success ? "external" : "fallback",
      })

      const responseTime = Date.now() - startTime
      instance.stats.averageResponseTime =
        (instance.stats.averageResponseTime * (instance.stats.totalExecutions - 1) + responseTime) /
        instance.stats.totalExecutions

      if (result.success) {
        instance.stats.successfulExecutions++
        this.recordLastRun(instance, {
          terminalOutcome: "ok",
          branchReasonCode: "ok",
          branchOutcome: "external",
          sessionId: result.sessionId || session.id,
        })
        this.updateInstanceState(agentId, instance, {
          status: "ready",
          lastError: undefined,
          validity: {
            executable: true,
            source: "execution",
            checkedAt: new Date(),
            healthStatus: "healthy",
            lastHealthCheckAt: new Date(),
          },
          branchReasonCode: "ok",
          branchReason: "External agent execution completed",
        })
      } else {
        instance.stats.failedExecutions++
        this.recordLastRun(instance, {
          terminalOutcome: "error",
          branchReasonCode: "execution_failed",
          branchOutcome: "fallback",
          sessionId: result.sessionId || session.id,
          diagnosticText: result.error ?? "External agent execution failed",
        })
        this.updateInstanceState(agentId, instance, {
          status: "failed",
          lastError: result.error ?? "External agent execution failed",
          validity: {
            executable: false,
            source: "execution",
            checkedAt: new Date(),
            blockingReasonCode: "execution_failed",
            blockingReason: result.error ?? "External agent execution failed",
          },
          branchReasonCode: "execution_failed",
          branchReason: result.error ?? "External agent execution failed",
        })
      }

      // Update stats
      instance.tools = adapter.tools ?? instance.tools
      const latestSession = adapter.getSession?.(result.sessionId || session.id)
      if (latestSession) {
        instance.sessions.set(latestSession.id, latestSession)
      }
      if (result.tokenUsage) {
        instance.stats.totalTokensUsed += result.tokenUsage.totalTokens
      }
      return result
    } catch (error) {
      instance.stats.failedExecutions++
      const errorMessage = this.normalizeErrorMessage(error)
      const timeout = this.isTimeoutErrorMessage(errorMessage)
      this.recordLastRun(instance, {
        terminalOutcome: "error",
        branchReasonCode: timeout ? "external_unavailable" : "execution_failed",
        branchOutcome: "fallback",
        diagnosticText: errorMessage,
      })
      this.updateInstanceState(agentId, instance, {
        status: timeout ? "timeout" : "failed",
        lastError: errorMessage,
        validity: {
          executable: false,
          source: "execution",
          checkedAt: new Date(),
          blockingReasonCode: timeout ? "external_unavailable" : "execution_failed",
          blockingReason: errorMessage,
        },
        branchReasonCode: timeout ? "external_unavailable" : "execution_failed",
        branchReason: errorMessage,
      })
      await traceBridge.onError(
        Object.assign(error instanceof Error ? error : new Error(String(error)), {
          branchReasonCode: timeout ? "external_unavailable" : "execution_failed",
          branchOutcome: "fallback",
        })
      )
      throw error
    }
  }

  /**
   * Cancel an ongoing execution
   */
  async cancel(agentId: string, sessionId: string): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (adapter) {
      await adapter.cancel(sessionId)
    }

    const instance = this.instances.get(agentId)
    if (instance) {
      this.updateInstanceState(agentId, instance, {
        status: "ready",
        branchReasonCode: "ok",
        branchReason: "External execution cancelled by caller",
      })
    }
  }

  // ============================================================================
  // Tool Integration
  // ============================================================================

  /**
   * Get all tools from an external agent as Cognia AgentTools
   */
  getAgentTools(
    agentId: string,
    executeCallback?: (
      toolId: string,
      name: string,
      input: Record<string, unknown>
    ) => Promise<string>
  ): Record<string, AgentTool> {
    const instance = this.instances.get(agentId)
    if (!instance?.tools) {
      return {}
    }

    const defaultCallback = async (
      toolId: string,
      name: string,
      input: Record<string, unknown>
    ): Promise<string> => {
      // Execute tool via external agent
      const result = await this.executeToolOnAgent(agentId, toolId, name, input)
      return typeof result === "string" ? result : JSON.stringify(result)
    }

    return acpToolsToAgentTools(instance.tools, executeCallback || defaultCallback)
  }

  /**
   * Execute a tool on an external agent
   */
  private async executeToolOnAgent(
    agentId: string,
    _toolId: string,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<string | Record<string, unknown>> {
    // Create a prompt that asks the agent to execute the tool
    const prompt = `Execute the tool "${toolName}" with the following input:\n${JSON.stringify(input, null, 2)}`

    const result = await this.execute(agentId, prompt, {
      maxSteps: 1,
    })

    return result.finalResponse || result.output || ""
  }

  /**
   * Get all tools from all connected agents
   */
  getAllAgentTools(): Record<string, AgentTool> {
    const allTools: Record<string, AgentTool> = {}

    for (const [agentId, instance] of this.instances) {
      if (instance.connectionStatus === "connected" && instance.tools) {
        const agentTools = this.getAgentTools(agentId)
        // Prefix with agent ID to avoid conflicts
        for (const [name, tool] of Object.entries(agentTools)) {
          allTools[`${agentId}:${name}`] = tool
        }
      }
    }

    return allTools
  }

  // ============================================================================
  // Delegation Rules
  // ============================================================================

  /**
   * Add a delegation rule
   */
  addDelegationRule(rule: ExternalAgentDelegationRule): void {
    this.delegationRules.push(rule)
    // Sort by priority (descending)
    this.delegationRules.sort((a, b) => b.priority - a.priority)
  }

  /**
   * Replace ALL delegation rules in one shot (priority-sorted). Used to sync
   * the persisted store's `delegationRules` into the manager before a chat
   * turn calls `checkDelegation`, so the matcher sees the user's live rules
   * without accumulating duplicates across turns.
   */
  setDelegationRules(rules: ExternalAgentDelegationRule[]): void {
    this.delegationRules = [...rules].sort((a, b) => b.priority - a.priority)
  }

  /**
   * Remove a delegation rule
   */
  removeDelegationRule(ruleId: string): void {
    const index = this.delegationRules.findIndex((r) => r.id === ruleId)
    if (index !== -1) {
      this.delegationRules.splice(index, 1)
    }
  }

  /**
   * Check if a task should be delegated to an external agent
   */
  checkDelegation(task: string, _context?: Record<string, unknown>): ExternalAgentDelegationResult {
    for (const rule of this.delegationRules) {
      if (!rule.enabled) continue

      const instance = this.instances.get(rule.targetAgentId)
      if (!instance || instance.connectionStatus !== "connected") continue

      let matched = false

      switch (rule.condition) {
        case "always":
          matched = true
          break

        case "keyword":
          matched = new RegExp(rule.matcher, "i").test(task)
          break

        case "task-type":
          matched = this.matchTaskType(task, rule.matcher)
          break

        case "capability":
          matched = this.matchCapability(instance, rule.matcher)
          break

        case "tool-needed":
          matched = this.matchToolNeeded(task, instance, rule.matcher)
          break

        case "custom":
          // Custom matchers would be evaluated differently
          // For now, treat as a regex
          matched = new RegExp(rule.matcher, "i").test(task)
          break
      }

      if (matched) {
        return {
          shouldDelegate: true,
          targetAgentId: rule.targetAgentId,
          matchedRule: rule,
          reason: `Matched rule: ${rule.name}`,
          reasonCode: "ok",
        }
      }
    }

    return {
      shouldDelegate: false,
      reason: "No matching delegation rule",
      reasonCode: "external_unavailable",
    }
  }

  /**
   * Match task type
   */
  private matchTaskType(task: string, matcher: string): boolean {
    const taskTypes: Record<string, RegExp> = {
      coding: /\b(code|implement|fix|debug|refactor|write.*function|create.*class|build)\b/i,
      analysis: /\b(analyze|review|audit|check|examine|investigate)\b/i,
      documentation: /\b(document|write.*readme|add.*comments|explain)\b/i,
      testing: /\b(test|unit test|e2e|coverage|mock)\b/i,
      deployment: /\b(deploy|release|build|publish|ci|cd)\b/i,
    }

    const regex = taskTypes[matcher]
    return regex ? regex.test(task) : false
  }

  /**
   * Match capability
   */
  private matchCapability(instance: ExternalAgentInstance, capability: string): boolean {
    if (!instance.capabilities) return false

    const caps = instance.capabilities as Record<string, unknown>
    return !!caps[capability]
  }

  /**
   * Match tool needed
   */
  private matchToolNeeded(
    task: string,
    instance: ExternalAgentInstance,
    toolPattern: string
  ): boolean {
    if (!instance.tools) return false

    const regex = new RegExp(toolPattern, "i")
    const hasMatchingTool = instance.tools.some((t) => regex.test(t.name))

    // Also check if task mentions the tool
    const taskMentionsTool = instance.tools.some((t) =>
      task.toLowerCase().includes(t.name.toLowerCase())
    )

    return hasMatchingTool && taskMentionsTool
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  /**
   * Get an agent instance by ID
   */
  getAgent(agentId: string): ExternalAgentInstance | undefined {
    return this.instances.get(agentId)
  }

  /**
   * Get all agent instances
   */
  getAllAgents(): ExternalAgentInstance[] {
    return Array.from(this.instances.values())
  }

  /**
   * Get agents by status
   */
  getAgentsByStatus(status: ExternalAgentConnectionStatus): ExternalAgentInstance[] {
    return Array.from(this.instances.values()).filter((i) => i.connectionStatus === status)
  }

  /**
   * Get connected agents
   */
  getConnectedAgents(): ExternalAgentInstance[] {
    return this.getAgentsByStatus("connected")
  }

  /**
   * Check if any agents are connected
   */
  hasConnectedAgents(): boolean {
    return this.getConnectedAgents().length > 0
  }

  /**
   * Get agent capabilities
   */
  getAgentCapabilities(agentId: string): AcpCapabilities | undefined {
    return this.instances.get(agentId)?.capabilities
  }

  /**
   * Get agent tools
   */
  getAgentToolInfo(agentId: string): AcpToolInfo[] | undefined {
    return this.instances.get(agentId)?.tools
  }

  // ============================================================================
  // Health Check
  // ============================================================================

  /**
   * Start periodic health checks
   */
  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(async () => {
      await this.performHealthCheck()
    }, this.config.healthCheckInterval)
  }

  /**
   * Stop periodic health checks
   */
  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = undefined
    }
  }

  /**
   * Perform health check on all connected agents
   */
  async performHealthCheck(): Promise<void> {
    for (const [agentId, adapter] of this.adapters) {
      const instance = this.instances.get(agentId)
      if (!instance || instance.connectionStatus !== "connected") continue

      try {
        const healthy = await adapter.healthCheck()
        this.updateInstanceState(agentId, instance, {
          validity: {
            source: "health",
            checkedAt: new Date(),
            executable: healthy,
            healthStatus: healthy ? "healthy" : "unhealthy",
            lastHealthCheckAt: new Date(),
            blockingReasonCode: healthy ? undefined : "health_check_failed",
            blockingReason: healthy ? undefined : "External agent health check failed",
          },
          branchReasonCode: healthy ? "ok" : "health_check_failed",
          branchReason: healthy
            ? "External agent health check succeeded"
            : "External agent health check failed",
        })
        if (!healthy && this.config.autoReconnect) {
          externalAgentManagerLogger.warn("External agent unhealthy, reconnecting", {
            agentId,
          })
          await this.reconnect(agentId)
        }
      } catch (error) {
        externalAgentManagerLogger.error("External agent health check failed", error, {
          agentId,
        })
        this.updateInstanceState(agentId, instance, {
          validity: {
            source: "health",
            checkedAt: new Date(),
            executable: false,
            healthStatus: "unhealthy",
            lastHealthCheckAt: new Date(),
            blockingReasonCode: "health_check_failed",
            blockingReason: this.normalizeErrorMessage(error),
          },
          branchReasonCode: "health_check_failed",
          branchReason: this.normalizeErrorMessage(error),
        })
        if (this.config.autoReconnect) {
          await this.reconnect(agentId)
        }
      }
    }
  }

  /**
   * Manual health check for a specific agent
   */
  async checkAgentHealth(agentId: string): Promise<boolean> {
    const adapter = this.adapters.get(agentId)
    const instance = this.instances.get(agentId)
    if (!adapter) return false

    try {
      const healthy = await adapter.healthCheck()
      if (instance) {
        this.updateInstanceState(agentId, instance, {
          validity: {
            source: "health",
            checkedAt: new Date(),
            executable: healthy,
            healthStatus: healthy ? "healthy" : "unhealthy",
            lastHealthCheckAt: new Date(),
            blockingReasonCode: healthy ? undefined : "health_check_failed",
            blockingReason: healthy ? undefined : "External agent health check failed",
          },
          branchReasonCode: healthy ? "ok" : "health_check_failed",
          branchReason: healthy
            ? "External agent health check succeeded"
            : "External agent health check failed",
        })
      }
      return healthy
    } catch (error) {
      if (instance) {
        this.updateInstanceState(agentId, instance, {
          validity: {
            source: "health",
            checkedAt: new Date(),
            executable: false,
            healthStatus: "unhealthy",
            lastHealthCheckAt: new Date(),
            blockingReasonCode: "health_check_failed",
            blockingReason: this.normalizeErrorMessage(error),
          },
          branchReasonCode: "health_check_failed",
          branchReason: this.normalizeErrorMessage(error),
        })
      }
      return false
    }
  }

  // ============================================================================
  // Event Handling
  // ============================================================================

  /**
   * Subscribe to lifecycle/status updates across all agents.
   */
  addLifecycleListener(listener: (event: ExternalAgentLifecycleEvent) => void): () => void {
    this.lifecycleListeners.add(listener)
    return () => {
      this.lifecycleListeners.delete(listener)
    }
  }

  /**
   * Add event listener for an agent
   */
  addEventListener(agentId: string, listener: (event: ExternalAgentEvent) => void): () => void {
    let listeners = this.eventListeners.get(agentId)
    if (!listeners) {
      listeners = new Set()
      this.eventListeners.set(agentId, listeners)
    }
    listeners.add(listener)

    return () => {
      listeners?.delete(listener)
    }
  }

  /**
   * Emit event to listeners
   */
  private emitEvent(agentId: string, event: ExternalAgentEvent): void {
    const listeners = this.eventListeners.get(agentId)
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event)
        } catch (error) {
          externalAgentManagerLogger.error("External agent event listener error", error, {
            agentId,
          })
        }
      }
    }
  }

  // ============================================================================
  // Cleanup
  // ============================================================================

  /**
   * Dispose of the manager
   */
  async dispose(): Promise<void> {
    this.stopHealthCheck()

    // Disconnect all agents
    for (const agentId of this.instances.keys()) {
      try {
        await this.disconnect(agentId)
      } catch (error) {
        externalAgentManagerLogger.error(
          "Failed to disconnect external agent during dispose",
          error,
          {
            agentId,
          }
        )
      }
    }

    this.instances.clear()
    this.adapters.clear()
    this.delegationRules = []
    this.eventListeners.clear()
    this.lifecycleListeners.clear()
  }
}

/**
 * Get the global external agent manager instance
 */
export function getExternalAgentManager(config?: ExternalAgentManagerConfig): ExternalAgentManager {
  return ExternalAgentManager.getInstance(config)
}

/**
 * Convenience function to check delegation for a task
 */
export function checkExternalAgentDelegation(
  task: string,
  context?: Record<string, unknown>
): ExternalAgentDelegationResult {
  return getExternalAgentManager().checkDelegation(task, context)
}

/**
 * Convenience function to execute on the best matching external agent
 */
export async function executeOnExternalAgent(
  prompt: string,
  options?: ExternalAgentExecutionOptions & { agentId?: string }
): Promise<ExternalAgentResult | null> {
  const manager = getExternalAgentManager()

  // If specific agent ID provided, use it
  if (options?.agentId) {
    return manager.execute(options.agentId, prompt, options)
  }

  // Check delegation rules
  const delegation = manager.checkDelegation(prompt)
  if (delegation.shouldDelegate && delegation.targetAgentId) {
    return manager.execute(delegation.targetAgentId, prompt, options)
  }

  // No suitable external agent found
  return null
}
