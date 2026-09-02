/**
 * useExternalAgent Hook
 *
 * React hook for managing external agent connections and interactions.
 * Provides a simple interface for connecting to, managing, and executing on external agents.
 */

"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { loggers } from "@cognia/logging"
import type {
  CreateExternalAgentInput,
  ExternalAgentBenchmarkCapabilityEntry,
  ExternalAgentSession,
  ExternalAgentEvent,
  ExternalAgentResult,
  ExternalAgentExecutionOptions,
  ExternalAgentInstance,
  ExternalAgentConnectionStatus,
  AcpCapabilities,
  AcpToolInfo,
  AcpPermissionRequest,
  AcpPermissionResponse,
  AcpElicitationRequest,
  AcpElicitationResponse,
  AcpAvailableCommand,
  AcpPlanEntry,
  AcpPermissionMode,
  AcpSessionModelState,
  AcpAuthMethod,
  AcpTerminalAuthState,
  AcpListProvidersResponse,
  AcpSetProviderRequest,
  AcpSetProviderResponse,
  AcpDisableProviderRequest,
  AcpDisableProviderResponse,
  AcpStartNesRequest,
  AcpStartNesResponse,
  AcpSuggestNesRequest,
  AcpSuggestNesResponse,
  AcpCloseNesRequest,
  AcpCloseNesResponse,
  AcpDynamicMcpConnectionState,
  AcpContentBlock,
  AcpCompactionUpdate,
  AcpNesSuggestion,
  AcpConfigOption,
  ExternalAgentLastRunSnapshot,
  ExternalAgentPlanDocument,
  ExternalAgentValiditySnapshot,
} from "@/types/agent/external-agent"
import type { AgentTool } from "@/lib/ai/agent"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import {
  getExternalAgentExecutionBlockReason,
  getExternalAgentExecutionBlock,
  isExternalAgentExecutable,
  normalizeExternalAgentConfigInput,
} from "@/lib/ai/agent/external/config-normalizer"

const externalAgentLogger = loggers.agent.child("external-agent-hook")
import { isExternalAgentSessionExtensionUnsupportedForMethod } from "@/lib/ai/agent/external/session-extension-errors"
import { normalizeExternalAgentValiditySnapshot } from "@/lib/ai/agent/external/canonical-contract"
import { describeExternalAgentFailure } from "@/lib/ai/agent/external/agent-failure"
import {
  clearExternalAgentSelectionIfActive,
  selectExternalAgent,
} from "@/lib/agent/external-agent-selection"
import type {
  SessionCreateOptions,
  SessionListOptions,
} from "@/lib/ai/agent/external/protocol-adapter"
import type {
  ExternalAgentCompactionCapability,
  ExternalAgentCompactionOptions,
  ExternalAgentProviderUndoCapability,
} from "@/lib/ai/agent/external/session-capabilities"
import type { ExternalAgentCapabilityProfileV1 } from "@cognia/agent-config-types/external-agent-capability"

// ============================================================================
// Validity projection
// ============================================================================

interface CachedValidityNormalization {
  fallbackProtocol: string | undefined
  fallbackSource: string | undefined
  value: ExternalAgentValiditySnapshot
}

/**
 * `normalizeExternalAgentValiditySnapshot` builds a fresh object per call (and
 * mints `checkedAt` when the input lacks one), so re-projecting an *unchanged*
 * runtime validity used to yield a value that could never compare equal to the
 * one already in the store. Caching by the source snapshot's identity makes the
 * projection referentially stable, which is what lets `refresh()` below detect
 * "nothing actually changed" and skip the write.
 *
 * Why that matters: `refresh()` writes into the store, and the store subscriber
 * calls `refresh()` — so a write that isn't genuinely needed re-triggers itself
 * forever. The manager replaces `instance.validity` wholesale on every real
 * change (`updateInstanceState`), so keying on identity tracks real changes
 * exactly. The options are part of the key because the same snapshot normalised
 * under a different fallback protocol/source is a different value.
 */
const normalizedValidityBySource = new WeakMap<object, CachedValidityNormalization>()

function stableNormalizeValidity(
  snapshot: ExternalAgentValiditySnapshot,
  options: { fallbackProtocol?: string; fallbackSource?: ExternalAgentValiditySnapshot["source"] }
): ExternalAgentValiditySnapshot {
  const cached = normalizedValidityBySource.get(snapshot)
  if (
    cached &&
    cached.fallbackProtocol === options.fallbackProtocol &&
    cached.fallbackSource === options.fallbackSource
  ) {
    return cached.value
  }
  const value = normalizeExternalAgentValiditySnapshot(snapshot, {
    fallbackProtocol: options.fallbackProtocol as never,
    fallbackSource: options.fallbackSource,
  })
  normalizedValidityBySource.set(snapshot, {
    fallbackProtocol: options.fallbackProtocol,
    fallbackSource: options.fallbackSource,
    value,
  })
  return value
}

// ============================================================================
// Types
// ============================================================================

/**
 * External agent hook state
 */
export interface UseExternalAgentState {
  /** All registered external agents */
  agents: ExternalAgentInstance[]
  /** Currently active agent ID */
  activeAgentId: string | null
  /** Currently active session */
  activeSession: ExternalAgentSession | null
  /** Whether any operation is in progress */
  isLoading: boolean
  /** Whether currently executing a prompt */
  isExecuting: boolean
  /** Last error message */
  error: string | null
  /** Current execution progress (0-100) */
  progress: number
  /** Pending permission request */
  pendingPermission: AcpPermissionRequest | null
  /** Pending blocking question from the agent (not a tool approval) */
  pendingElicitation: AcpElicitationRequest | null
  /** Available slash commands for the active session */
  availableCommands: AcpAvailableCommand[]
  /** Current plan entries for the active session */
  planEntries: AcpPlanEntry[]
  /** Current plan step index */
  planStep: number | null
  /** Active ACP file/Markdown identified plan. */
  planDocument: ExternalAgentPlanDocument | null
  /** Streaming response text */
  streamingResponse: string
  /** Last execution result */
  lastResult: ExternalAgentResult | null
  /** Session config options (ACP spec) */
  configOptions: AcpConfigOption[]
  /** Structured ACP blocks retained alongside the legacy text stream. */
  richContentBlocks: AcpContentBlock[]
  /** Preview compaction state received from the active session. */
  compactionUpdates: AcpCompactionUpdate[]
  /** Preview NES suggestions received from the active session. */
  nesSuggestions: AcpNesSuggestion[]
  /** Validity snapshot for the currently active agent */
  activeAgentValidity: ExternalAgentValiditySnapshot | null
  /** Durable last-run snapshot for the active agent */
  activeLastRunSnapshot: ExternalAgentLastRunSnapshot | null
  /** Benchmark adaptation entries for the active agent */
  activeBenchmarkCapabilities: ExternalAgentBenchmarkCapabilityEntry[]
}

/**
 * External agent hook actions
 */
export interface UseExternalAgentActions {
  /** Add a new external agent configuration */
  addAgent: (config: CreateExternalAgentInput) => Promise<ExternalAgentInstance>
  /** Remove an external agent */
  removeAgent: (agentId: string) => Promise<void>
  /** Connect to an external agent */
  connect: (agentId: string) => Promise<void>
  /** Disconnect from an external agent */
  disconnect: (agentId: string) => Promise<void>
  /** Reconnect to an external agent */
  reconnect: (agentId: string) => Promise<void>
  /** Set the active agent */
  setActiveAgent: (agentId: string | null) => void
  /** Create a new session with the active agent */
  createSession: (options?: SessionCreateOptions) => Promise<ExternalAgentSession>
  /** Close a session */
  closeSession: (sessionId: string) => Promise<void>
  /** List existing sessions (ACP extension) */
  listSessions: (
    agentId?: string,
    options?: SessionListOptions
  ) => Promise<
    Array<{
      sessionId: string
      cwd?: string
      additionalDirectories?: string[]
      title?: string
      createdAt?: string
      updatedAt?: string
    }>
  >
  /** Fork a session (ACP extension) */
  forkSession: (sessionId: string, options?: SessionCreateOptions) => Promise<ExternalAgentSession>
  /** Trigger provider-owned context compaction. */
  compactSession: (sessionId: string, options?: ExternalAgentCompactionOptions) => Promise<void>
  /** Whether the active agent supports provider-owned context compaction. */
  supportsCompaction: boolean
  /** Whether an advertised compaction command accepts focus instructions. */
  supportsCompactionFocus: boolean
  /** Provider capability snapshot used by advanced UI affordances. */
  compactionCapability: ExternalAgentCompactionCapability
  /** Whether compaction is waiting for provider-confirmed completion. */
  isCompacting: boolean
  /** Execute the provider's advertised `/undo` command. */
  undoLastProviderChange: (sessionId: string) => Promise<void>
  /** Provider-native undo capability snapshot. */
  providerUndoCapability: ExternalAgentProviderUndoCapability
  /** Whether the per-agent provider-undo warning has been acknowledged. */
  providerUndoAcknowledged: boolean
  /** Persist the provider-undo warning acknowledgement for this agent. */
  acknowledgeProviderUndoWarning: () => void
  /** Restore the provider-undo warning for this agent. */
  resetProviderUndoWarning: () => void
  /** Whether provider undo is currently running. */
  isProviderUndoing: boolean
  /** Resume a session (ACP extension) */
  resumeSession: (
    sessionId: string,
    options?: SessionCreateOptions
  ) => Promise<ExternalAgentSession>
  /** Execute a prompt on the active agent */
  execute: (prompt: string, options?: ExternalAgentExecutionOptions) => Promise<ExternalAgentResult>
  /** Execute a prompt with streaming */
  executeStreaming: (
    prompt: string,
    options?: ExternalAgentExecutionOptions
  ) => AsyncIterable<ExternalAgentEvent>
  /** Cancel the current execution */
  cancel: () => Promise<void>
  /** Respond to a permission request */
  respondToPermission: (response: AcpPermissionResponse) => Promise<void>
  /** Answer a blocking question from the agent */
  respondToElicitation: (response: AcpElicitationResponse) => Promise<void>
  /** Set session permission mode */
  setSessionMode: (modeId: AcpPermissionMode) => Promise<void>
  /** Set session model */
  setSessionModel: (modelId: string) => Promise<void>
  /** Get available models for the active session */
  getSessionModels: () => AcpSessionModelState | undefined
  /** Get available authentication methods */
  getAuthMethods: () => AcpAuthMethod[]
  /** Check if authentication is required */
  isAuthenticationRequired: () => boolean
  /** Authenticate with the agent */
  authenticate: (methodId: string, credentials?: Record<string, unknown>) => Promise<void>
  /** Inspect the active ACP terminal-auth subprocess, if one exists. */
  getTerminalAuthState: () => AcpTerminalAuthState | undefined
  /** Cancel the active ACP terminal-auth subprocess. */
  cancelTerminalAuthentication: () => Promise<void>
  listProviders: () => Promise<AcpListProvidersResponse>
  setProvider: (
    request: AcpSetProviderRequest,
    options?: { confirmedCredentialTransmission?: boolean }
  ) => Promise<AcpSetProviderResponse>
  disableProvider: (request: AcpDisableProviderRequest) => Promise<AcpDisableProviderResponse>
  startNes: (request: AcpStartNesRequest) => Promise<AcpStartNesResponse>
  suggestNes: (request: AcpSuggestNesRequest) => Promise<AcpSuggestNesResponse>
  closeNes: (request: AcpCloseNesRequest) => Promise<AcpCloseNesResponse>
  getDynamicMcpConnections: () => AcpDynamicMcpConnectionState[]
  /** Set a session config option */
  setConfigOption: (configId: string, value: string | boolean) => Promise<AcpConfigOption[]>
  /** Get session config options */
  getConfigOptions: () => AcpConfigOption[]
  /** Get agent tools as Cognia AgentTools */
  getAgentTools: (agentId?: string) => Record<string, AgentTool>
  /** Check agent health */
  checkHealth: (agentId: string) => Promise<boolean>
  /** Refresh the agent list */
  refresh: () => void
  /** Clear error */
  clearError: () => void
}

/**
 * Combined hook return type
 */
export type UseExternalAgentReturn = UseExternalAgentState & UseExternalAgentActions

function getExternalAgentErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const normalized = message.toLowerCase()
  const timeoutPrefix = "external agent execution timed out"
  const cancelPrefix = "external agent execution was cancelled"

  if (normalized.includes("timeout") || normalized.includes("timed out")) {
    if (normalized.startsWith(timeoutPrefix)) {
      return message
    }
    return `External agent execution timed out. ${message}`
  }

  if (
    normalized.includes("aborted") ||
    normalized.includes("cancelled") ||
    normalized.includes("canceled")
  ) {
    if (normalized.startsWith(cancelPrefix)) {
      return message
    }
    return `External agent execution was cancelled. ${message}`
  }

  return message
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * useExternalAgent hook
 *
 * @example
 * ```tsx
 * const {
 *   agents,
 *   activeAgentId,
 *   isExecuting,
 *   execute,
 *   addAgent,
 *   connect,
 * } = useExternalAgent();
 *
 * // Add and connect to an agent
 * const agent = await addAgent({
 *   id: 'claude-code',
 *   name: 'Claude Code',
 *   protocol: 'acp',
 *   transport: 'stdio',
 *   process: { command: 'npx', args: ['@anthropics/claude-code'] },
 * });
 * await connect(agent.config.id);
 *
 * // Execute a prompt
 * const result = await execute('Fix the bug in App.tsx');
 * console.log(result.finalResponse);
 * ```
 */
export function useExternalAgent(): UseExternalAgentReturn {
  const storeActiveAgentId = useExternalAgentStore((state) => state.activeAgentId)
  const storeGetAllAgents = useExternalAgentStore((state) => state.getAllAgents)
  const storeGetConnectionStatus = useExternalAgentStore((state) => state.getConnectionStatus)
  const storeAddAgent = useExternalAgentStore((state) => state.addAgent)
  const storeRemoveAgent = useExternalAgentStore((state) => state.removeAgent)
  const storeSetConnectionStatus = useExternalAgentStore((state) => state.setConnectionStatus)
  const storeRecordFailure = useExternalAgentStore((state) => state.recordAgentFailure)
  const storeClearFailure = useExternalAgentStore((state) => state.clearAgentFailure)
  const storeSetAgentValidity = useExternalAgentStore((state) => state.setAgentValidity)
  const storeUpdateAgent = useExternalAgentStore((state) => state.updateAgent)
  const storeGetAgentValidity = useExternalAgentStore((state) => state.getAgentValidity)
  const storeGetLastRunSnapshot = useExternalAgentStore((state) => state.getLastRunSnapshot)
  const storeGetBenchmarkCapabilities = useExternalAgentStore(
    (state) => state.getBenchmarkCapabilities
  )

  // State
  const [agents, setAgents] = useState<ExternalAgentInstance[]>([])
  const [activeSession, setActiveSession] = useState<ExternalAgentSession | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isExecuting, setIsExecuting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [pendingPermission, setPendingPermission] = useState<AcpPermissionRequest | null>(null)
  /**
   * A blocking question from the agent that is NOT a tool approval — Pi's
   * `confirm`/`select`/`input`/`editor`, or an ACP `elicitation/create`.
   *
   * Separate from `pendingPermission` because they are different decisions with
   * different UI: an approval grants a capability and offers allow/deny/always,
   * a question collects a value. Until this existed the canonical
   * `elicitation_request` reached the renderer and was dropped on the floor,
   * leaving the agent blocked for the whole turn.
   */
  const [pendingElicitation, setPendingElicitation] = useState<AcpElicitationRequest | null>(null)
  const [availableCommands, setAvailableCommands] = useState<AcpAvailableCommand[]>([])
  const [planEntries, setPlanEntries] = useState<AcpPlanEntry[]>([])
  const [planStep, setPlanStep] = useState<number | null>(null)
  const [planDocument, setPlanDocument] = useState<ExternalAgentPlanDocument | null>(null)
  const [streamingResponse, setStreamingResponse] = useState("")
  const [configOptions, setConfigOptions] = useState<AcpConfigOption[]>([])
  const [richContentBlocks, setRichContentBlocks] = useState<AcpContentBlock[]>([])
  const [compactionUpdates, setCompactionUpdates] = useState<AcpCompactionUpdate[]>([])
  const [nesSuggestions, setNesSuggestions] = useState<AcpNesSuggestion[]>([])
  const [lastResult, setLastResult] = useState<ExternalAgentResult | null>(null)
  const [activeAgentValidity, setActiveAgentValidity] =
    useState<ExternalAgentValiditySnapshot | null>(null)
  const [activeLastRunSnapshot, setActiveLastRunSnapshot] =
    useState<ExternalAgentLastRunSnapshot | null>(null)
  const [activeBenchmarkCapabilities, setActiveBenchmarkCapabilities] = useState<
    ExternalAgentBenchmarkCapabilityEntry[]
  >([])
  const [supportsCompaction, setSupportsCompaction] = useState(false)
  const [compactionCapability, setCompactionCapability] =
    useState<ExternalAgentCompactionCapability>({
      status: "unknown",
      routes: [],
    })
  const [providerUndoCapability, setProviderUndoCapability] =
    useState<ExternalAgentProviderUndoCapability>({ status: "unknown" })
  const [isCompacting, setIsCompacting] = useState(false)
  const [isProviderUndoing, setIsProviderUndoing] = useState(false)
  const activeAgentId = storeActiveAgentId
  const supportsCompactionFocus = compactionCapability.routes.some(
    (route) => route.kind === "command" && route.supportsFocus
  )
  const providerUndoAcknowledged = Boolean(
    agents.find((agent) => agent.config.id === activeAgentId)?.config.metadata
      ?.providerUndoWarningAcknowledged
  )

  // Type for the external agent manager
  type ExternalAgentManagerType = Awaited<
    ReturnType<typeof import("@/lib/ai/agent/external/manager").getExternalAgentManager>
  >

  // Refs for managing execution
  const abortControllerRef = useRef<AbortController | null>(null)
  const managerRef = useRef<ExternalAgentManagerType | null>(null)
  const permissionResolveRef = useRef<((response: AcpPermissionResponse) => void) | null>(null)
  const elicitationResolveRef = useRef<((response: AcpElicitationResponse) => void) | null>(null)
  const executingSessionIdRef = useRef<string | null>(null)
  const activeAgentIdRef = useRef<string | null>(activeAgentId)
  const previousActiveAgentIdRef = useRef<string | null>(activeAgentId)
  const compactionInProgressRef = useRef(false)
  const providerUndoInProgressRef = useRef(false)
  const executionInProgressRef = useRef(false)
  const sessionMutationCountRef = useRef(0)
  const providerUndoAcknowledgedRef = useRef(providerUndoAcknowledged)

  useEffect(() => {
    providerUndoAcknowledgedRef.current = providerUndoAcknowledged
  }, [providerUndoAcknowledged])

  // Get the external agent manager
  const getManager = useCallback(async (): Promise<ExternalAgentManagerType> => {
    if (!managerRef.current) {
      const { getExternalAgentManager } = await import("@/lib/ai/agent/external/manager")
      managerRef.current = getExternalAgentManager()
    }
    return managerRef.current
  }, [])

  // Refresh agent list from manager
  const refresh = useCallback(async () => {
    try {
      const manager = await getManager()
      const managerAgents = manager.getAllAgents()
      const managerMap = new Map(managerAgents.map((agent) => [agent.config.id, agent]))
      const storeAgents = storeGetAllAgents()

      const mergedAgents: ExternalAgentInstance[] = storeAgents.map((config) => {
        const runtime = managerMap.get(config.id)
        if (runtime) {
          // Through the getter, never off the instance: it recomputes when the
          // agent's advertised command set has moved. `compaction` is genuinely
          // per-session on ACP — a `/compact` the agent advertises mid-session
          // is the only evidence there is — so a surface reading the
          // connect-time profile reports a working `/compact` as unavailable
          // for the rest of the session. This is the one place the instances
          // every surface renders are assembled, so refreshing here keeps
          // `instance.capabilityProfile` itself honest rather than asking each
          // reader to remember the getter.
          manager.getAgentCapabilityProfile(config.id)
          const currentStatus = storeGetConnectionStatus(config.id)
          const normalizedRuntimeValidity = runtime.validity
            ? stableNormalizeValidity(runtime.validity, {
                fallbackProtocol: config.protocol,
                fallbackSource: runtime.validity.source,
              })
            : undefined
          // Write only what genuinely changed. The old guard was
          // `|| runtime.validity`, which is truthy for the whole life of a
          // connected agent — so this always wrote a fresh `agentValidity`
          // object, the store subscriber saw a change and called `refresh()`
          // again, and the two spun forever (starving the microtask queue and
          // re-persisting the store on every turn).
          const statusChanged = currentStatus !== runtime.connectionStatus
          const validityChanged =
            normalizedRuntimeValidity !== undefined &&
            storeGetAgentValidity(config.id) !== normalizedRuntimeValidity
          if (statusChanged || validityChanged) {
            useExternalAgentStore.setState((state) => ({
              connectionStatus: statusChanged
                ? { ...state.connectionStatus, [config.id]: runtime.connectionStatus }
                : state.connectionStatus,
              agentValidity: validityChanged
                ? { ...state.agentValidity, [config.id]: normalizedRuntimeValidity }
                : state.agentValidity,
            }))
          }
          const normalizedRuntimeInstance = normalizedRuntimeValidity
            ? { ...runtime, validity: normalizedRuntimeValidity }
            : runtime
          return normalizedRuntimeInstance
        }

        return {
          config,
          connectionStatus: storeGetConnectionStatus(config.id),
          status: "idle",
          sessions: new Map(),
          validity: storeGetAgentValidity(config.id),
          lastRunSnapshot: storeGetLastRunSnapshot(config.id),
          connectionAttempts: 0,
          stats: {
            totalExecutions: 0,
            successfulExecutions: 0,
            failedExecutions: 0,
            totalTokensUsed: 0,
            averageResponseTime: 0,
          },
        }
      })

      setAgents(mergedAgents)
      const activeAgentIdFromRef = activeAgentIdRef.current
      const activeAgentValidityRaw = activeAgentIdFromRef
        ? storeGetAgentValidity(activeAgentIdFromRef)
        : undefined
      const activeAgentProtocol =
        mergedAgents.find((agent) => agent.config.id === activeAgentIdFromRef)?.config.protocol ??
        "acp"
      const nextActiveValidity = activeAgentValidityRaw
        ? normalizeExternalAgentValiditySnapshot(activeAgentValidityRaw, {
            fallbackProtocol: activeAgentProtocol,
            fallbackSource: activeAgentValidityRaw.source,
          })
        : null
      const nextActiveLastRunSnapshot = activeAgentIdFromRef
        ? (storeGetLastRunSnapshot(activeAgentIdFromRef) ?? null)
        : null
      setActiveAgentValidity(nextActiveValidity)
      setActiveLastRunSnapshot(nextActiveLastRunSnapshot)
      setActiveBenchmarkCapabilities(
        activeAgentIdFromRef ? storeGetBenchmarkCapabilities(activeAgentIdFromRef) : []
      )
    } catch (err) {
      externalAgentLogger.error("Failed to refresh external agents", err)
    }
  }, [
    getManager,
    storeGetAllAgents,
    storeGetConnectionStatus,
    storeGetAgentValidity,
    storeGetLastRunSnapshot,
    storeGetBenchmarkCapabilities,
  ])

  // Initialize on mount and cleanup on unmount
  useEffect(() => {
    let isMounted = true

    const init = async () => {
      if (isMounted) {
        await refresh()
      }
    }

    init()

    return () => {
      isMounted = false
      // Abort any pending execution
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
        abortControllerRef.current = null
      }
      // Clear pending permission by rejecting with cancelled response
      if (permissionResolveRef.current) {
        permissionResolveRef.current({
          requestId: "",
          granted: false,
          reason: "Component unmounted",
        })
        permissionResolveRef.current = null
      }
      // Same for an open question: leaving it unanswered parks the agent on a
      // promise nothing will ever resolve.
      if (elicitationResolveRef.current) {
        elicitationResolveRef.current({ requestId: "", action: "cancel" })
        elicitationResolveRef.current = null
      }
    }
  }, [refresh])

  useEffect(() => {
    let isActive = true
    let unsubscribe: (() => void) | null = null

    const bindLifecycleListener = async () => {
      const manager = await getManager()
      if (!isActive) {
        return
      }

      unsubscribe = manager.addLifecycleListener((event) => {
        if (!isActive) {
          return
        }

        const storeState = useExternalAgentStore.getState()
        const protocol = storeState.agents[event.agentId]?.protocol ?? "acp"
        const normalizedValidity = event.validity
          ? stableNormalizeValidity(event.validity, {
              fallbackProtocol: protocol,
              fallbackSource: event.validity.source,
            })
          : undefined
        const currentStatus = storeState.getConnectionStatus(event.agentId)
        // Same idempotence rule as `refresh()`: a lifecycle event that carries
        // an unchanged validity must not rewrite the store, or it needlessly
        // re-triggers the store subscriber (and a persist write) per event.
        const statusChanged = currentStatus !== event.connectionStatus
        const validityChanged =
          normalizedValidity !== undefined &&
          storeState.getAgentValidity(event.agentId) !== normalizedValidity
        if (statusChanged || validityChanged) {
          useExternalAgentStore.setState((state) => ({
            connectionStatus: statusChanged
              ? { ...state.connectionStatus, [event.agentId]: event.connectionStatus }
              : state.connectionStatus,
            agentValidity: validityChanged
              ? { ...state.agentValidity, [event.agentId]: normalizedValidity }
              : state.agentValidity,
          }))
        }
        if (normalizedValidity) {
          if (!activeAgentIdRef.current || activeAgentIdRef.current === event.agentId) {
            setActiveAgentValidity(normalizedValidity)
          }
        }

        if (event.lastRunSnapshot) {
          storeState.setLastRunSnapshot(event.agentId, event.lastRunSnapshot)
          if (!activeAgentIdRef.current || activeAgentIdRef.current === event.agentId) {
            setActiveLastRunSnapshot(event.lastRunSnapshot)
          }
        }

        const isTerminalErrorState =
          event.connectionStatus === "error" ||
          event.status === "failed" ||
          event.status === "timeout"
        if (
          isTerminalErrorState &&
          event.lastError &&
          (!activeAgentIdRef.current || activeAgentIdRef.current === event.agentId)
        ) {
          setError(getExternalAgentErrorMessage(event.lastError))
          storeRecordFailure(
            describeExternalAgentFailure(event.agentId, "connect", event.lastError)
          )
        }
      })
    }

    void bindLifecycleListener()

    return () => {
      isActive = false
      unsubscribe?.()
    }
  }, [getManager, storeRecordFailure])

  useEffect(() => {
    const unsubscribe = useExternalAgentStore.subscribe((state, previousState) => {
      if (
        state.agents !== previousState.agents ||
        state.connectionStatus !== previousState.connectionStatus ||
        state.agentValidity !== previousState.agentValidity ||
        state.lastRunSnapshots !== previousState.lastRunSnapshots ||
        state.activeAgentId !== previousState.activeAgentId
      ) {
        void refresh()
      }
    })

    return unsubscribe
  }, [refresh])

  useEffect(() => {
    activeAgentIdRef.current = activeAgentId
    if (previousActiveAgentIdRef.current !== activeAgentId) {
      setActiveSession(null)
      executingSessionIdRef.current = null
      if (activeAgentId) {
        const snapshot = storeGetAgentValidity(activeAgentId)
        const lastRunSnapshot = storeGetLastRunSnapshot(activeAgentId)
        const protocol =
          storeGetAllAgents().find((agent) => agent.id === activeAgentId)?.protocol ?? "acp"
        // eslint-disable-next-line react-hooks/set-state-in-effect -- syncing local state when activeAgentId changes
        setActiveAgentValidity(
          snapshot
            ? normalizeExternalAgentValiditySnapshot(snapshot, {
                fallbackProtocol: protocol,
                fallbackSource: snapshot.source,
              })
            : null
        )
        setActiveLastRunSnapshot(lastRunSnapshot ?? null)
        setActiveBenchmarkCapabilities(storeGetBenchmarkCapabilities(activeAgentId))
      } else {
        setActiveAgentValidity(null)
        setActiveLastRunSnapshot(null)
        setActiveBenchmarkCapabilities([])
      }
    }
    previousActiveAgentIdRef.current = activeAgentId
  }, [
    activeAgentId,
    storeGetAgentValidity,
    storeGetAllAgents,
    storeGetLastRunSnapshot,
    storeGetBenchmarkCapabilities,
  ])

  // Subscribe to ACP session updates for commands/plan
  useEffect(() => {
    let unsubscribe: (() => void) | null = null
    let isActive = true

    const attach = async () => {
      if (!activeAgentId) {
        setAvailableCommands([])
        setPlanEntries([])
        setPlanStep(null)
        setPlanDocument(null)
        setRichContentBlocks([])
        setCompactionUpdates([])
        setNesSuggestions([])
        return
      }

      setAvailableCommands([])
      setPlanEntries([])
      setPlanStep(null)
      setPlanDocument(null)
      setConfigOptions([])
      setRichContentBlocks([])
      setCompactionUpdates([])
      setNesSuggestions([])

      const manager = await getManager()

      if (!isActive) return

      unsubscribe = manager.addEventListener(activeAgentId, (event) => {
        if (event.type === "commands_update") {
          setAvailableCommands(event.commands)
        }
        if (event.type === "plan_update") {
          setPlanEntries(event.entries)
          setPlanStep(event.step ?? null)
          if (event.removed) {
            setPlanDocument((current) => (current?.planId === event.planId ? null : current))
          } else if (event.planId && (event.kind === "file" || event.kind === "markdown")) {
            setPlanDocument({
              planId: event.planId,
              kind: event.kind,
              ...(event.uri ? { uri: event.uri } : {}),
              ...(event.content !== undefined ? { content: event.content } : {}),
            })
          } else if (event.kind === "items" || !event.kind) {
            setPlanDocument(null)
          }
        }
        if (event.type === "config_options_update") {
          setConfigOptions(event.configOptions)
        }
        if (event.type === "mode_update") {
          // Sync configOptions mode value if present
          setConfigOptions((prev) =>
            prev.map((opt) =>
              opt.type === "select" && opt.category === "mode"
                ? { ...opt, currentValue: event.modeId }
                : opt
            )
          )
        }
        if (event.type === "content_block_start" || event.type === "content_block_delta") {
          setRichContentBlocks((current) => [...current.slice(-99), event.block])
        }
        if (event.type === "compaction_update") {
          setCompactionUpdates((current) => [...current.slice(-19), event.compaction])
        }
        if (event.type === "compaction_summary_chunk") {
          setRichContentBlocks((current) => [...current.slice(-99), event.content])
        }
        if (event.type === "nes_suggestion") {
          setNesSuggestions((current) => [...current.slice(-19), event.suggestion])
        }
      })

      if (activeSession) {
        const session = manager.getSession(activeAgentId, activeSession.id)
        const sessionCommands = session?.metadata?.availableCommands as
          AcpAvailableCommand[] | undefined
        const sessionPlan = session?.metadata?.plan as AcpPlanEntry[] | undefined
        const sessionConfigOptions = session?.metadata?.configOptions as
          AcpConfigOption[] | undefined
        const sessionPlans = session?.metadata?.plans as
          | Record<string, { type?: string; planId?: string; uri?: string; content?: string }>
          | undefined
        if (sessionCommands) {
          setAvailableCommands(sessionCommands)
        }
        if (sessionPlan) {
          setPlanEntries(sessionPlan)
          const activeIndex = sessionPlan.findIndex((entry) => entry.status === "in_progress")
          setPlanStep(activeIndex >= 0 ? activeIndex : null)
        }
        if (sessionConfigOptions) {
          setConfigOptions(sessionConfigOptions)
        }
        if (sessionPlans) {
          const document = Object.values(sessionPlans)
            .reverse()
            .find((plan) => plan.type === "file" || plan.type === "markdown")
          setPlanDocument(
            document?.planId && (document.type === "file" || document.type === "markdown")
              ? {
                  planId: document.planId,
                  kind: document.type,
                  ...(document.uri ? { uri: document.uri } : {}),
                  ...(document.content !== undefined ? { content: document.content } : {}),
                }
              : null
          )
        }
      }
    }

    attach()

    return () => {
      isActive = false
      unsubscribe?.()
    }
  }, [activeAgentId, activeSession, getManager])

  // Ask the agent for its config options once a session exists.
  //
  // The subscription above only ever learns them from a `config_options_update`
  // the agent chose to push. ACP agents push, so they worked; a pull-based
  // adapter never does, and Pi therefore rendered no model row at all despite
  // implementing `get_available_models`. The fetch is cached per (agent,
  // session) in `model-surface-cache`, which is the same load the composer's
  // model chip performs, so the two surfaces cost one round trip between them.
  useEffect(() => {
    const sessionId = activeSession?.id
    if (!activeAgentId || !sessionId) return
    let cancelled = false
    void (async () => {
      const [{ loadAgentModelSurface }, manager] = await Promise.all([
        import("@/lib/ai/agent/external/model-surface-cache"),
        getManager(),
      ])
      const result = await loadAgentModelSurface(activeAgentId, sessionId)
      if (cancelled || result.status !== "ready") return
      // The fetch wrote the raw options onto the session; read them back rather
      // than reconstructing a list from the resolved surface, because the panel
      // renders every category and the surface only carries models.
      const options = manager.getSession(activeAgentId, sessionId)?.metadata?.configOptions as
        AcpConfigOption[] | undefined
      if (options?.length) setConfigOptions(options)
    })()
    return () => {
      cancelled = true
    }
  }, [activeAgentId, activeSession?.id, getManager])

  // Add a new agent
  const addAgent = useCallback(
    async (input: CreateExternalAgentInput): Promise<ExternalAgentInstance> => {
      setIsLoading(true)
      setError(null)

      try {
        const defaultPermissionMode = useExternalAgentStore.getState().defaultPermissionMode
        const normalized = normalizeExternalAgentConfigInput(input, {
          defaultPermissionMode,
        })
        const createdAgentId = storeAddAgent({
          ...input,
          protocol: normalized.protocol,
          transport: normalized.transport,
          metadata: normalized.metadata,
        })
        const storedConfig = useExternalAgentStore.getState().getAgent(createdAgentId)
        if (!storedConfig) {
          throw new Error("Failed to persist external agent configuration.")
        }

        if (!isExternalAgentExecutable(storedConfig)) {
          const blockAssessment = getExternalAgentExecutionBlock(storedConfig)
          if (blockAssessment) {
            storeSetAgentValidity(createdAgentId, {
              executable: false,
              checkedAt: new Date(),
              source: "config",
              blockingReasonCode: blockAssessment.code,
              blockingReason: blockAssessment.reason,
              healthStatus: "unknown",
              sessionExtensions: {
                "session/list": { state: "unknown" },
                "session/fork": { state: "unknown" },
                "session/resume": { state: "unknown" },
              },
              negotiation: {
                protocol: storedConfig.protocol,
              },
              lastBranchReasonCode: blockAssessment.code,
              lastBranchReason: blockAssessment.reason,
              lastBranchAt: new Date(),
            })
          }
          storeSetConnectionStatus(
            createdAgentId,
            storedConfig.protocol === "acp" ? "disconnected" : "error"
          )
          await refresh()
          return {
            config: storedConfig,
            connectionStatus: storeGetConnectionStatus(createdAgentId),
            status: "idle",
            sessions: new Map(),
            validity: storeGetAgentValidity(createdAgentId),
            connectionAttempts: 0,
            stats: {
              totalExecutions: 0,
              successfulExecutions: 0,
              failedExecutions: 0,
              totalTokensUsed: 0,
              averageResponseTime: 0,
            },
          }
        }

        const manager = await getManager()
        const instance = await manager.addAgent(storedConfig)
        storeSetConnectionStatus(createdAgentId, instance.connectionStatus)
        if (instance.validity) {
          storeSetAgentValidity(createdAgentId, instance.validity)
        }
        await refresh()
        return instance
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [
      getManager,
      refresh,
      storeAddAgent,
      storeSetConnectionStatus,
      storeGetConnectionStatus,
      storeSetAgentValidity,
      storeGetAgentValidity,
    ]
  )

  // Remove an agent
  const removeAgent = useCallback(
    async (agentId: string): Promise<void> => {
      setIsLoading(true)
      setError(null)

      try {
        const manager = await getManager()
        const runtimeAgent = manager.getAgent(agentId)
        if (runtimeAgent) {
          await manager.removeAgent(agentId)
        }
        storeRemoveAgent(agentId)

        // Clears BOTH selection stores, so the runtime store cannot keep a
        // dangling id that chat dispatch would still hand to the manager.
        clearExternalAgentSelectionIfActive(agentId)
        if (activeAgentId === agentId) setActiveSession(null)

        await refresh()
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [getManager, refresh, activeAgentId, storeRemoveAgent]
  )

  // Connect to an agent
  const connect = useCallback(
    async (agentId: string): Promise<void> => {
      setIsLoading(true)
      setError(null)
      // Cleared before the attempt, not after it. The previous report described
      // an attempt that is over, and leaving it up while a new one runs is how
      // a retry looks like it did nothing.
      storeClearFailure(agentId)

      try {
        const targetConfig = useExternalAgentStore.getState().getAgent(agentId)
        if (!targetConfig) {
          throw new Error(`Agent not found: ${agentId}`)
        }
        const blockedReason = getExternalAgentExecutionBlockReason(targetConfig)
        if (blockedReason) {
          storeSetConnectionStatus(
            agentId,
            targetConfig.protocol === "acp" ? "disconnected" : "error"
          )
          throw new Error(blockedReason)
        }

        storeSetConnectionStatus(agentId, "connecting")
        const manager = await getManager()
        // The manager only knows the agents startup rehydration handed it. One
        // added since (or one whose rehydration bailed) is absent from its
        // adapter map, and `connect` answers that with `Agent not found: <id>`,
        // a sentence about the manager's internals that reaches the user as the
        // reason their agent will not start. Registering here costs nothing
        // when it is already known.
        if (!manager.getAgent(agentId)) {
          await manager.addAgent(targetConfig, { connect: false })
        }
        await manager.connect(agentId)
        const updated = manager.getAgent(agentId)
        storeSetConnectionStatus(agentId, updated?.connectionStatus ?? "connected")
        await refresh()

        // Dispatch external agent connect hook
        const agent = manager.getAllAgents().find((a) => a.config.id === agentId)
        getPluginEventHooks().dispatchExternalAgentConnect(agentId, agent?.config.name || agentId)
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        storeRecordFailure(describeExternalAgentFailure(agentId, "connect", err))
        storeSetConnectionStatus(agentId, "error")
        getPluginEventHooks().dispatchExternalAgentError(agentId, message)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [getManager, refresh, storeSetConnectionStatus, storeRecordFailure, storeClearFailure]
  )

  // Disconnect from an agent
  const disconnect = useCallback(
    async (agentId: string): Promise<void> => {
      setIsLoading(true)
      setError(null)

      try {
        const manager = await getManager()
        await manager.disconnect(agentId)
        storeSetConnectionStatus(agentId, "disconnected")

        if (activeAgentId === agentId) {
          setActiveSession(null)
        }

        await refresh()

        // Dispatch external agent disconnect hook
        getPluginEventHooks().dispatchExternalAgentDisconnect(agentId)
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [getManager, refresh, activeAgentId, storeSetConnectionStatus]
  )

  // Reconnect to an agent
  const reconnect = useCallback(
    async (agentId: string): Promise<void> => {
      setIsLoading(true)
      setError(null)

      try {
        storeSetConnectionStatus(agentId, "reconnecting")
        const manager = await getManager()
        await manager.reconnect(agentId)
        const updated = manager.getAgent(agentId)
        storeSetConnectionStatus(agentId, updated?.connectionStatus ?? "connected")
        await refresh()
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        storeSetConnectionStatus(agentId, "error")
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [getManager, refresh, storeSetConnectionStatus]
  )

  // Set active agent. Routed through `selectExternalAgent` so chat dispatch —
  // which reads the runtime store, not this one — follows the manager's
  // selection instead of staying on whichever agent was picked in the composer.
  const setActiveAgent = useCallback((agentId: string | null) => {
    selectExternalAgent(agentId)
    setActiveSession(null)
    executingSessionIdRef.current = null
    setError(null)
  }, [])

  // Create a new session
  const createSession = useCallback(
    async (options?: SessionCreateOptions): Promise<ExternalAgentSession> => {
      if (!activeAgentId) {
        throw new Error("No active agent selected")
      }
      if (compactionInProgressRef.current) {
        throw new Error("Cannot create a session while context compaction is in progress")
      }
      if (providerUndoInProgressRef.current) {
        throw new Error("Cannot create a session while provider undo is in progress")
      }

      sessionMutationCountRef.current += 1
      setIsLoading(true)
      setError(null)

      try {
        const manager = await getManager()
        const session = await manager.createSession(activeAgentId, options)
        setActiveSession(session)
        executingSessionIdRef.current = session.id
        return session
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        storeRecordFailure(describeExternalAgentFailure(activeAgentId, "session", err))
        throw err
      } finally {
        sessionMutationCountRef.current -= 1
        setIsLoading(false)
      }
    },
    [getManager, activeAgentId, storeRecordFailure]
  )

  // Close a session
  const closeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!activeAgentId) {
        return
      }
      if (compactionInProgressRef.current) {
        throw new Error("Cannot close a session while context compaction is in progress")
      }
      if (providerUndoInProgressRef.current) {
        throw new Error("Cannot close a session while provider undo is in progress")
      }

      sessionMutationCountRef.current += 1
      setIsLoading(true)
      setError(null)

      try {
        const manager = await getManager()
        await manager.closeSession(activeAgentId, sessionId)

        if (activeSession?.id === sessionId) {
          setActiveSession(null)
          executingSessionIdRef.current = null
        }
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        storeRecordFailure(describeExternalAgentFailure(activeAgentId, "session", err))
        throw err
      } finally {
        sessionMutationCountRef.current -= 1
        setIsLoading(false)
      }
    },
    [getManager, activeAgentId, activeSession, storeRecordFailure]
  )

  const syncActiveAgentValidityFromRuntime = useCallback(
    (agentId: string, manager?: ExternalAgentManagerType | null) => {
      if (activeAgentIdRef.current !== agentId) {
        return
      }
      const protocol = useExternalAgentStore.getState().agents[agentId]?.protocol ?? "acp"
      const runtimeValidity = manager?.getAgent(agentId)?.validity
      const normalizedRuntimeValidity = runtimeValidity
        ? normalizeExternalAgentValiditySnapshot(runtimeValidity, {
            fallbackProtocol: protocol,
            fallbackSource: runtimeValidity.source,
          })
        : null
      if (normalizedRuntimeValidity) {
        storeSetAgentValidity(agentId, normalizedRuntimeValidity)
      }
      const storedValidity = storeGetAgentValidity(agentId)
      const nextValidity = normalizedRuntimeValidity
        ? normalizedRuntimeValidity
        : storedValidity
          ? normalizeExternalAgentValiditySnapshot(storedValidity, {
              fallbackProtocol: protocol,
              fallbackSource: storedValidity.source,
            })
          : null
      setActiveAgentValidity(nextValidity)
    },
    [storeGetAgentValidity, storeSetAgentValidity]
  )

  const listSessions = useCallback(
    async (
      agentId?: string,
      options?: SessionListOptions
    ): Promise<
      Array<{ sessionId: string; title?: string; createdAt?: string; updatedAt?: string }>
    > => {
      const targetAgentId = agentId || activeAgentId
      if (!targetAgentId) {
        return []
      }
      let manager: ExternalAgentManagerType | null = null
      try {
        manager = await getManager()
        return await manager.listSessions(targetAgentId, options)
      } catch (err) {
        const unsupported = isExternalAgentSessionExtensionUnsupportedForMethod(err, "session/list")
        if (!unsupported) {
          setError(getExternalAgentErrorMessage(err))
        }
        throw err
      } finally {
        syncActiveAgentValidityFromRuntime(targetAgentId, manager)
      }
    },
    [getManager, activeAgentId, syncActiveAgentValidityFromRuntime]
  )

  const forkSession = useCallback(
    async (sessionId: string, options?: SessionCreateOptions): Promise<ExternalAgentSession> => {
      if (!activeAgentId) {
        throw new Error("No active agent selected")
      }
      if (compactionInProgressRef.current) {
        throw new Error("Cannot fork a session while context compaction is in progress")
      }
      if (providerUndoInProgressRef.current) {
        throw new Error("Cannot fork a session while provider undo is in progress")
      }
      sessionMutationCountRef.current += 1
      let manager: ExternalAgentManagerType | null = null
      try {
        manager = await getManager()
        const forked = await manager.forkSession(activeAgentId, sessionId, options)
        setActiveSession(forked)
        executingSessionIdRef.current = forked.id
        return forked
      } catch (err) {
        const unsupported = isExternalAgentSessionExtensionUnsupportedForMethod(err, "session/fork")
        if (!unsupported) {
          setError(getExternalAgentErrorMessage(err))
        }
        throw err
      } finally {
        sessionMutationCountRef.current -= 1
        syncActiveAgentValidityFromRuntime(activeAgentId, manager)
      }
    },
    [getManager, activeAgentId, syncActiveAgentValidityFromRuntime]
  )

  // Probe session-level provider capabilities whenever the active runtime
  // changes. ACP itself has no compaction RPC, so adapters may report either a
  // native route or an exact runtime-advertised slash command.
  useEffect(() => {
    let active = true
    void (async () => {
      if (!activeAgentId || !activeSession) {
        if (active) {
          setSupportsCompaction(false)
          setCompactionCapability({ status: "unknown", routes: [] })
          setProviderUndoCapability({ status: "unknown" })
        }
        return
      }
      try {
        const manager = await getManager()
        const [compaction, providerUndo] = await Promise.all([
          manager.getCompactionCapability(activeAgentId, activeSession.id),
          manager.getProviderUndoCapability(activeAgentId, activeSession.id),
        ])
        if (active) {
          setCompactionCapability(compaction)
          setSupportsCompaction(compaction.status === "supported")
          setProviderUndoCapability(providerUndo)
        }
      } catch {
        if (active) {
          setSupportsCompaction(false)
          setCompactionCapability({ status: "unknown", routes: [] })
          setProviderUndoCapability({ status: "unknown" })
        }
      }
    })()
    return () => {
      active = false
    }
  }, [activeAgentId, activeSession, getManager])

  const compactSession = useCallback(
    async (sessionId: string, options?: ExternalAgentCompactionOptions): Promise<void> => {
      if (!activeAgentId) {
        throw new Error("No active agent selected")
      }
      if (
        executionInProgressRef.current ||
        sessionMutationCountRef.current > 0 ||
        compactionInProgressRef.current ||
        providerUndoInProgressRef.current
      ) {
        throw new Error("Another session operation is already in progress")
      }
      compactionInProgressRef.current = true
      setIsCompacting(true)
      setProgress(0)
      try {
        const manager = await getManager()
        const capability = await manager.getCompactionCapability(activeAgentId, sessionId)
        if (capability.status !== "supported") {
          throw new Error("Agent does not support context compaction")
        }
        await manager.compactSession(activeAgentId, sessionId, options)
        setProgress(100)
      } finally {
        compactionInProgressRef.current = false
        setIsCompacting(false)
      }
    },
    [getManager, activeAgentId]
  )

  const undoLastProviderChange = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!activeAgentId) throw new Error("No active agent selected")
      if (
        !providerUndoAcknowledgedRef.current ||
        executionInProgressRef.current ||
        sessionMutationCountRef.current > 0 ||
        compactionInProgressRef.current ||
        providerUndoInProgressRef.current
      ) {
        throw new Error(
          providerUndoAcknowledgedRef.current
            ? "Another session operation is already in progress"
            : "Provider undo warning must be acknowledged"
        )
      }
      providerUndoInProgressRef.current = true
      setIsProviderUndoing(true)
      try {
        const manager = await getManager()
        await manager.undoLastProviderChange(activeAgentId, sessionId)
      } finally {
        providerUndoInProgressRef.current = false
        setIsProviderUndoing(false)
      }
    },
    [activeAgentId, getManager]
  )

  const acknowledgeProviderUndoWarning = useCallback(() => {
    if (!activeAgentId) return
    providerUndoAcknowledgedRef.current = true
    storeUpdateAgent(activeAgentId, {
      metadata: { providerUndoWarningAcknowledged: true },
    })
  }, [activeAgentId, storeUpdateAgent])

  const resetProviderUndoWarning = useCallback(() => {
    if (!activeAgentId) return
    providerUndoAcknowledgedRef.current = false
    storeUpdateAgent(activeAgentId, {
      metadata: { providerUndoWarningAcknowledged: false },
    })
  }, [activeAgentId, storeUpdateAgent])

  const resumeSession = useCallback(
    async (sessionId: string, options?: SessionCreateOptions): Promise<ExternalAgentSession> => {
      if (!activeAgentId) {
        throw new Error("No active agent selected")
      }
      if (compactionInProgressRef.current) {
        throw new Error("Cannot resume a session while context compaction is in progress")
      }
      if (providerUndoInProgressRef.current) {
        throw new Error("Cannot resume a session while provider undo is in progress")
      }
      sessionMutationCountRef.current += 1
      let manager: ExternalAgentManagerType | null = null
      try {
        manager = await getManager()
        const resumed = await manager.resumeSession(activeAgentId, sessionId, options)
        setActiveSession(resumed)
        executingSessionIdRef.current = resumed.id
        return resumed
      } catch (err) {
        const unsupported = isExternalAgentSessionExtensionUnsupportedForMethod(
          err,
          "session/resume"
        )
        if (!unsupported) {
          setError(getExternalAgentErrorMessage(err))
        }
        throw err
      } finally {
        sessionMutationCountRef.current -= 1
        syncActiveAgentValidityFromRuntime(activeAgentId, manager)
      }
    },
    [getManager, activeAgentId, syncActiveAgentValidityFromRuntime]
  )

  // Execute a prompt
  const execute = useCallback(
    async (
      prompt: string,
      options?: ExternalAgentExecutionOptions
    ): Promise<ExternalAgentResult> => {
      if (!activeAgentId) {
        throw new Error("No active agent selected")
      }
      if (
        executionInProgressRef.current ||
        compactionInProgressRef.current ||
        providerUndoInProgressRef.current
      ) {
        throw new Error("Cannot send while a provider session operation is in progress")
      }

      executionInProgressRef.current = true
      setIsExecuting(true)
      setError(null)
      setProgress(0)
      setStreamingResponse("")
      abortControllerRef.current = new AbortController()

      try {
        const manager = await getManager()
        const configuredAgent = useExternalAgentStore.getState().getAgent(activeAgentId)
        if (!configuredAgent) {
          throw new Error("External agent configuration not found.")
        }
        const blockedReason = getExternalAgentExecutionBlockReason(configuredAgent)
        if (blockedReason) {
          throw new Error(blockedReason)
        }
        const resolvedSessionId =
          options?.sessionId || activeSession?.id || executingSessionIdRef.current || undefined
        executingSessionIdRef.current = resolvedSessionId ?? null

        // Create permission request handler
        const onPermissionRequest = async (
          request: AcpPermissionRequest
        ): Promise<AcpPermissionResponse> => {
          setPendingPermission(request)

          return new Promise((resolve) => {
            permissionResolveRef.current = resolve
          })
        }

        // Same promise-bridge shape as the approval above. Supplying this is
        // half of what makes elicitation work: `BaseProtocolAdapter.execute`
        // gates the branch on `options?.onElicitationRequest && this.respondToElicitation`,
        // so a missing callback silently skips the answer and leaves the agent
        // blocked — no error, no timeout, just a stalled turn.
        const onElicitationRequest = async (
          request: AcpElicitationRequest
        ): Promise<AcpElicitationResponse> => {
          setPendingElicitation(request)

          return new Promise((resolve) => {
            elicitationResolveRef.current = resolve
          })
        }

        // Dispatch external agent execution start hook
        const sessionId = resolvedSessionId || ""
        getPluginEventHooks().dispatchExternalAgentExecutionStart(activeAgentId, sessionId, prompt)

        const result = await manager.execute(activeAgentId, prompt, {
          ...options,
          sessionId: resolvedSessionId,
          onProgress: (p: number, message?: string) => {
            setProgress(p)
            options?.onProgress?.(p, message)
          },
          onPermissionRequest,
          onElicitationRequest,
          signal: abortControllerRef.current.signal,
        })

        setLastResult(result)
        const nextSessionId = result.sessionId || resolvedSessionId || null
        executingSessionIdRef.current = nextSessionId
        if (nextSessionId) {
          const latestSession = manager.getSession(activeAgentId, nextSessionId)
          if (latestSession) {
            setActiveSession(latestSession)
          }
        }

        // Dispatch external agent execution complete hook
        getPluginEventHooks().dispatchExternalAgentExecutionComplete(
          activeAgentId,
          nextSessionId || sessionId,
          result.success,
          result.finalResponse
        )

        return result
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        storeRecordFailure(describeExternalAgentFailure(activeAgentId, "execute", err))

        // Dispatch external agent error hook
        getPluginEventHooks().dispatchExternalAgentError(activeAgentId, message)

        throw err
      } finally {
        executionInProgressRef.current = false
        setIsExecuting(false)
        setProgress(100)
        setPendingPermission(null)
        abortControllerRef.current = null
      }
    },
    [getManager, activeAgentId, activeSession, storeRecordFailure]
  )

  // Execute with streaming
  const executeStreaming = useCallback(
    async function* (
      prompt: string,
      options?: ExternalAgentExecutionOptions
    ): AsyncIterable<ExternalAgentEvent> {
      if (!activeAgentId) {
        throw new Error("No active agent selected")
      }
      if (
        executionInProgressRef.current ||
        compactionInProgressRef.current ||
        providerUndoInProgressRef.current
      ) {
        throw new Error("Cannot send while a provider session operation is in progress")
      }

      executionInProgressRef.current = true
      setIsExecuting(true)
      setError(null)
      setProgress(0)
      setStreamingResponse("")
      abortControllerRef.current = new AbortController()

      try {
        const manager = await getManager()
        const configuredAgent = useExternalAgentStore.getState().getAgent(activeAgentId)
        if (!configuredAgent) {
          throw new Error("External agent configuration not found.")
        }
        const blockedReason = getExternalAgentExecutionBlockReason(configuredAgent)
        if (blockedReason) {
          throw new Error(blockedReason)
        }
        const resolvedSessionId =
          options?.sessionId || activeSession?.id || executingSessionIdRef.current || undefined
        executingSessionIdRef.current = resolvedSessionId ?? null

        for await (const event of manager.executeStreaming(activeAgentId, prompt, {
          ...options,
          sessionId: resolvedSessionId,
          signal: abortControllerRef.current.signal,
        })) {
          if ("sessionId" in event && typeof event.sessionId === "string") {
            executingSessionIdRef.current = event.sessionId
          }

          if (event.type === "session_start" && typeof event.sessionId === "string") {
            const latestSession = manager.getSession(activeAgentId, event.sessionId)
            if (latestSession) {
              setActiveSession(latestSession)
            }
          }

          // Update streaming response for text events
          if (event.type === "message_delta" && event.delta.type === "text") {
            setStreamingResponse((prev) => prev + event.delta.text)
          }

          // Update progress
          if (event.type === "progress") {
            setProgress(event.progress)
          }

          // Handle permission request
          if (event.type === "permission_request") {
            setPendingPermission(event.request)
          }

          // The streaming path has no promise bridge — the caller drives the
          // iterator — so the answer goes back through the manager. Surfacing
          // it is what turns a stalled turn into a question the user can see.
          if (event.type === "elicitation_request") {
            setPendingElicitation(event.request)
          }

          yield event
        }
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        storeRecordFailure(describeExternalAgentFailure(activeAgentId, "execute", err))
        throw err
      } finally {
        executionInProgressRef.current = false
        setIsExecuting(false)
        setProgress(100)
        setPendingPermission(null)
        abortControllerRef.current = null
      }
    },
    [getManager, activeAgentId, activeSession, storeRecordFailure]
  )

  // Cancel execution
  const cancel = useCallback(async (): Promise<void> => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
    }

    const targetSessionId = executingSessionIdRef.current || activeSession?.id
    if (activeAgentId && targetSessionId) {
      try {
        const manager = await getManager()
        await manager.cancel(activeAgentId, targetSessionId)
      } catch (err) {
        externalAgentLogger.error("Failed to cancel external agent execution", err)
      }
    }

    setIsExecuting(false)
  }, [getManager, activeAgentId, activeSession])

  // Respond to permission request
  const respondToPermission = useCallback(
    async (response: AcpPermissionResponse): Promise<void> => {
      const pendingRequest = pendingPermission
      if (permissionResolveRef.current) {
        permissionResolveRef.current(response)
        permissionResolveRef.current = null
        setPendingPermission(null)
        return
      }

      if (activeAgentId && pendingRequest) {
        try {
          const manager = await getManager()
          const sessionId = pendingRequest.sessionId ?? executingSessionIdRef.current
          if (!sessionId) {
            throw new Error("Unable to resolve external agent session for permission response.")
          }
          await manager.respondToPermission(activeAgentId, sessionId, response)
        } catch (err) {
          externalAgentLogger.error("Failed to respond to external agent permission", err)
          setError(getExternalAgentErrorMessage(err))
          storeRecordFailure(describeExternalAgentFailure(activeAgentId, "session", err))
        }
      }

      setPendingPermission(null)
    },
    [getManager, activeAgentId, pendingPermission, storeRecordFailure]
  )

  /**
   * Answer a blocking question from the agent.
   *
   * Mirrors `respondToPermission`: the in-flight promise bridge wins when a
   * turn is streaming, otherwise the answer is routed through the manager. The
   * second path matters because a dialog can outlive the `execute` call that
   * raised it — Pi's dialogs block the extension, not the turn.
   */
  const respondToElicitation = useCallback(
    async (response: AcpElicitationResponse): Promise<void> => {
      if (elicitationResolveRef.current) {
        elicitationResolveRef.current(response)
        elicitationResolveRef.current = null
        setPendingElicitation(null)
        return
      }

      if (activeAgentId) {
        try {
          const manager = await getManager()
          await manager.respondToElicitation(activeAgentId, response)
        } catch (err) {
          externalAgentLogger.error("Failed to respond to external agent elicitation", err)
          setError(getExternalAgentErrorMessage(err))
          storeRecordFailure(describeExternalAgentFailure(activeAgentId, "session", err))
        }
      }

      setPendingElicitation(null)
    },
    [getManager, activeAgentId, storeRecordFailure]
  )

  const setSessionMode = useCallback(
    async (modeId: AcpPermissionMode): Promise<void> => {
      if (!activeAgentId || !activeSession) {
        throw new Error("No active session to update")
      }
      const manager = await getManager()
      await manager.setSessionMode(activeAgentId, activeSession.id, modeId)
    },
    [getManager, activeAgentId, activeSession]
  )

  const setSessionModel = useCallback(
    async (modelId: string): Promise<void> => {
      if (!activeAgentId || !activeSession) {
        throw new Error("No active session to update")
      }
      const manager = await getManager()
      await manager.setSessionModel(activeAgentId, activeSession.id, modelId)
    },
    [getManager, activeAgentId, activeSession]
  )

  const getSessionModels = useCallback((): AcpSessionModelState | undefined => {
    if (!activeAgentId || !activeSession || !managerRef.current) {
      return undefined
    }
    const result = managerRef.current.getSessionModels(activeAgentId, activeSession.id)
    return result.status === "ok" ? result.data : undefined
  }, [activeAgentId, activeSession])

  const getAuthMethods = useCallback((): AcpAuthMethod[] => {
    if (!activeAgentId || !managerRef.current) {
      return []
    }
    const result = managerRef.current.getAuthMethods(activeAgentId)
    return result.status === "ok" ? result.data : []
  }, [activeAgentId])

  const isAuthenticationRequired = useCallback((): boolean => {
    if (!activeAgentId || !managerRef.current) {
      return false
    }
    return managerRef.current.isAuthenticationRequired(activeAgentId)
  }, [activeAgentId])

  const authenticate = useCallback(
    async (methodId: string, credentials?: Record<string, unknown>): Promise<void> => {
      if (!activeAgentId) {
        throw new Error("No active agent selected")
      }
      const manager = await getManager()
      await manager.authenticate(activeAgentId, methodId, credentials)
    },
    [getManager, activeAgentId]
  )

  const getTerminalAuthState = useCallback((): AcpTerminalAuthState | undefined => {
    if (!activeAgentId || !managerRef.current) return undefined
    return managerRef.current.getTerminalAuthState(activeAgentId)
  }, [activeAgentId])

  const cancelTerminalAuthentication = useCallback(async (): Promise<void> => {
    if (!activeAgentId) return
    const manager = await getManager()
    await manager.cancelTerminalAuthentication(activeAgentId)
  }, [activeAgentId, getManager])

  const listProviders = useCallback(async (): Promise<AcpListProvidersResponse> => {
    if (!activeAgentId) throw new Error("No active agent selected")
    return (await getManager()).listProviders(activeAgentId)
  }, [activeAgentId, getManager])

  const setProvider = useCallback(
    async (
      request: AcpSetProviderRequest,
      options?: { confirmedCredentialTransmission?: boolean }
    ): Promise<AcpSetProviderResponse> => {
      if (!activeAgentId) throw new Error("No active agent selected")
      return (await getManager()).setProvider(activeAgentId, request, options)
    },
    [activeAgentId, getManager]
  )

  const disableProvider = useCallback(
    async (request: AcpDisableProviderRequest): Promise<AcpDisableProviderResponse> => {
      if (!activeAgentId) throw new Error("No active agent selected")
      return (await getManager()).disableProvider(activeAgentId, request)
    },
    [activeAgentId, getManager]
  )

  const startNes = useCallback(
    async (request: AcpStartNesRequest): Promise<AcpStartNesResponse> => {
      if (!activeAgentId) throw new Error("No active agent selected")
      return (await getManager()).startNes(activeAgentId, request)
    },
    [activeAgentId, getManager]
  )

  const suggestNes = useCallback(
    async (request: AcpSuggestNesRequest): Promise<AcpSuggestNesResponse> => {
      if (!activeAgentId) throw new Error("No active agent selected")
      return (await getManager()).suggestNes(activeAgentId, request)
    },
    [activeAgentId, getManager]
  )

  const closeNes = useCallback(
    async (request: AcpCloseNesRequest): Promise<AcpCloseNesResponse> => {
      if (!activeAgentId) throw new Error("No active agent selected")
      return (await getManager()).closeNes(activeAgentId, request)
    },
    [activeAgentId, getManager]
  )

  const getDynamicMcpConnections = useCallback((): AcpDynamicMcpConnectionState[] => {
    if (!activeAgentId || !managerRef.current) return []
    return managerRef.current.getDynamicMcpConnections(activeAgentId)
  }, [activeAgentId])

  // Set config option
  const setConfigOption = useCallback(
    async (configId: string, value: string | boolean): Promise<AcpConfigOption[]> => {
      if (!activeAgentId || !activeSession) {
        throw new Error("No active session to update")
      }
      const manager = await getManager()
      const updated = await manager.setConfigOption(
        activeAgentId,
        activeSession.id,
        configId,
        value
      )
      setConfigOptions(updated)
      return updated
    },
    [getManager, activeAgentId, activeSession]
  )

  // Get config options
  const getConfigOptions = useCallback((): AcpConfigOption[] => {
    if (!activeAgentId || !activeSession || !managerRef.current) {
      return configOptions
    }
    const result = managerRef.current.getConfigOptions(activeAgentId, activeSession.id)
    return result.status === "ok" ? result.data : configOptions
  }, [activeAgentId, activeSession, configOptions])

  // Get agent tools
  const getAgentTools = useCallback(
    (agentId?: string): Record<string, AgentTool> => {
      const targetAgentId = agentId || activeAgentId
      if (!targetAgentId || !managerRef.current) {
        return {}
      }

      return managerRef.current.getAgentTools(targetAgentId)
    },
    [activeAgentId]
  )

  // Check agent health
  const checkHealth = useCallback(
    async (agentId: string): Promise<boolean> => {
      try {
        const manager = await getManager()
        return await manager.checkAgentHealth(agentId)
      } catch {
        return false
      }
    },
    [getManager]
  )

  // Clear error
  const clearError = useCallback(() => {
    setError(null)
  }, [])

  return {
    // State
    agents,
    activeAgentId,
    activeSession,
    isLoading,
    isExecuting,
    error,
    progress,
    pendingPermission,
    pendingElicitation,
    availableCommands,
    planEntries,
    planStep,
    planDocument,
    streamingResponse,
    lastResult,
    configOptions,
    richContentBlocks,
    compactionUpdates,
    nesSuggestions,
    activeAgentValidity,
    activeLastRunSnapshot,
    activeBenchmarkCapabilities,
    // Actions
    addAgent,
    removeAgent,
    connect,
    disconnect,
    reconnect,
    setActiveAgent,
    createSession,
    closeSession,
    listSessions,
    forkSession,
    compactSession,
    supportsCompaction,
    supportsCompactionFocus,
    compactionCapability,
    isCompacting,
    undoLastProviderChange,
    providerUndoCapability,
    providerUndoAcknowledged,
    acknowledgeProviderUndoWarning,
    resetProviderUndoWarning,
    isProviderUndoing,
    resumeSession,
    execute,
    executeStreaming,
    cancel,
    respondToPermission,
    respondToElicitation,
    setSessionMode,
    setSessionModel,
    getSessionModels,
    getAuthMethods,
    isAuthenticationRequired,
    authenticate,
    getTerminalAuthState,
    cancelTerminalAuthentication,
    listProviders,
    setProvider,
    disableProvider,
    startNes,
    suggestNes,
    closeNes,
    getDynamicMcpConnections,
    setConfigOption,
    getConfigOptions,
    getAgentTools,
    checkHealth,
    refresh,
    clearError,
  }
}

// ============================================================================
// Utility Hooks
// ============================================================================

/**
 * Hook to get a specific external agent by ID
 */
export function useExternalAgentById(agentId: string | null): {
  agent: ExternalAgentInstance | null
  isConnected: boolean
  capabilities: AcpCapabilities | null
  /**
   * The merged capability answer (ADR-0090 external SSOT).
   *
   * `capabilities` above is only the raw ACP handshake block, which is why
   * every surface that consumed it had to add its own reading of the protocol
   * on top — and each did it differently. This is the same artifact the CLI,
   * the TUI and the execution resolver read. `null` before the agent connects.
   */
  capabilityProfile: ExternalAgentCapabilityProfileV1 | null
  tools: AcpToolInfo[]
} {
  const { agents } = useExternalAgent()

  const agent = agentId ? agents.find((a) => a.config.id === agentId) || null : null

  return {
    agent,
    isConnected: agent?.connectionStatus === "connected",
    capabilities: agent?.capabilities || null,
    capabilityProfile: agent?.capabilityProfile ?? null,
    tools: agent?.tools || [],
  }
}

/**
 * Hook to get all connected external agents
 */
export function useConnectedExternalAgents(): ExternalAgentInstance[] {
  const { agents } = useExternalAgent()
  return agents.filter((a) => a.connectionStatus === "connected")
}

/**
 * Hook to get external agent connection status
 */
export function useExternalAgentConnectionStatus(
  agentId: string | null
): ExternalAgentConnectionStatus {
  const { agent } = useExternalAgentById(agentId)
  return agent?.connectionStatus || "disconnected"
}

export default useExternalAgent
