import type { StoreApi } from "zustand"
import { nanoid } from "nanoid"
import { loggers } from "@cognia/logging"
import type {
  ExternalAgentBenchmarkCapabilityEntry,
  ExternalAgentConfig,
  ExternalAgentConnectionStatus,
  ExternalAgentDelegationRule,
  CreateExternalAgentInput,
  UpdateExternalAgentInput,
} from "@/types/agent/external-agent"
import { createAgentFromPreset, type ExternalAgentPresetId } from "@/lib/ai/agent/external/presets"
import { normalizeExternalAgentConfigInput } from "@/lib/ai/agent/external/config-normalizer"
import {
  createExternalAgentBenchmarkBaseline,
  normalizeExternalAgentValiditySnapshot,
  validateExternalAgentBenchmarkCapabilityEntry,
  validateExternalAgentBenchmarkCapabilityMap,
} from "@/lib/ai/agent/external/canonical-contract"
import { isTauri } from "@/lib/utils"
import {
  ExternalAgentSpawnConfig,
  TerminalInfo,
  TerminalOutputResult,
  spawnExternalAgent,
  sendToExternalAgent,
  killExternalAgent,
  getExternalAgentStatus,
  listExternalAgents,
  killAllExternalAgents,
  acpTerminalCreate,
  acpTerminalOutput,
  acpTerminalKill,
  acpTerminalRelease,
  acpTerminalWaitForExit,
  acpTerminalWrite,
  acpTerminalGetSessionTerminals,
  acpTerminalKillSessionTerminals,
  acpTerminalIsRunning,
  acpTerminalGetInfo,
  acpTerminalList,
} from "@/lib/native/external-agent"
import { initialState } from "../initial-state"
import { hydrateAgentConfig } from "../selectors"
import type {
  StoredExternalAgentConfig,
  RunningAgentInstance,
  TerminalInstance,
  ExternalAgentState,
  ExternalAgentStore,
} from "../types"

type ExternalAgentStoreSet = StoreApi<ExternalAgentStore>["setState"]
type ExternalAgentStoreGet = StoreApi<ExternalAgentStore>["getState"]

type ExternalAgentActionsSlice = Omit<ExternalAgentStore, keyof typeof initialState>

const externalAgentStoreLogger = loggers.agent.child("external-agent-store")

function toDate(value: Date | string | undefined, fallback = new Date()): Date {
  if (value instanceof Date) {
    return value
  }
  if (typeof value === "string") {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) {
      return parsed
    }
  }
  return fallback
}

function normalizeBenchmarkEntry(
  entry: ExternalAgentBenchmarkCapabilityEntry
): ExternalAgentBenchmarkCapabilityEntry {
  return {
    ...entry,
    updatedAt: toDate(entry.updatedAt),
    evidence: entry.evidence.map((item) => ({
      ...item,
      recordedAt: toDate(item.recordedAt),
    })),
    deviation: entry.deviation
      ? {
          ...entry.deviation,
          review: {
            ...entry.deviation.review,
            reviewedAt: toDate(entry.deviation.review.reviewedAt),
          },
        }
      : undefined,
  }
}

export const createExternalAgentActionsSlice = (
  set: ExternalAgentStoreSet,
  get: ExternalAgentStoreGet
): ExternalAgentActionsSlice => ({
  // ========================================
  // Agent CRUD
  // ========================================

  addAgent: (input: CreateExternalAgentInput): string => {
    const id = nanoid()
    const normalizedAt = new Date()
    const normalized = normalizeExternalAgentConfigInput(input, {
      id,
      now: normalizedAt,
      defaultPermissionMode: get().defaultPermissionMode,
    })
    const config: StoredExternalAgentConfig = {
      ...normalized,
      createdAt: normalized.createdAt?.toISOString() ?? normalizedAt.toISOString(),
      updatedAt: normalized.updatedAt?.toISOString() ?? normalizedAt.toISOString(),
    }
    const normalizedValidity = config.validitySnapshot
      ? normalizeExternalAgentValiditySnapshot(config.validitySnapshot, {
          fallbackProtocol: config.protocol,
          fallbackSource: config.validitySnapshot.source,
        })
      : undefined
    const baseline = createExternalAgentBenchmarkBaseline(normalizedAt)

    set((state) => ({
      agents: { ...state.agents, [id]: config },
      connectionStatus: { ...state.connectionStatus, [id]: "disconnected" },
      agentValidity: normalizedValidity
        ? { ...state.agentValidity, [id]: normalizedValidity }
        : state.agentValidity,
      benchmarkCapabilityMap: {
        ...state.benchmarkCapabilityMap,
        [id]: baseline,
      },
    }))

    return id
  },

  addAgentFromPreset: (
    presetId: string,
    overrides?: Partial<CreateExternalAgentInput>
  ): string | null => {
    const presetConfig = createAgentFromPreset(
      presetId as ExternalAgentPresetId,
      overrides as Partial<ExternalAgentConfig>
    )
    if (!presetConfig) {
      return null
    }

    const normalizedAt = presetConfig.createdAt ?? new Date()
    const normalized = normalizeExternalAgentConfigInput(
      {
        name: presetConfig.name,
        description: presetConfig.description,
        protocol: presetConfig.protocol,
        transport: presetConfig.transport,
        process: presetConfig.process,
        network: presetConfig.network,
        defaultPermissionMode: presetConfig.defaultPermissionMode,
        autoApprovePatterns: presetConfig.autoApprovePatterns,
        requireApprovalFor: presetConfig.requireApprovalFor,
        timeout: presetConfig.timeout,
        retryConfig: presetConfig.retryConfig,
        tags: presetConfig.tags,
        metadata: presetConfig.metadata,
        validitySnapshot: presetConfig.validitySnapshot,
      },
      {
        id: presetConfig.id,
        now: normalizedAt,
        enabled: presetConfig.enabled,
        defaultPermissionMode: get().defaultPermissionMode,
      }
    )
    const now = normalizedAt.toISOString()
    const stored: StoredExternalAgentConfig = {
      ...normalized,
      createdAt: now,
      updatedAt: now,
    }
    const normalizedValidity = normalized.validitySnapshot
      ? normalizeExternalAgentValiditySnapshot(normalized.validitySnapshot, {
          fallbackProtocol: normalized.protocol,
          fallbackSource: normalized.validitySnapshot.source,
        })
      : undefined
    const baseline = createExternalAgentBenchmarkBaseline(new Date(now))

    set((state) => ({
      agents: { ...state.agents, [normalized.id]: stored },
      connectionStatus: { ...state.connectionStatus, [normalized.id]: "disconnected" },
      agentValidity: normalizedValidity
        ? { ...state.agentValidity, [normalized.id]: normalizedValidity }
        : state.agentValidity,
      benchmarkCapabilityMap: {
        ...state.benchmarkCapabilityMap,
        [normalized.id]: baseline,
      },
    }))

    return normalized.id
  },

  updateAgent: (id: string, updates: UpdateExternalAgentInput): void => {
    set((state) => {
      const agent = state.agents[id]
      if (!agent) return state

      const now = new Date().toISOString()
      const updated: StoredExternalAgentConfig = {
        ...agent,
        name: updates.name ?? agent.name,
        description: updates.description ?? agent.description,
        enabled: updates.enabled ?? agent.enabled,
        process: updates.process
          ? ({ ...agent.process, ...updates.process } as StoredExternalAgentConfig["process"])
          : agent.process,
        network: updates.network
          ? ({ ...agent.network, ...updates.network } as StoredExternalAgentConfig["network"])
          : agent.network,
        defaultPermissionMode: updates.defaultPermissionMode ?? agent.defaultPermissionMode,
        autoApprovePatterns: updates.autoApprovePatterns ?? agent.autoApprovePatterns,
        requireApprovalFor: updates.requireApprovalFor ?? agent.requireApprovalFor,
        codexOptions: updates.codexOptions ?? agent.codexOptions,
        timeout: updates.timeout ?? agent.timeout,
        retryConfig: updates.retryConfig
          ? ({
              ...agent.retryConfig,
              ...updates.retryConfig,
            } as StoredExternalAgentConfig["retryConfig"])
          : agent.retryConfig,
        tags: updates.tags ?? agent.tags,
        validitySnapshot: updates.validitySnapshot
          ? normalizeExternalAgentValiditySnapshot(updates.validitySnapshot, {
              fallbackProtocol: agent.protocol,
              fallbackSource: updates.validitySnapshot.source,
            })
          : agent.validitySnapshot,
        metadata: updates.metadata ? { ...agent.metadata, ...updates.metadata } : agent.metadata,
        updatedAt: now,
      }

      return { agents: { ...state.agents, [id]: updated } }
    })
  },

  replaceAgentConfig: (id, config): void => {
    set((state) => {
      const existing = state.agents[id]
      if (!existing) return state

      const { createdAt: _ignoredCreatedAt, updatedAt: _ignoredUpdatedAt, ...rest } = config
      const replaced: StoredExternalAgentConfig = {
        ...rest,
        id,
        // Creation time is a fact about the agent, not part of the payload the
        // caller rebuilt, so it survives a wholesale replacement.
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      }

      return { agents: { ...state.agents, [id]: replaced } }
    })
  },

  patchLifecycle: (id, fields): void => {
    set((state) => {
      const agent = state.agents[id]
      if (!agent) return state

      const updated: StoredExternalAgentConfig = { ...agent }
      const target = updated as unknown as Record<string, unknown>
      const current = agent as unknown as Record<string, unknown>
      let changed = false

      // An explicitly-present `undefined` means "remove this", which is how a
      // revoked Windows consent or a cleared reason code actually disappears.
      // Spreading `fields` would keep the key with an undefined value and the
      // persisted record would still claim to have one.
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) {
          if (!(key in current)) continue
          delete target[key]
          changed = true
        } else {
          if (JSON.stringify(current[key]) === JSON.stringify(value)) continue
          target[key] = value
          changed = true
        }
      }

      // Reconciliation runs on every startup and re-affirms the same verdict
      // for most agents. Replacing the stored object anyway would mint a fresh
      // hydrated config each time and defeat the identity cache that keeps
      // `useSyncExternalStore` from looping (see `hydrateAgentConfig`).
      if (!changed) return state

      updated.updatedAt = new Date().toISOString()
      return { agents: { ...state.agents, [id]: updated } }
    })
  },

  removeAgent: (id: string): void => {
    set((state) => {
      const { [id]: _removed, ...rest } = state.agents
      const { [id]: _removedStatus, ...restStatus } = state.connectionStatus
      const { [id]: _removedValidity, ...restValidity } = state.agentValidity
      const { [id]: _removedBenchmark, ...restBenchmark } = state.benchmarkCapabilityMap
      const { [id]: _removedLastRun, ...restLastRun } = state.lastRunSnapshots

      return {
        agents: rest,
        connectionStatus: restStatus,
        agentValidity: restValidity,
        benchmarkCapabilityMap: restBenchmark,
        lastRunSnapshots: restLastRun,
        activeAgentId: state.activeAgentId === id ? null : state.activeAgentId,
        delegationRules: state.delegationRules.filter((r) => r.targetAgentId !== id),
      }
    })
  },

  getAgent: (id: string): ExternalAgentConfig | undefined => {
    const stored = get().agents[id]
    if (!stored) return undefined

    return hydrateAgentConfig(stored)
  },

  getAllAgents: (): ExternalAgentConfig[] => {
    return Object.values(get().agents).map((stored) => hydrateAgentConfig(stored))
  },

  // ========================================
  // Connection Status
  // ========================================

  setConnectionStatus: (id: string, status: ExternalAgentConnectionStatus): void => {
    set((state) => ({
      connectionStatus: { ...state.connectionStatus, [id]: status },
    }))
  },

  getConnectionStatus: (id: string): ExternalAgentConnectionStatus => {
    return get().connectionStatus[id] || "disconnected"
  },

  setAgentValidity: (id, snapshot): void => {
    const protocol = get().agents[id]?.protocol ?? "acp"
    const normalized = normalizeExternalAgentValiditySnapshot(snapshot, {
      fallbackProtocol: protocol,
      fallbackSource: snapshot.source,
    })
    set((state) => ({
      agentValidity: {
        ...state.agentValidity,
        [id]: normalized,
      },
    }))
  },

  getAgentValidity: (id) => {
    return get().agentValidity[id]
  },

  setLastRunSnapshot: (id, snapshot) => {
    set((state) => ({
      lastRunSnapshots: {
        ...state.lastRunSnapshots,
        [id]: {
          ...snapshot,
          timestamp: toDate(snapshot.timestamp),
        },
      },
    }))
  },

  getLastRunSnapshot: (id) => {
    return get().lastRunSnapshots[id]
  },

  setBenchmarkCapabilities: (id, entries) => {
    const normalizedEntries = entries.map((entry) => normalizeBenchmarkEntry(entry))
    const validation = validateExternalAgentBenchmarkCapabilityMap(normalizedEntries)
    if (!validation.valid) {
      throw new Error(validation.errors.join(" "))
    }
    set((state) => ({
      benchmarkCapabilityMap: {
        ...state.benchmarkCapabilityMap,
        [id]: normalizedEntries,
      },
    }))
  },

  upsertBenchmarkCapability: (id, entry) => {
    const normalizedEntry = normalizeBenchmarkEntry(entry)
    const validation = validateExternalAgentBenchmarkCapabilityEntry(normalizedEntry)
    if (!validation.valid) {
      throw new Error(validation.errors.join(" "))
    }
    set((state) => {
      const existing = state.benchmarkCapabilityMap[id] ?? []
      const index = existing.findIndex((item) => item.id === normalizedEntry.id)
      const next =
        index >= 0
          ? existing.map((item, currentIndex) => (currentIndex === index ? normalizedEntry : item))
          : [...existing, normalizedEntry]
      return {
        benchmarkCapabilityMap: {
          ...state.benchmarkCapabilityMap,
          [id]: next,
        },
      }
    })
  },

  getBenchmarkCapabilities: (id) => {
    return get().benchmarkCapabilityMap[id] || []
  },

  // ========================================
  // Active Agent
  // ========================================

  setActiveAgent: (id: string | null): void => {
    set({ activeAgentId: id })
  },

  // ========================================
  // Delegation Rules
  // ========================================

  addDelegationRule: (rule: Omit<ExternalAgentDelegationRule, "id">): string => {
    const id = nanoid()
    const newRule: ExternalAgentDelegationRule = { ...rule, id }

    set((state) => ({
      delegationRules: [...state.delegationRules, newRule].sort((a, b) => b.priority - a.priority),
    }))

    return id
  },

  updateDelegationRule: (id: string, updates: Partial<ExternalAgentDelegationRule>): void => {
    set((state) => ({
      delegationRules: state.delegationRules
        .map((rule) => (rule.id === id ? { ...rule, ...updates } : rule))
        .sort((a, b) => b.priority - a.priority),
    }))
  },

  removeDelegationRule: (id: string): void => {
    set((state) => ({
      delegationRules: state.delegationRules.filter((rule) => rule.id !== id),
    }))
  },

  reorderDelegationRules: (ruleIds: string[]): void => {
    set((state) => {
      const rulesMap = new Map(state.delegationRules.map((r) => [r.id, r]))
      const reordered = ruleIds
        .map((id, index) => {
          const rule = rulesMap.get(id)
          if (rule) {
            return { ...rule, priority: ruleIds.length - index }
          }
          return null
        })
        .filter((r): r is ExternalAgentDelegationRule => r !== null)

      return { delegationRules: reordered }
    })
  },

  // ========================================
  // Settings
  // ========================================

  setEnabled: (enabled: boolean): void => {
    set({ enabled })
  },

  setDefaultPermissionMode: (mode: ExternalAgentState["defaultPermissionMode"]): void => {
    set({ defaultPermissionMode: mode })
  },

  setAutoConnectOnStartup: (enabled: boolean): void => {
    set({ autoConnectOnStartup: enabled })
  },

  setShowConnectionNotifications: (enabled: boolean): void => {
    set({ showConnectionNotifications: enabled })
  },

  setChatFailurePolicy: (policy: ExternalAgentState["chatFailurePolicy"]): void => {
    set({ chatFailurePolicy: policy })
  },

  // ========================================
  // Bulk Operations
  // ========================================

  importAgents: (agents: ExternalAgentConfig[]): void => {
    set((state) => {
      const newAgents = { ...state.agents }
      const newStatus = { ...state.connectionStatus }
      const newValidity = { ...state.agentValidity }
      const newBenchmarkMap = { ...state.benchmarkCapabilityMap }

      for (const agent of agents) {
        const stored: StoredExternalAgentConfig = {
          ...agent,
          createdAt: agent.createdAt?.toISOString() || new Date().toISOString(),
          updatedAt: agent.updatedAt?.toISOString() || new Date().toISOString(),
        }
        newAgents[agent.id] = stored
        newStatus[agent.id] = "disconnected"
        if (agent.validitySnapshot) {
          newValidity[agent.id] = normalizeExternalAgentValiditySnapshot(agent.validitySnapshot, {
            fallbackProtocol: agent.protocol,
            fallbackSource: agent.validitySnapshot.source,
          })
        }
        newBenchmarkMap[agent.id] =
          newBenchmarkMap[agent.id] || createExternalAgentBenchmarkBaseline()
      }

      return {
        agents: newAgents,
        connectionStatus: newStatus,
        agentValidity: newValidity,
        benchmarkCapabilityMap: newBenchmarkMap,
      }
    })
  },

  exportAgents: (): ExternalAgentConfig[] => {
    return get().getAllAgents()
  },

  clearAllAgents: (): void => {
    set({
      agents: {},
      connectionStatus: {},
      agentValidity: {},
      benchmarkCapabilityMap: {},
      lastRunSnapshots: {},
      activeAgentId: null,
      delegationRules: [],
    })
  },

  // ========================================
  // Reset
  // ========================================

  reset: (): void => {
    set(initialState)
  },

  // ========================================
  // Runtime Operations - Spawned Agents
  // ========================================

  spawnAgent: async (config: ExternalAgentSpawnConfig): Promise<string> => {
    if (!isTauri()) {
      throw new Error("External agent is only available in Tauri environment")
    }

    set({ isLoading: true, lastError: null })

    try {
      const id = await spawnExternalAgent(config)
      set((state) => ({
        runningAgents: {
          ...state.runningAgents,
          [id]: {
            id,
            status: "running",
            output: [],
            spawnedAt: Date.now(),
          },
        },
        runningAgentIds: [...state.runningAgentIds, id],
        isLoading: false,
      }))
      return id
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("spawnAgent failed", { err })
      set({ lastError: message, isLoading: false })
      throw err
    }
  },

  sendToAgent: async (agentId: string, message: string): Promise<void> => {
    if (!isTauri()) {
      throw new Error("External agent is only available in Tauri environment")
    }

    try {
      await sendToExternalAgent(agentId, message)
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("sendToAgent failed", { agentId, err })
      set({ lastError: errorMessage })
      throw err
    }
  },

  killRunningAgent: async (agentId: string): Promise<void> => {
    if (!isTauri()) return

    try {
      await killExternalAgent(agentId)
      set((state) => {
        const agent = state.runningAgents[agentId]
        if (agent) {
          return {
            runningAgents: {
              ...state.runningAgents,
              [agentId]: { ...agent, status: "stopped" },
            },
          }
        }
        return state
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("killRunningAgent failed", { agentId, err })
      set({ lastError: message })
      throw err
    }
  },

  getRunningAgentStatus: async (agentId: string): Promise<string> => {
    if (!isTauri()) {
      throw new Error("External agent is only available in Tauri environment")
    }

    return getExternalAgentStatus(agentId)
  },

  refreshRunningAgents: async (): Promise<void> => {
    if (!isTauri()) return

    set({ isLoading: true })

    try {
      const agentIds = await listExternalAgents()
      const runningAgents: Record<string, RunningAgentInstance> = {}

      for (const id of agentIds) {
        const status = await getExternalAgentStatus(id)
        const existing = get().runningAgents[id]
        runningAgents[id] = {
          id,
          status: status === "Running" ? "running" : "stopped",
          output: existing?.output ?? [],
          exitCode: existing?.exitCode,
          spawnedAt: existing?.spawnedAt ?? Date.now(),
        }
      }

      set({ runningAgents, runningAgentIds: agentIds, isLoading: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("refreshRunningAgents failed", { err })
      set({ lastError: message, isLoading: false })
    }
  },

  killAllRunningAgents: async (): Promise<void> => {
    if (!isTauri()) return

    try {
      await killAllExternalAgents()
      set({ runningAgents: {}, runningAgentIds: [] })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("killAllRunningAgents failed", { err })
      set({ lastError: message })
      throw err
    }
  },

  // ========================================
  // Runtime Operations - ACP Terminals
  // ========================================

  createTerminal: async (
    sessionId: string,
    command: string,
    args: string[] = [],
    cwd?: string
  ): Promise<string> => {
    if (!isTauri()) {
      throw new Error("ACP terminal is only available in Tauri environment")
    }

    set({ isLoading: true, lastError: null })

    try {
      const terminalId = await acpTerminalCreate(sessionId, command, args, cwd)
      set((state) => ({
        terminals: {
          ...state.terminals,
          [terminalId]: {
            id: terminalId,
            sessionId,
            command,
            isRunning: true,
            output: "",
            exitCode: null,
            createdAt: Date.now(),
          },
        },
        terminalIds: [...state.terminalIds, terminalId],
        isLoading: false,
      }))
      return terminalId
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("createTerminal failed", { sessionId, err })
      set({ lastError: message, isLoading: false })
      throw err
    }
  },

  writeToTerminal: async (terminalId: string, data: string): Promise<void> => {
    if (!isTauri()) {
      throw new Error("ACP terminal is only available in Tauri environment")
    }

    try {
      await acpTerminalWrite(terminalId, data)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("writeToTerminal failed", { terminalId, err })
      set({ lastError: message })
      throw err
    }
  },

  getTerminalOutput: async (terminalId: string): Promise<TerminalOutputResult> => {
    if (!isTauri()) {
      throw new Error("ACP terminal is only available in Tauri environment")
    }

    const result = await acpTerminalOutput(terminalId)

    set((state) => {
      const terminal = state.terminals[terminalId]
      const nextExitCode = result.exitCode ?? result.exitStatus.exitCode ?? null
      if (terminal) {
        return {
          terminals: {
            ...state.terminals,
            [terminalId]: {
              ...terminal,
              output: result.output,
              exitCode: nextExitCode,
            },
          },
        }
      }
      return state
    })

    return result
  },

  killTerminal: async (terminalId: string): Promise<void> => {
    if (!isTauri()) return

    try {
      await acpTerminalKill(terminalId)
      set((state) => {
        const terminal = state.terminals[terminalId]
        if (terminal) {
          return {
            terminals: {
              ...state.terminals,
              [terminalId]: { ...terminal, isRunning: false },
            },
          }
        }
        return state
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("killTerminal failed", { terminalId, err })
      set({ lastError: message })
      throw err
    }
  },

  releaseTerminal: async (terminalId: string): Promise<void> => {
    if (!isTauri()) return

    try {
      await acpTerminalRelease(terminalId)
      set((state) => {
        const { [terminalId]: _, ...terminals } = state.terminals
        return {
          terminals,
          terminalIds: state.terminalIds.filter((id) => id !== terminalId),
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("releaseTerminal failed", { terminalId, err })
      set({ lastError: message })
      throw err
    }
  },

  waitForTerminalExit: async (terminalId: string, timeout?: number): Promise<number | null> => {
    if (!isTauri()) {
      throw new Error("ACP terminal is only available in Tauri environment")
    }

    try {
      const waitResult = await acpTerminalWaitForExit(terminalId, timeout)
      const exitCode = waitResult.exitCode ?? waitResult.exitStatus.exitCode ?? null
      set((state) => {
        const terminal = state.terminals[terminalId]
        if (terminal) {
          return {
            terminals: {
              ...state.terminals,
              [terminalId]: { ...terminal, isRunning: false, exitCode },
            },
          }
        }
        return state
      })
      return exitCode
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("waitForTerminalExit failed", { terminalId, err })
      set({ lastError: message })
      throw err
    }
  },

  getSessionTerminals: async (sessionId: string): Promise<string[]> => {
    if (!isTauri()) return []
    return acpTerminalGetSessionTerminals(sessionId)
  },

  killSessionTerminals: async (sessionId: string): Promise<void> => {
    if (!isTauri()) return

    try {
      await acpTerminalKillSessionTerminals(sessionId)

      set((state) => {
        const terminals: Record<string, TerminalInstance> = {}
        const terminalIds: string[] = []

        for (const [id, terminal] of Object.entries(state.terminals)) {
          if (terminal.sessionId !== sessionId) {
            terminals[id] = terminal
            terminalIds.push(id)
          }
        }

        return { terminals, terminalIds }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("killSessionTerminals failed", { sessionId, err })
      set({ lastError: message })
      throw err
    }
  },

  isTerminalRunning: async (terminalId: string): Promise<boolean> => {
    if (!isTauri()) return false

    const isRunning = await acpTerminalIsRunning(terminalId)

    set((state) => {
      const terminal = state.terminals[terminalId]
      if (terminal) {
        return {
          terminals: {
            ...state.terminals,
            [terminalId]: { ...terminal, isRunning },
          },
        }
      }
      return state
    })

    return isRunning
  },

  getTerminalInfo: async (terminalId: string): Promise<TerminalInfo> => {
    if (!isTauri()) {
      throw new Error("ACP terminal is only available in Tauri environment")
    }
    return acpTerminalGetInfo(terminalId)
  },

  refreshTerminals: async (): Promise<void> => {
    if (!isTauri()) return

    set({ isLoading: true })

    try {
      const terminalIds = await acpTerminalList()
      const terminals: Record<string, TerminalInstance> = {}

      for (const id of terminalIds) {
        try {
          const info = await acpTerminalGetInfo(id)
          const output = await acpTerminalOutput(id)
          const isRunning = await acpTerminalIsRunning(id)
          const existing = get().terminals[id]
          const exitCode = output.exitCode ?? output.exitStatus.exitCode ?? null

          terminals[id] = {
            id,
            sessionId: info.sessionId,
            command: info.command,
            isRunning,
            output: output.output,
            exitCode,
            createdAt: existing?.createdAt ?? Date.now(),
          }
        } catch (err) {
          // Terminal may have been released
          externalAgentStoreLogger.debug("Skipping released terminal during refresh", { id, err })
        }
      }

      set({ terminals, terminalIds, isLoading: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      externalAgentStoreLogger.error("refreshTerminals failed", { err })
      set({ lastError: message, isLoading: false })
    }
  },

  // ========================================
  // Error Handling
  // ========================================

  clearLastError: (): void => {
    set({ lastError: null })
  },
})
