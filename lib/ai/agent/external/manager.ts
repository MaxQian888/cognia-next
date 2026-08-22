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
  ExternalAgentHookFireEvent,
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
  AcpElicitationResponse,
  AcpAuthMethod,
  AcpSessionModelState,
  AcpConfigOption,
} from "@/types/agent/external-agent"
import type { AgentTool } from "@/lib/ai/agent"
import { loggers } from "@cognia/logging"
import {
  type ProtocolAdapter,
  protocolAdapterRegistry,
  type SessionCreateOptions,
  type SessionListOptions,
} from "./protocol-adapter"
import { AcpClientAdapter } from "./acp-client"
import { CodexAppServerAdapter } from "./codex-app-server-client"
import { OpenCodeClientAdapter } from "./opencode-client"
import { OpenCodeV2ClientAdapter } from "./opencode-v2-client"
import { A2aClientAdapter } from "./a2a-client"
import { DshSdkClientAdapter } from "./dsh-sdk-client"
import { PiRpcClientAdapter } from "./pi-rpc-client"
import { createDshRuntimeTransport, resolveDshLaunchFromConfig } from "./dsh-runtime-transport"
import { supportsExternalAgents } from "./agent-transport"
import { acpToolsToAgentTools } from "./translators"
import { createExternalAgentTraceBridge } from "./agent-trace-bridge"
import {
  observeExternalAgentEvent,
  gateExternalAgentPermission,
  type AgentHookContext,
  type EmitHookNotice,
} from "./agent-hooks"
import {
  getExternalAgentExecutionBlock,
  getExternalAgentEcosystemReadiness,
  getUnsupportedProtocolReason,
  probeExternalAgentEcosystemReadiness,
  projectExternalAgentReadinessMetadata,
} from "./config-normalizer"
import { adaptPermissionMode } from "./permission-modes"
import {
  createExternalAgentUnsupportedSessionExtensionError,
  isExternalAgentMethodNotFoundError,
  isExternalAgentSessionExtensionUnsupportedForMethod,
} from "./session-extension-errors"
import {
  createUnknownSessionExtensionSupport,
  normalizeExternalAgentValiditySnapshot,
} from "./canonical-contract"
import { checkExternalAgentCommandExists, onExternalAgentExit } from "@/lib/native/external-agent"
import { isTauri } from "@/lib/tauri"
import { negotiateCapabilityProfile, withRegisteredPluginDeclaration } from "./capability-profile"
import { liveCapabilityFacts } from "./capability-live-facts"
import { externalAgentPresetIdOf } from "./preset-identity"
import { externalAgentSandboxSupportsPlatform } from "./security-policy"
import type {
  ExternalAgentCapabilityProfileV1,
  ExternalAgentHostCeilings,
  ExternalAgentHostFacts,
} from "@cognia/agent-config-types/external-agent-capability"
import type {
  ExternalAgentCompactionCapability,
  ExternalAgentCompactionOptions,
  ExternalAgentProviderUndoCapability,
} from "./session-capabilities"
import type { AcpAvailableCommand } from "@/types/agent/external-agent"
import {
  canonicalEventFromExternalEvent,
  createEnvelopeSequencer,
  redactAgentEventEnvelope,
} from "@/lib/ai/agent/execution/event-envelope"
import { appendCanonicalEnvelopes } from "@/lib/ai/agent/recovery/canonical-log"

const externalAgentManagerLogger = loggers.agent.child("external-manager")

/**
 * Whether a process-exit event should downgrade the manager's instance to
 * `disconnected`. Only an *established* `connected` instance whose adapter now
 * confirms it is gone is reconciled — in-flight connects/reconnects
 * (`connecting`/`reconnecting`) and adapters that self-healed
 * (`adapter.isConnected()` still true) are left alone. Pure so the
 * reconcile decision is unit-tested without constructing the manager.
 */
export function shouldReconcileExitToDisconnected(
  connectionStatus: ExternalAgentConnectionStatus,
  adapterConnected: boolean
): boolean {
  return connectionStatus === "connected" && !adapterConnected
}

// ============================================================================
// Capability Result Type
// ============================================================================

/**
 * Typed result for agent capability queries.
 * Distinguishes between "unsupported", "ok with data", and "error".
 */
export type AgentCapabilityResult<T> =
  { status: "ok"; data: T } | { status: "unsupported" } | { status: "error"; error: Error }

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
  private processExitUnlisten?: Promise<() => void>
  private intentionalProcessStops = new Set<string>()

  private constructor(config: ExternalAgentManagerConfig = {}) {
    this.config = { ...DEFAULT_MANAGER_CONFIG, ...config }

    // Register default protocol adapters
    this.registerDefaultAdapters()

    // Start health check if interval is set
    if (this.config.healthCheckInterval > 0) {
      this.startHealthCheck()
    }

    // Reconcile a dead process back to the instance state proactively, instead
    // of waiting for the next health-check tick (which left the panel showing a
    // dead agent as "connected"). See `shouldReconcileExitToDisconnected`.
    this.subscribeToProcessExits()
  }

  /**
   * Subscribe once to the native `external-agent://exit` channel so a process
   * death is mirrored into `instance.connectionStatus`. No-op off desktop.
   */
  private subscribeToProcessExits(): void {
    if (!isTauri()) return
    this.processExitUnlisten = onExternalAgentExit((event) => {
      // Adapter listeners receive the same event and synchronously move their
      // transport to disconnected/reconnecting. Reconcile in the next
      // microtask so listener registration order cannot produce a false
      // "still connected" decision.
      queueMicrotask(() => {
        void this.handleProcessExit(event.agentId)
      })
    })
  }

  /**
   * A spawned external-agent process exited. Reconcile an established link to
   * `disconnected`, then reconnect through the manager's existing retry path.
   * Guards skip intentional stops, in-flight adapter reconnects, and adapters
   * that already self-healed.
   */
  private async handleProcessExit(agentId: string): Promise<void> {
    const instance = this.instances.get(agentId)
    const adapter = this.adapters.get(agentId)
    if (!instance || !adapter) return
    if (this.intentionalProcessStops.has(agentId)) return
    if (adapter.connectionStatus === "connecting" || adapter.connectionStatus === "reconnecting") {
      return
    }
    if (!shouldReconcileExitToDisconnected(instance.connectionStatus, adapter.isConnected())) {
      return
    }
    this.updateInstanceState(agentId, instance, {
      connectionStatus: "disconnected",
      status: "idle",
    })
    instance.sessions.clear()

    if (!this.config.autoReconnect || !instance.config.enabled) {
      return
    }

    externalAgentManagerLogger.warn("External agent process exited, reconnecting", { agentId })
    try {
      await this.connect(agentId)
    } catch (error) {
      // `connect()` already records the terminal error/validity state after
      // exhausting the configured retry policy; this log preserves context.
      externalAgentManagerLogger.error("External agent process reconnect failed", error, {
        agentId,
      })
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
   * Append user input to a session's in-flight turn without interrupting it
   * (Codex `turn/steer`). Throws when the adapter lacks the capability or no
   * turn is active — callers fall back to their queue-and-replay path.
   */
  async steerSession(agentId: string, sessionId: string | undefined, text: string): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.steerTurn) {
      throw new Error("Agent does not support steering an active turn")
    }
    // The chat layer knows its own session id, not the external thread id —
    // resolve the agent's single executing session when omitted.
    const targetSessionId =
      sessionId ?? adapter.getSessions().find((session) => session.status === "executing")?.id
    if (!targetSessionId) {
      throw new Error("No executing session to steer")
    }
    await adapter.steerTurn(targetSessionId, text)
  }

  /** Whether the agent's adapter can steer an in-flight turn. */
  supportsSteering(agentId: string): boolean {
    return typeof this.adapters.get(agentId)?.steerTurn === "function"
  }

  async getCompactionCapability(
    agentId: string,
    sessionId: string
  ): Promise<ExternalAgentCompactionCapability> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.getCompactionCapability) {
      return { status: "unsupported", routes: [], reason: "adapter_unsupported" }
    }
    return adapter.getCompactionCapability(sessionId)
  }

  async compactSession(
    agentId: string,
    sessionId: string,
    options?: ExternalAgentCompactionOptions
  ): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.compactSession) {
      throw new Error("Agent does not support context compaction")
    }
    await adapter.compactSession(sessionId, options)
  }

  async getProviderUndoCapability(
    agentId: string,
    sessionId: string
  ): Promise<ExternalAgentProviderUndoCapability> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.getProviderUndoCapability) {
      return { status: "unsupported", reason: "adapter_unsupported" }
    }
    return adapter.getProviderUndoCapability(sessionId)
  }

  async undoLastProviderChange(agentId: string, sessionId: string): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.undoLastProviderChange) {
      throw new Error("Agent does not support provider undo")
    }
    await adapter.undoLastProviderChange(sessionId)
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

  /**
   * Return the live OpenCode adapter for an agent, or null when the agent isn't
   * connected through the `opencode` protocol. The OpenCode-specific surfaces
   * (share links, session diff/todos, PTY, TUI driving, dynamic MCP, workspace
   * find/*, VCS/project info) live on the adapter rather than the generic
   * {@link ProtocolAdapter} contract — this is the sanctioned way for UI code
   * to reach them (mirrors {@link getCodexAppServerAdapter}).
   */
  getOpenCodeAdapter(agentId: string): OpenCodeClientAdapter | null {
    const adapter = this.adapters.get(agentId)
    return adapter instanceof OpenCodeClientAdapter ? adapter : null
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
      // An adapter whose implementation is async (Pi-RPC, which has to ask the
      // process) cannot satisfy this synchronous capability. Report it
      // unsupported — the alternative was returning the pending promise as if
      // it were the model state, which every caller then rendered as one.
      if (data instanceof Promise) return { status: "unsupported" }
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
    value: string | boolean
  ): Promise<AcpConfigOption[]> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.setConfigOption) {
      throw new Error("Agent does not support config options")
    }
    return adapter.setConfigOption(sessionId, configId, value)
  }

  async respondToElicitation(agentId: string, response: AcpElicitationResponse): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.respondToElicitation) {
      throw new Error("Agent does not support elicitation")
    }
    await adapter.respondToElicitation(response)
  }

  async cancelRequest(agentId: string, requestId: number | string): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (!adapter?.cancelRequest) {
      throw new Error("Agent does not support request cancellation")
    }
    await adapter.cancelRequest(requestId)
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
      // See `getSessionModels` above: an async adapter cannot satisfy this
      // synchronous capability, and a pending promise is not a config list.
      if (data instanceof Promise) return { status: "unsupported" }
      return data ? { status: "ok", data } : { status: "unsupported" }
    } catch (error) {
      return { status: "error", error: error instanceof Error ? error : new Error(String(error)) }
    }
  }

  async listSessions(
    agentId: string,
    options?: SessionListOptions
  ): Promise<
    Array<{
      sessionId: string
      cwd?: string
      additionalDirectories?: string[]
      title?: string
      createdAt?: string
      updatedAt?: string
    }>
  > {
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
      const sessions = options ? await adapter.listSessions(options) : await adapter.listSessions()
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

  async forkSession(
    agentId: string,
    sessionId: string,
    options?: SessionCreateOptions
  ): Promise<ExternalAgentSession> {
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
      const forked = await adapter.forkSession(sessionId, options)
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
   * Log out of an agent's authenticated session (ACP v1 `logout`). The inverse
   * of {@link authenticate}; no-ops on adapters that don't support it.
   */
  async logout(agentId: string): Promise<void> {
    const adapter = this.adapters.get(agentId)
    await adapter?.logout?.()
  }

  /**
   * Delete a session from the agent's listings (ACP v1 `session/delete`).
   * Falls back to a local close when the adapter cannot delete.
   */
  async deleteSession(agentId: string, sessionId: string): Promise<void> {
    const adapter = this.adapters.get(agentId)
    if (adapter?.deleteSession) {
      await adapter.deleteSession(sessionId)
    } else {
      await adapter?.closeSession(sessionId)
    }
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
   * Return the live singleton WITHOUT creating it. Lifecycle code (e.g. the
   * plugin-disable path) uses this to tear down agents only when a manager
   * actually exists, instead of instantiating the heavy manager (and its
   * health-check timer) as a side effect of disabling an unrelated plugin.
   */
  static peekInstance(): ExternalAgentManager | null {
    return ExternalAgentManager._instance
  }

  /**
   * Register default protocol adapters
   */
  private registerDefaultAdapters(): void {
    protocolAdapterRegistry.register("acp", () => new AcpClientAdapter())
    protocolAdapterRegistry.register("codex-app-server", () => new CodexAppServerAdapter())
    protocolAdapterRegistry.register("opencode", () => new OpenCodeClientAdapter())
    protocolAdapterRegistry.register("opencode-v2", () => new OpenCodeV2ClientAdapter())
    protocolAdapterRegistry.register("a2a", () => new A2aClientAdapter())
    // Must stay in set-equality with SUPPORTED_EXTERNAL_AGENT_PROTOCOLS in
    // config-normalizer.ts; `dsh-sdk-client.test.ts` pins it.
    protocolAdapterRegistry.register(
      "dsh-sdk",
      () =>
        new DshSdkClientAdapter({
          createTransport: (config) =>
            createDshRuntimeTransport(config, resolveDshLaunchFromConfig, supportsExternalAgents()),
        })
    )
    // Pi's own RPC protocol, not ACP (ADR-0119). Registered here rather than
    // only declared in the protocol union — a protocol that is listed as
    // supported but never registered makes `addAgent` throw
    // `Unsupported protocol` at the point of use.
    protocolAdapterRegistry.register("pi-rpc", () => new PiRpcClientAdapter())
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
      "process exited",
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
      this.intentionalProcessStops.add(agentId)
      try {
        await adapter.disconnect()
      } finally {
        this.intentionalProcessStops.delete(agentId)
      }
      this.adapters.delete(agentId)
    }

    this.instances.delete(agentId)
    this.eventListeners.delete(agentId)
    this.capabilityCommandSignatures.delete(agentId)

    externalAgentManagerLogger.info("Removed external agent", { agentId })
  }

  /**
   * Tear down every connected agent whose protocol is in `protocols`: disconnect
   * (which kills the spawned process through the adapter) and drop the in-memory
   * adapter so a disabled plugin leaves no resident protocol logic or leaked
   * child process behind. The agent instance is KEPT but marked non-executable
   * so the UI can explain why and {@link restoreAgentsForProtocols} can revive it
   * when the providing plugin is re-enabled. Returns the affected agent ids.
   *
   * Called when an `external-agent-adapter` plugin is disabled/uninstalled: its
   * `${pluginId}:${id}` protocols leave the registry, but a live agent already
   * created against one would otherwise keep its spawned process running.
   */
  async teardownAgentsByProtocols(protocols: Iterable<string>): Promise<string[]> {
    const target = new Set(protocols)
    if (target.size === 0) {
      return []
    }

    const affected: string[] = []
    for (const [agentId, instance] of this.instances) {
      if (target.has(instance.config.protocol)) {
        affected.push(agentId)
      }
    }

    for (const agentId of affected) {
      try {
        await this.disconnect(agentId)
      } catch (error) {
        externalAgentManagerLogger.warn("Error disconnecting agent during protocol teardown", {
          agentId,
          error: this.normalizeErrorMessage(error),
        })
      }
      // Drop the adapter so no resident protocol logic outlives the plugin that
      // contributed it. The config/instance stays for restore + UI explanation.
      this.adapters.delete(agentId)
      this.capabilityCommandSignatures.delete(agentId)
      const instance = this.instances.get(agentId)
      if (instance) {
        // The profile described what the now-unloaded adapter could do. Keeping
        // it would let a surface answer "this agent supports steering" about an
        // agent that has no adapter at all — the same stale-answer failure the
        // profile exists to remove, one level up.
        instance.capabilityProfile = undefined
        this.updateInstanceState(agentId, instance, {
          connectionStatus: "disconnected",
          status: "idle",
          validity: {
            executable: false,
            source: "config",
            checkedAt: new Date(),
            healthStatus: "unknown",
            blockingReasonCode: "protocol_unsupported",
            blockingReason: getUnsupportedProtocolReason(instance.config.protocol),
          },
          branchReasonCode: "protocol_unsupported",
          branchReason: getUnsupportedProtocolReason(instance.config.protocol),
        })
      }
    }

    if (affected.length > 0) {
      externalAgentManagerLogger.info("Tore down external agents for removed protocols", {
        protocols: Array.from(target),
        agentIds: affected,
      })
    }
    return affected
  }

  /**
   * Re-create adapter instances for agents whose protocol just became available
   * again (the providing plugin was re-enabled) but whose adapter was dropped by
   * {@link teardownAgentsByProtocols}. Re-derives executability and leaves the
   * agent DISCONNECTED so the user (or auto-connect) decides when to reconnect.
   * Synchronous — pure re-instantiation, no I/O. Returns the restored agent ids.
   */
  restoreAgentsForProtocols(protocols: Iterable<string>): string[] {
    const target = new Set(protocols)
    if (target.size === 0) {
      return []
    }

    const restored: string[] = []
    for (const [agentId, instance] of this.instances) {
      if (!target.has(instance.config.protocol) || this.adapters.has(agentId)) {
        continue
      }
      const adapter = protocolAdapterRegistry.create(instance.config.protocol)
      if (!adapter) {
        continue
      }
      this.adapters.set(agentId, adapter)
      const blockAssessment = getExternalAgentExecutionBlock(instance.config)
      this.updateInstanceState(agentId, instance, {
        connectionStatus: "disconnected",
        status: "idle",
        validity: {
          executable: !blockAssessment,
          source: "config",
          checkedAt: new Date(),
          healthStatus: "unknown",
          blockingReasonCode: blockAssessment?.code,
          blockingReason: blockAssessment?.reason,
        },
        branchReasonCode: blockAssessment?.code,
        branchReason: blockAssessment?.reason,
      })
      restored.push(agentId)
    }

    if (restored.length > 0) {
      externalAgentManagerLogger.info("Restored external agents for re-registered protocols", {
        protocols: Array.from(target),
        agentIds: restored,
      })
    }
    return restored
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
        // ADR-0090 external SSOT: the handshake has happened, so this is the
        // first moment a capability answer may be trusted. Every surface reads
        // the profile from here; nothing re-derives capabilities from the
        // preset, the protocol or the adapter's method list on its own.
        this.refreshCapabilityProfile(agentId, instance, adapter)

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
      this.intentionalProcessStops.add(agentId)
      try {
        await adapter.disconnect()
      } finally {
        this.intentionalProcessStops.delete(agentId)
      }
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
    const additionalDirectories = Array.isArray(custom?.additionalDirectories)
      ? custom.additionalDirectories.filter(
          (directory): directory is string => typeof directory === "string"
        )
      : undefined
    const cwdCandidate =
      options?.workingDirectory ||
      (typeof custom?.workingDirectory === "string" ? custom.workingDirectory : undefined) ||
      (typeof custom?.cwd === "string" ? custom.cwd : undefined) ||
      instance.config.process?.cwd

    const metadataPayload = {
      ...(options?.traceContext?.metadata || {}),
      instructionEnvelope: options?.instructionEnvelope,
      // Per-agent Codex defaults (sandbox mode / reasoning effort / summary)
      // ride to the adapter through metadata — same channel as selectedModel.
      codexOptions: instance.config.codexOptions,
      // Per-execution thinking level. Rides the same metadata channel as
      // `selectedModel`, and because the Codex client only applies
      // `codexOptions.defaultReasoningEffort` when this is undefined, setting it
      // here gives the composer's per-session choice precedence over the
      // per-agent default — matching how model/provider layer everywhere else.
      reasoningEffort: options?.reasoningEffort,
      // The requested model rides the same channel the interactive model picker
      // writes, which is the only one adapters read (e.g. the Codex app-server
      // client lifts it into `thread/start` params.model). Callers used to pass
      // a `model` that nothing consumed.
      selectedModel: options?.model,
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
      permissionMode: this.resolveEffectivePermissionMode(instance, options?.permissionMode),
      allowedTools: options?.allowedTools,
      timeout: options?.timeout,
      mcpServers,
      additionalDirectories,
      metadata,
    }
  }

  /**
   * Clamp a requested permission mode to what the agent's backend can actually
   * enforce (e.g. Codex has no `dontAsk`). Returns `undefined` when no mode was
   * requested so the adapter keeps its own default. Keeping this on the manager
   * means the mode persisted on the session — and surfaced to the UI — always
   * matches the mode the backend runs under.
   */
  private resolveEffectivePermissionMode(
    instance: ExternalAgentInstance,
    requested: AcpPermissionMode | undefined
  ): AcpPermissionMode | undefined {
    if (!requested) return undefined
    return adaptPermissionMode(requested, instance.config.protocol).mode
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
    // A cached session was created earlier, with an earlier `selectedModel`;
    // unlike createSession/resumeSession it never sees `sessionOptions`, so a
    // model requested now has to be applied to it explicitly (below).
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

    if (options?.model) {
      await this.applyModelToSession(adapter, session, options.model)
    }

    instance.sessions.set(session.id, session)
    return session
  }

  /**
   * Switch an already-created session onto a newly requested model.
   *
   * Best-effort by design: an adapter with no model concept has nothing to
   * switch, and a rejected model id should not kill an execution that can still
   * run on the session's current model. Both cases are logged rather than
   * thrown, matching how the rest of session resolution degrades.
   */
  private async applyModelToSession(
    adapter: ProtocolAdapter,
    session: ExternalAgentSession,
    model: string
  ): Promise<void> {
    // Awaited: unlike the public `getConfigOptions` capability, this call site
    // is already async and can wait for an adapter that has to ask its process.
    const configOptions = await adapter.getConfigOptions?.(session.id)
    const modelOption = configOptions?.find(
      (option): option is Extract<AcpConfigOption, { type: "select" }> =>
        option.category === "model" && option.type === "select"
    )
    if (modelOption && adapter.setConfigOption) {
      if (modelOption.currentValue === model) {
        session.metadata = { ...(session.metadata ?? {}), selectedModel: model }
        return
      }
      try {
        await adapter.setConfigOption(session.id, modelOption.id, model)
        session.metadata = { ...(session.metadata ?? {}), selectedModel: model }
      } catch (error) {
        // Best effort: the agent can reject an unknown or unavailable model, but
        // the current session remains usable on its existing model.
        externalAgentManagerLogger.warn("setConfigOption failed for model", {
          sessionId: session.id,
          model,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      return
    }

    const current = (session.metadata as Record<string, unknown> | undefined)?.selectedModel
    if (current === model) return
    if (!adapter.setSessionModel) return
    try {
      await adapter.setSessionModel(session.id, model)
      session.metadata = { ...(session.metadata ?? {}), selectedModel: model }
    } catch (error) {
      externalAgentManagerLogger.warn("setSessionModel failed for a reused session", {
        sessionId: session.id,
        model,
        error: error instanceof Error ? error.message : String(error),
      })
    }
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

    const canonicalRunId = options?.traceContext?.traceId ?? session.id
    const canonicalEnvelope = createEnvelopeSequencer({
      sessionId: session.id,
      runId: canonicalRunId,
      attemptId: options?.traceContext?.spanId ?? `external:${startTime}`,
      hostRef: "external-agent-manager",
      runtime: instance.config.protocol,
      turnId: options?.traceContext?.turnId ?? `turn:${startTime}`,
    })

    const effectivePermissionMode = this.resolveEffectivePermissionMode(
      instance,
      options?.permissionMode
    )
    if (
      effectivePermissionMode &&
      adapter.setSessionMode &&
      session.permissionMode !== effectivePermissionMode
    ) {
      await adapter.setSessionMode(session.id, effectivePermissionMode)
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
      agentKind: "external",
      agentRef: agentId,
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
        await appendCanonicalEnvelopes(canonicalRunId, [
          redactAgentEventEnvelope(
            canonicalEnvelope(canonicalEventFromExternalEvent(event as unknown as { type: string }))
          ),
        ])
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
        // user is never prompted for a tool the hook already rejected. A
        // consequential fire is forwarded as a synthetic `hook_fire` event so
        // the chat shows an inline hook-notice row.
        const emitHookNotice: EmitHookNotice = (notice) => {
          const hookEvent: ExternalAgentHookFireEvent = {
            type: "hook_fire",
            timestamp: new Date(),
            sessionId: session.id,
            ...notice,
          }
          this.emitEvent(agentId, hookEvent)
          options?.onEvent?.(hookEvent)
          void traceBridge.onEvent(hookEvent)
        }
        if (event.type === "permission_request") {
          const blocked = await gateExternalAgentPermission(
            hookCtx,
            event,
            (requestId, reason) =>
              this.respondToPermission(agentId, session.id, {
                requestId,
                granted: false,
                reason: `hook denied: ${reason}`,
              }),
            emitHookNotice
          )
          if (blocked) continue
        } else {
          void observeExternalAgentEvent(hookCtx, event, emitHookNotice)
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

    const effectivePermissionMode = this.resolveEffectivePermissionMode(
      instance,
      options?.permissionMode
    )
    if (
      effectivePermissionMode &&
      adapter.setSessionMode &&
      session.permissionMode !== effectivePermissionMode
    ) {
      await adapter.setSessionMode(session.id, effectivePermissionMode)
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
      agentKind: "external",
      agentRef: agentId,
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

          const emitHookNotice: EmitHookNotice = (notice) => {
            const hookEvent: ExternalAgentHookFireEvent = {
              type: "hook_fire",
              timestamp: new Date(),
              sessionId: session.id,
              ...notice,
            }
            this.emitEvent(agentId, hookEvent)
            options?.onEvent?.(hookEvent)
            void traceBridge.onEvent(hookEvent)
          }
          const wrappedOptions: ExternalAgentExecutionOptions = {
            ...options,
            onEvent: (event) => {
              // Headless path: hooks fire-and-forget. A blocking PreToolUse hook
              // still denies the tool via respondToPermission; there is no
              // permission UI to suppress on this path. A consequential fire is
              // forwarded as a synthetic `hook_fire` event so the chat shows an
              // inline hook-notice row.
              if (event.type === "permission_request") {
                void gateExternalAgentPermission(
                  hookCtx,
                  event,
                  (requestId, reason) =>
                    this.respondToPermission(agentId, session.id, {
                      requestId,
                      granted: false,
                      reason: `hook denied: ${reason}`,
                    }),
                  emitHookNotice
                )
              } else {
                void observeExternalAgentEvent(hookCtx, event, emitHookNotice)
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
          matched = this.matchCustom(task, rule.matcher)
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
   * Evaluate a `custom` delegation matcher. The matcher string is either:
   *  - a JSON-encoded structured spec — a safe boolean combination of regex /
   *    substring tests (`{ regex, flags }`, `{ contains }`, `{ all }`,
   *    `{ any }`, `{ not }`), evaluated without any code execution; or
   *  - a plain string, treated as a case-insensitive regex (the historical
   *    behavior — preserved for backward compatibility).
   *
   * An invalid regex or malformed spec never throws: it yields `false` so a
   * broken rule simply does not match rather than crashing the turn.
   */
  private matchCustom(task: string, matcher: string): boolean {
    const trimmed = matcher.trim()
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return this.evalCustomSpec(task, JSON.parse(trimmed))
      } catch {
        return false
      }
    }
    try {
      return new RegExp(matcher, "i").test(task)
    } catch {
      return false
    }
  }

  /** Recursively evaluate a structured custom-matcher spec against the task. */
  private evalCustomSpec(task: string, spec: unknown): boolean {
    if (typeof spec !== "object" || spec === null) return false
    const s = spec as Record<string, unknown>

    if (Array.isArray(s.all)) {
      return s.all.every((sub) => this.evalCustomSpec(task, sub))
    }
    if (Array.isArray(s.any)) {
      return s.any.some((sub) => this.evalCustomSpec(task, sub))
    }
    if ("not" in s) {
      return !this.evalCustomSpec(task, s.not)
    }
    if (typeof s.regex === "string") {
      try {
        const flags = typeof s.flags === "string" ? s.flags : "i"
        return new RegExp(s.regex, flags).test(task)
      } catch {
        return false
      }
    }
    if (s.contains !== undefined) {
      const needles = Array.isArray(s.contains) ? s.contains : [s.contains]
      const haystack = task.toLowerCase()
      // Any listed substring present satisfies a `contains` node.
      return needles.some((n) => typeof n === "string" && haystack.includes(n.toLowerCase()))
    }
    return false
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
   * The merged capability profile for a connected agent (ADR-0090 external SSOT).
   *
   * `undefined` before the agent connects, and that absence is meaningful: it
   * is the difference between "we have not asked yet" and "we asked and the
   * answer is no". Callers that need a pre-connect answer build a DECLARED
   * profile themselves via `preflightExternalAgent`, which is explicitly not
   * allowed to freeze an execution decision.
   */
  getAgentCapabilityProfile(agentId: string): ExternalAgentCapabilityProfileV1 | undefined {
    const instance = this.instances.get(agentId)
    if (!instance?.capabilityProfile) return instance?.capabilityProfile
    const adapter = this.adapters.get(agentId)
    // Recompute when the agent's advertised command set has moved. ACP has no
    // compaction method, so `/compact` being advertised is the ONLY evidence
    // for the `compaction` capability — and it arrives mid-session, after the
    // connect-time profile was built. Reading a stale profile here is how a
    // `/compact` that works reports as unavailable for the rest of the session.
    const signature = this.advertisedCommandSignature(instance)
    if (adapter && signature !== this.capabilityCommandSignatures.get(agentId)) {
      this.refreshCapabilityProfile(agentId, instance, adapter)
    }
    return instance.capabilityProfile
  }

  /**
   * Command signature the cached profile was built against.
   *
   * Kept in the manager rather than on the instance: it is cache bookkeeping,
   * and `ExternalAgentInstance` is a contract other surfaces read.
   */
  private capabilityCommandSignatures = new Map<string, string>()

  private advertisedCommandSignature(instance: ExternalAgentInstance): string {
    const commands = this.collectAdvertisedCommands(instance)
    return commands
      ? commands
          .map((command) => command.name)
          .sort()
          .join("\u0000")
      : ""
  }

  /**
   * Rebuild the capability profile from what is known right now.
   *
   * Called on connect, and again whenever a session's advertised command list
   * changes — `compaction` is genuinely per-session on ACP (the only route is
   * a `/compact` the agent chose to advertise), so a profile computed at
   * connect time would answer it wrong for the rest of the agent's life.
   */
  private refreshCapabilityProfile(
    agentId: string,
    instance: ExternalAgentInstance,
    adapter: ProtocolAdapter
  ): void {
    const availableCommands = this.collectAdvertisedCommands(instance)
    const presetId = externalAgentPresetIdOf(instance.config)
    const profile = negotiateCapabilityProfile(
      withRegisteredPluginDeclaration({
        protocol: instance.config.protocol,
        ...(presetId ? { presetId } : {}),
        adapter: adapter as unknown as Record<string, unknown>,
        hostFacts: this.resolveHostFacts(),
        ceilings: this.resolveHostCeilings(),
        liveFacts: liveCapabilityFacts({
          ...(adapter.capabilities ? { negotiated: adapter.capabilities } : {}),
          ...(availableCommands ? { availableCommands } : {}),
        }),
      })
    )
    instance.capabilityProfile = profile
    this.capabilityCommandSignatures.set(agentId, this.advertisedCommandSignature(instance))
    if (profile.drift.length > 0) {
      // Drift is a maintenance signal, not a session failure: the agent in
      // front of us disagrees with a checked-in manifest row, and the row is
      // the thing that needs updating.
      externalAgentManagerLogger.warn("External agent capability drift", {
        agentId,
        protocol: instance.config.protocol,
        drift: profile.drift,
      })
    }
  }

  /**
   * What the RENDERER host adds to an external turn.
   *
   * `hookRuntimeAvailable` is unconditionally true here because the renderer's
   * execution seams call `observeExternalAgentEvent` / `gateExternalAgentPermission`
   * on every external turn with no host gate — the plugin hook system (System
   * A) runs in-process everywhere, and the settings.json command runtime
   * (System B) additionally on desktop. The CLI, which wraps nothing, reports
   * `false`, and that difference is exactly why this is a host fact rather
   * than a protocol row.
   *
   * The tool host is a CLI facility: the renderer projects Cognia's tools into
   * an external agent through per-session MCP servers, not through the
   * broker/socket bridge, so there is no broker to report as running here.
   */
  private resolveHostFacts(): ExternalAgentHostFacts {
    return {
      toolHostRunning: false,
      subagentDispatchProjected: false,
      hookRuntimeAvailable: true,
    }
  }

  /**
   * Hard clamps for this host.
   *
   * Sandbox availability is the only one today, and it is a real refusal
   * rather than a degradation: Cognia never runs an external agent
   * unsandboxed, so a platform without Seatbelt or bubblewrap cannot run one
   * at all. Off-desktop there is no spawn path to sandbox in the first place,
   * so the clamp does not apply.
   */
  private resolveHostCeilings(): ExternalAgentHostCeilings {
    if (!isTauri()) return { sandboxAvailable: true }
    return { sandboxAvailable: externalAgentSandboxSupportsPlatform() }
  }

  /**
   * The union of every live session's advertised commands.
   *
   * Union rather than "the newest session" because the commands are a property
   * of the AGENT; a session that has not received its `available_commands`
   * notification yet must not retract what another session already proved.
   */
  private collectAdvertisedCommands(
    instance: ExternalAgentInstance
  ): AcpAvailableCommand[] | undefined {
    const seen = new Map<string, AcpAvailableCommand>()
    let sawAny = false
    for (const session of instance.sessions.values()) {
      const commands = session.metadata?.availableCommands as AcpAvailableCommand[] | undefined
      if (!commands) continue
      sawAny = true
      for (const command of commands) seen.set(command.name, command)
    }
    return sawAny ? [...seen.values()] : undefined
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
