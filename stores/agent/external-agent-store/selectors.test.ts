/**
 * @jest-environment jsdom
 */
import {
  selectAgents,
  selectConnectionStatus,
  selectAgentValidity,
  selectBenchmarkCapabilityMap,
  selectActiveAgentId,
  selectDelegationRules,
  selectEnabled,
  selectDefaultPermissionMode,
  selectConnectedAgents,
  selectEnabledAgents,
  selectAgentById,
  selectActiveAgent,
  selectAgentValidityById,
  selectBenchmarkCapabilitiesById,
  selectRunningAgents,
  selectActiveRunningAgents,
  selectTerminals,
  selectRunningTerminals,
  selectSessionTerminals,
  selectIsLoading,
  selectLastError,
} from "./selectors"
import type {
  ExternalAgentStore,
  StoredExternalAgentConfig,
  RunningAgentInstance,
  TerminalInstance,
} from "./types"
import { initialState } from "./initial-state"
import * as barrel from "./index"

const baseState = (overrides: Partial<ExternalAgentStore> = {}): ExternalAgentStore =>
  ({
    ...initialState,
    ...overrides,
  }) as unknown as ExternalAgentStore

const buildAgent = (
  id: string,
  overrides: Partial<StoredExternalAgentConfig> = {}
): StoredExternalAgentConfig =>
  ({
    id,
    name: id,
    description: "",
    protocol: "acp",
    transport: "stdio",
    enabled: true,
    process: { command: "x" },
    defaultPermissionMode: "default",
    tags: [],
    timeout: 30000,
    metadata: {},
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  }) as StoredExternalAgentConfig

describe("external-agent-store barrel", () => {
  it("re-exports selectors and the store hook", () => {
    expect(typeof barrel.useExternalAgentStore).toBe("function")
    expect(typeof barrel.selectAgents).toBe("function")
    expect(typeof barrel.selectConnectedAgents).toBe("function")
    expect(typeof barrel.selectActiveRunningAgents).toBe("function")
    expect(typeof barrel.selectSessionTerminals).toBe("function")
  })
})

describe("external-agent-store selectors with empty state", () => {
  const state = baseState()

  it("returns empty maps and default flags", () => {
    expect(selectAgents(state)).toEqual({})
    expect(selectConnectionStatus(state)).toEqual({})
    expect(selectAgentValidity(state)).toEqual({})
    expect(selectBenchmarkCapabilityMap(state)).toEqual({})
    expect(selectActiveAgentId(state)).toBeNull()
    expect(selectDelegationRules(state)).toEqual([])
    expect(selectEnabled(state)).toBe(true)
    expect(selectDefaultPermissionMode(state)).toBe("default")
    expect(selectConnectedAgents(state)).toEqual([])
    expect(selectEnabledAgents(state)).toEqual([])
    expect(selectAgentById("missing")(state)).toBeUndefined()
    expect(selectActiveAgent(state)).toBeUndefined()
    expect(selectAgentValidityById("missing")(state)).toBeUndefined()
    expect(selectBenchmarkCapabilitiesById("missing")(state)).toEqual([])
    expect(selectRunningAgents(state)).toEqual([])
    expect(selectActiveRunningAgents(state)).toEqual([])
    expect(selectTerminals(state)).toEqual([])
    expect(selectRunningTerminals(state)).toEqual([])
    expect(selectSessionTerminals("any")(state)).toEqual([])
    expect(selectIsLoading(state)).toBe(false)
    expect(selectLastError(state)).toBeNull()
  })
})

describe("external-agent-store selectors with populated state", () => {
  const a = buildAgent("a", { enabled: true })
  const b = buildAgent("b", { enabled: false })
  const r1: RunningAgentInstance = {
    id: "a",
    status: "running",
    output: [],
    spawnedAt: 0,
  }
  const r2: RunningAgentInstance = {
    id: "b",
    status: "stopped",
    output: [],
    spawnedAt: 0,
  }
  const t1: TerminalInstance = {
    id: "t1",
    sessionId: "s1",
    command: "ls",
    isRunning: true,
    output: "",
    exitCode: null,
    createdAt: 0,
  }
  const t2: TerminalInstance = {
    id: "t2",
    sessionId: "s2",
    command: "pwd",
    isRunning: false,
    output: "",
    exitCode: 0,
    createdAt: 0,
  }
  const state = baseState({
    agents: { a, b },
    connectionStatus: { a: "connected", b: "disconnected" },
    activeAgentId: "a",
    agentValidity: {
      a: {
        executable: true,
        checkedAt: new Date(),
        source: "config",
        healthStatus: "healthy",
        sessionExtensions: {},
        contractVersion: 1,
        lifecycleStage: "ready",
        executionEligibility: "eligible",
        capabilitySnapshot: {
          protocol: "acp",
          sessionExtensions: {},
          hasAgentCapabilities: false,
        },
      } as never,
    },
    benchmarkCapabilityMap: {
      a: [
        {
          id: "cap",
          title: "T",
          referenceBehavior: "",
          cogniaBehavior: "",
          adaptationTarget: "",
          gapGrade: "minor",
          status: "validated",
          owner: "x",
          evidence: [],
          updatedAt: new Date(),
        } as never,
      ],
    },
    runningAgents: { a: r1, b: r2 },
    runningAgentIds: ["a", "b"],
    terminals: { t1, t2 },
    terminalIds: ["t1", "t2"],
    isLoading: true,
    lastError: "boom",
  })

  it("returns connected / enabled views with hydrated Date fields", () => {
    const connected = selectConnectedAgents(state)
    expect(connected).toHaveLength(1)
    expect(connected[0].id).toBe("a")
    expect(connected[0].createdAt).toBeInstanceOf(Date)
    expect(connected[0].updatedAt).toBeInstanceOf(Date)

    const enabled = selectEnabledAgents(state)
    expect(enabled.map((x) => x.id)).toEqual(["a"])
  })

  it("findById and active selectors return hydrated configs or undefined", () => {
    expect(selectAgentById("a")(state)?.id).toBe("a")
    expect(selectAgentById("a")(state)?.createdAt).toBeInstanceOf(Date)
    expect(selectAgentById("missing")(state)).toBeUndefined()
    expect(selectActiveAgent(state)?.id).toBe("a")
  })

  it("selectActiveAgent returns undefined when active id is null", () => {
    expect(selectActiveAgent({ ...state, activeAgentId: null })).toBeUndefined()
  })

  it("validity / benchmark id selectors find entries", () => {
    expect(selectAgentValidityById("a")(state)).toBeDefined()
    expect(selectBenchmarkCapabilitiesById("a")(state)).toHaveLength(1)
    expect(selectBenchmarkCapabilitiesById("missing")(state)).toEqual([])
  })

  it("running agent selectors", () => {
    expect(selectRunningAgents(state).map((r) => r.id)).toEqual(["a", "b"])
    expect(selectActiveRunningAgents(state).map((r) => r.id)).toEqual(["a"])
  })

  it("terminal selectors", () => {
    expect(selectTerminals(state).map((t) => t.id)).toEqual(["t1", "t2"])
    expect(selectRunningTerminals(state).map((t) => t.id)).toEqual(["t1"])
    expect(selectSessionTerminals("s1")(state).map((t) => t.id)).toEqual(["t1"])
    expect(selectSessionTerminals("nope")(state)).toEqual([])
  })

  it("loading / lastError flags", () => {
    expect(selectIsLoading(state)).toBe(true)
    expect(selectLastError(state)).toBe("boom")
  })
})

describe("external-agent-store initial-state", () => {
  it("has the expected default shape", () => {
    expect(initialState.agents).toEqual({})
    expect(initialState.connectionStatus).toEqual({})
    expect(initialState.agentValidity).toEqual({})
    expect(initialState.benchmarkCapabilityMap).toEqual({})
    expect(initialState.lastRunSnapshots).toEqual({})
    expect(initialState.activeAgentId).toBeNull()
    expect(initialState.delegationRules).toEqual([])
    expect(initialState.enabled).toBe(true)
    expect(initialState.defaultPermissionMode).toBe("default")
    expect(initialState.autoConnectOnStartup).toBe(false)
    expect(initialState.showConnectionNotifications).toBe(true)
    expect(initialState.chatFailurePolicy).toBe("fallback")
    expect(initialState.runningAgents).toEqual({})
    expect(initialState.runningAgentIds).toEqual([])
    expect(initialState.terminals).toEqual({})
    expect(initialState.terminalIds).toEqual([])
    expect(initialState.isLoading).toBe(false)
    expect(initialState.lastError).toBeNull()
  })
})
