/**
 * useExternalAgent Hook
 *
 * React hook for managing external agent connections and interactions.
 * Provides a simple interface for connecting to, managing, and executing on external agents.
 */

"use client"

import { useState, useCallback, useEffect, useRef } from "react"
import { loggers } from "@/lib/logging"
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
  AcpAvailableCommand,
  AcpPlanEntry,
  AcpPermissionMode,
  AcpSessionModelState,
  AcpAuthMethod,
  AcpConfigOption,
  ExternalAgentLastRunSnapshot,
  ExternalAgentValiditySnapshot,
} from "@/types/agent/external-agent"
import type { AgentTool } from "@/lib/ai/agent"
import { getPluginEventHooks } from "@/lib/plugin"
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
  /** Available slash commands for the active session */
  availableCommands: AcpAvailableCommand[]
  /** Current plan entries for the active session */
  planEntries: AcpPlanEntry[]
  /** Current plan step index */
  planStep: number | null
  /** Streaming response text */
  streamingResponse: string
  /** Last execution result */
  lastResult: ExternalAgentResult | null
  /** Session config options (ACP spec) */
  configOptions: AcpConfigOption[]
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
  createSession: (options?: { systemPrompt?: string }) => Promise<ExternalAgentSession>
  /** Close a session */
  closeSession: (sessionId: string) => Promise<void>
  /** List existing sessions (ACP extension) */
  listSessions: (
    agentId?: string
  ) => Promise<Array<{ sessionId: string; title?: string; createdAt?: string; updatedAt?: string }>>
  /** Fork a session (ACP extension) */
  forkSession: (sessionId: string) => Promise<ExternalAgentSession>
  /** Trigger server-side context compaction (Codex app-server only) */
  compactSession: (sessionId: string) => Promise<void>
  /** Whether the active agent supports server-side context compaction */
  supportsCompaction: boolean
  /** Resume a session (ACP extension) */
  resumeSession: (
    sessionId: string,
    options?: { systemPrompt?: string }
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
  /** Set a session config option */
  setConfigOption: (configId: string, value: string) => Promise<AcpConfigOption[]>
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
  const storeSetActiveAgent = useExternalAgentStore((state) => state.setActiveAgent)
  const storeGetAllAgents = useExternalAgentStore((state) => state.getAllAgents)
  const storeGetConnectionStatus = useExternalAgentStore((state) => state.getConnectionStatus)
  const storeAddAgent = useExternalAgentStore((state) => state.addAgent)
  const storeRemoveAgent = useExternalAgentStore((state) => state.removeAgent)
  const storeSetConnectionStatus = useExternalAgentStore((state) => state.setConnectionStatus)
  const storeSetAgentValidity = useExternalAgentStore((state) => state.setAgentValidity)
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
  const [availableCommands, setAvailableCommands] = useState<AcpAvailableCommand[]>([])
  const [planEntries, setPlanEntries] = useState<AcpPlanEntry[]>([])
  const [planStep, setPlanStep] = useState<number | null>(null)
  const [streamingResponse, setStreamingResponse] = useState("")
  const [configOptions, setConfigOptions] = useState<AcpConfigOption[]>([])
  const [lastResult, setLastResult] = useState<ExternalAgentResult | null>(null)
  const [activeAgentValidity, setActiveAgentValidity] =
    useState<ExternalAgentValiditySnapshot | null>(null)
  const [activeLastRunSnapshot, setActiveLastRunSnapshot] =
    useState<ExternalAgentLastRunSnapshot | null>(null)
  const [activeBenchmarkCapabilities, setActiveBenchmarkCapabilities] = useState<
    ExternalAgentBenchmarkCapabilityEntry[]
  >([])
  const [supportsCompaction, setSupportsCompaction] = useState(false)
  const activeAgentId = storeActiveAgentId

  // Type for the external agent manager
  type ExternalAgentManagerType = Awaited<
    ReturnType<typeof import("@/lib/ai/agent/external/manager").getExternalAgentManager>
  >

  // Refs for managing execution
  const abortControllerRef = useRef<AbortController | null>(null)
  const managerRef = useRef<ExternalAgentManagerType | null>(null)
  const permissionResolveRef = useRef<((response: AcpPermissionResponse) => void) | null>(null)
  const executingSessionIdRef = useRef<string | null>(null)
  const activeAgentIdRef = useRef<string | null>(activeAgentId)
  const previousActiveAgentIdRef = useRef<string | null>(activeAgentId)

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
          const currentStatus = storeGetConnectionStatus(config.id)
          const normalizedRuntimeValidity = runtime.validity
            ? normalizeExternalAgentValiditySnapshot(runtime.validity, {
                fallbackProtocol: config.protocol,
                fallbackSource: runtime.validity.source,
              })
            : undefined
          if (currentStatus !== runtime.connectionStatus || runtime.validity) {
            useExternalAgentStore.setState((state) => ({
              connectionStatus:
                currentStatus !== runtime.connectionStatus
                  ? { ...state.connectionStatus, [config.id]: runtime.connectionStatus }
                  : state.connectionStatus,
              agentValidity: normalizedRuntimeValidity
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
          ? normalizeExternalAgentValiditySnapshot(event.validity, {
              fallbackProtocol: protocol,
              fallbackSource: event.validity.source,
            })
          : undefined
        const currentStatus = storeState.getConnectionStatus(event.agentId)
        if (currentStatus !== event.connectionStatus || event.validity) {
          useExternalAgentStore.setState((state) => ({
            connectionStatus:
              currentStatus !== event.connectionStatus
                ? { ...state.connectionStatus, [event.agentId]: event.connectionStatus }
                : state.connectionStatus,
            agentValidity: normalizedValidity
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
        }
      })
    }

    void bindLifecycleListener()

    return () => {
      isActive = false
      unsubscribe?.()
    }
  }, [getManager])

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
        return
      }

      const manager = await getManager()

      if (!isActive) return

      unsubscribe = manager.addEventListener(activeAgentId, (event) => {
        if (event.type === "commands_update") {
          setAvailableCommands(event.commands)
        }
        if (event.type === "plan_update") {
          setPlanEntries(event.entries)
          setPlanStep(event.step ?? null)
        }
        if (event.type === "config_options_update") {
          setConfigOptions(event.configOptions)
        }
        if (event.type === "mode_update") {
          // Sync configOptions mode value if present
          setConfigOptions((prev) =>
            prev.map((opt) =>
              opt.category === "mode" ? { ...opt, currentValue: event.modeId } : opt
            )
          )
        }
      })

      if (activeSession) {
        const session = manager.getSession(activeAgentId, activeSession.id)
        const sessionCommands = session?.metadata?.availableCommands as
          | AcpAvailableCommand[]
          | undefined
        const sessionPlan = session?.metadata?.plan as AcpPlanEntry[] | undefined
        const sessionConfigOptions = session?.metadata?.configOptions as
          | AcpConfigOption[]
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
      }
    }

    attach()

    return () => {
      isActive = false
      unsubscribe?.()
    }
  }, [activeAgentId, activeSession, getManager])

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

        if (activeAgentId === agentId) {
          storeSetActiveAgent(null)
          setActiveSession(null)
        }

        await refresh()
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [getManager, refresh, activeAgentId, storeRemoveAgent, storeSetActiveAgent]
  )

  // Connect to an agent
  const connect = useCallback(
    async (agentId: string): Promise<void> => {
      setIsLoading(true)
      setError(null)

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
        storeSetConnectionStatus(agentId, "error")
        getPluginEventHooks().dispatchExternalAgentError(agentId, message)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [getManager, refresh, storeSetConnectionStatus]
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

  // Set active agent
  const setActiveAgent = useCallback(
    (agentId: string | null) => {
      storeSetActiveAgent(agentId)
      setActiveSession(null)
      executingSessionIdRef.current = null
      setError(null)
    },
    [storeSetActiveAgent]
  )

  // Create a new session
  const createSession = useCallback(
    async (options?: { systemPrompt?: string }): Promise<ExternalAgentSession> => {
      if (!activeAgentId) {
        throw new Error("No active agent selected")
      }

      setIsLoading(true)
      setError(null)

      try {
        const manager = await getManager()
        const session = await manager.createSession(activeAgentId, {
          systemPrompt: options?.systemPrompt,
        })
        setActiveSession(session)
        executingSessionIdRef.current = session.id
        return session
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [getManager, activeAgentId]
  )

  // Close a session
  const closeSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!activeAgentId) {
        return
      }

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
        throw err
      } finally {
        setIsLoading(false)
      }
    },
    [getManager, activeAgentId, activeSession]
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
      agentId?: string
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
        return await manager.listSessions(targetAgentId)
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
    async (sessionId: string): Promise<ExternalAgentSession> => {
      if (!activeAgentId) {
        throw new Error("No active agent selected")
      }
      let manager: ExternalAgentManagerType | null = null
      try {
        manager = await getManager()
        const forked = await manager.forkSession(activeAgentId, sessionId)
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
        syncActiveAgentValidityFromRuntime(activeAgentId, manager)
      }
    },
    [getManager, activeAgentId, syncActiveAgentValidityFromRuntime]
  )

  // Probe compaction support whenever the active agent or session changes —
  // gates the session-panel "Compact context" button on the live adapter
  // capability instead of a protocol-string check.
  useEffect(() => {
    let active = true
    void (async () => {
      if (!activeAgentId || !activeSession) {
        if (active) setSupportsCompaction(false)
        return
      }
      try {
        const manager = await getManager()
        const adapter = manager.getCodexAppServerAdapter(activeAgentId)
        if (active) setSupportsCompaction(adapter?.supportsCompaction() ?? false)
      } catch {
        if (active) setSupportsCompaction(false)
      }
    })()
    return () => {
      active = false
    }
  }, [activeAgentId, activeSession, getManager])

  // Server-side context compaction — Codex app-server only (thread/compact/start).
  // Exposed behind a capability probe so UI gates on the adapter, not protocol.
  const compactSession = useCallback(
    async (sessionId: string): Promise<void> => {
      if (!activeAgentId) {
        throw new Error("No active agent selected")
      }
      const manager = await getManager()
      const adapter = manager.getCodexAppServerAdapter(activeAgentId)
      if (!adapter?.supportsCompaction()) {
        throw new Error("Agent does not support context compaction")
      }
      await adapter.compactSession(sessionId)
    },
    [getManager, activeAgentId]
  )

  const resumeSession = useCallback(
    async (
      sessionId: string,
      options?: { systemPrompt?: string }
    ): Promise<ExternalAgentSession> => {
      if (!activeAgentId) {
        throw new Error("No active agent selected")
      }
      let manager: ExternalAgentManagerType | null = null
      try {
        manager = await getManager()
        const resumed = await manager.resumeSession(activeAgentId, sessionId, {
          systemPrompt: options?.systemPrompt,
        })
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

        // Dispatch external agent error hook
        getPluginEventHooks().dispatchExternalAgentError(activeAgentId, message)

        throw err
      } finally {
        setIsExecuting(false)
        setProgress(100)
        setPendingPermission(null)
        abortControllerRef.current = null
      }
    },
    [getManager, activeAgentId, activeSession]
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

          yield event
        }
      } catch (err) {
        const message = getExternalAgentErrorMessage(err)
        setError(message)
        throw err
      } finally {
        setIsExecuting(false)
        setProgress(100)
        setPendingPermission(null)
        abortControllerRef.current = null
      }
    },
    [getManager, activeAgentId, activeSession]
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
        }
      }

      setPendingPermission(null)
    },
    [getManager, activeAgentId, pendingPermission]
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

  // Set config option
  const setConfigOption = useCallback(
    async (configId: string, value: string): Promise<AcpConfigOption[]> => {
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
    availableCommands,
    planEntries,
    planStep,
    streamingResponse,
    lastResult,
    configOptions,
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
    resumeSession,
    execute,
    executeStreaming,
    cancel,
    respondToPermission,
    setSessionMode,
    setSessionModel,
    getSessionModels,
    getAuthMethods,
    isAuthenticationRequired,
    authenticate,
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
  tools: AcpToolInfo[]
} {
  const { agents } = useExternalAgent()

  const agent = agentId ? agents.find((a) => a.config.id === agentId) || null : null

  return {
    agent,
    isConnected: agent?.connectionStatus === "connected",
    capabilities: agent?.capabilities || null,
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
