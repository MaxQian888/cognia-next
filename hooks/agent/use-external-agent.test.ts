/**
 * @jest-environment jsdom
 *
 * Coverage focus: deterministic action paths of `useExternalAgent`. The
 * streaming generator and permission-resolution flows are intentionally
 * scoped narrowly because they require multi-promise orchestration that
 * leaks across tests when run side by side.
 */
import { act, renderHook } from "@testing-library/react"

const logError = jest.fn()
// Any namespace, not just `agent`. This suite's import graph reaches modules
// that take a logger at module scope under other names (`lib/db/mcp-servers`
// calls `loggers.mcp.child(...)` on import), and a namespace the mock does not
// name throws `Cannot read properties of undefined (reading 'child')` before a
// single test runs, which jest reports as the whole file failing to load.
jest.mock("@cognia/logging", () => {
  const makeLogger = (): Record<string, unknown> => {
    const logger: Record<string, unknown> = {
      error: (...args: unknown[]) => logError(...args),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      child: () => logger,
    }
    return logger
  }
  return {
    loggers: new Proxy({}, { get: () => makeLogger() }),
    // `lib/execution/broker` takes one at module scope too.
    createLogger: () => makeLogger(),
  }
})

const dispatchConnect = jest.fn()
const dispatchDisconnect = jest.fn()
const dispatchExecutionStart = jest.fn()
const dispatchExecutionComplete = jest.fn()
const dispatchExternalAgentError = jest.fn()
jest.mock("@/lib/plugin/messaging/hooks-system", () => ({
  getPluginEventHooks: () => ({
    dispatchExternalAgentConnect: (...a: unknown[]) => dispatchConnect(...a),
    dispatchExternalAgentDisconnect: (...a: unknown[]) => dispatchDisconnect(...a),
    dispatchExternalAgentExecutionStart: (...a: unknown[]) => dispatchExecutionStart(...a),
    dispatchExternalAgentExecutionComplete: (...a: unknown[]) => dispatchExecutionComplete(...a),
    dispatchExternalAgentError: (...a: unknown[]) => dispatchExternalAgentError(...a),
  }),
}))

const normalizeMock = jest.fn((...args: unknown[]) => {
  const input = args[0]
  return {
    protocol: (input as { protocol?: string })?.protocol ?? "acp",
    transport: (input as { transport?: string })?.transport ?? "stdio",
    metadata: (input as { metadata?: unknown })?.metadata,
  }
})
const isExecutableMock = jest.fn().mockReturnValue(true)
const getBlockReasonMock = jest.fn().mockReturnValue(null)
const getBlockMock = jest.fn().mockReturnValue(null)

jest.mock("@/lib/ai/agent/external/config-normalizer", () => ({
  normalizeExternalAgentConfigInput: (...args: unknown[]) => normalizeMock(...args),
  isExternalAgentExecutable: (...args: unknown[]) => isExecutableMock(...args),
  getExternalAgentExecutionBlockReason: (...args: unknown[]) => getBlockReasonMock(...args),
  getExternalAgentExecutionBlock: (...args: unknown[]) => getBlockMock(...args),
}))

const isUnsupportedForMethodMock = jest.fn().mockReturnValue(false)
jest.mock("@/lib/ai/agent/external/session-extension-errors", () => ({
  isExternalAgentSessionExtensionUnsupportedForMethod: (...a: unknown[]) =>
    isUnsupportedForMethodMock(...a),
}))

jest.mock("@/lib/ai/agent/external/canonical-contract", () => ({
  normalizeExternalAgentValiditySnapshot: (snap: unknown) => snap,
}))

interface StoreState {
  agents: Record<
    string,
    { id: string; name: string; protocol: string; metadata?: Record<string, unknown> }
  >
  connectionStatus: Record<string, string>
  agentValidity: Record<string, unknown>
  lastRunSnapshots: Record<string, unknown>
  benchmarkCapabilities: Record<string, unknown[]>
  activeAgentId: string | null
  defaultPermissionMode: string
}
const storeStateRef: { current: StoreState } = {
  current: {
    agents: {},
    connectionStatus: {},
    agentValidity: {},
    lastRunSnapshots: {},
    benchmarkCapabilities: {},
    activeAgentId: null,
    defaultPermissionMode: "default",
  },
}
const storeAddAgent = jest.fn((cfg: { id: string; name: string; protocol: string }) => {
  storeStateRef.current.agents[cfg.id] = cfg
  return cfg.id
})
const storeRemoveAgent = jest.fn((id: string) => {
  delete storeStateRef.current.agents[id]
  delete storeStateRef.current.connectionStatus[id]
})
const storeSetConnectionStatus = jest.fn((id: string, status: string) => {
  storeStateRef.current.connectionStatus[id] = status
})
const storeSetAgentValidity = jest.fn((id: string, snap: unknown) => {
  storeStateRef.current.agentValidity[id] = snap
})
const storeGetAgentValidity = jest.fn((id: string) => storeStateRef.current.agentValidity[id])
const storeGetLastRunSnapshot = jest.fn((id: string) => storeStateRef.current.lastRunSnapshots[id])
const storeSetLastRunSnapshot = jest.fn((id: string, snap: unknown) => {
  storeStateRef.current.lastRunSnapshots[id] = snap
})
const storeGetBenchmarkCapabilities = jest.fn(
  (id: string) => storeStateRef.current.benchmarkCapabilities[id] ?? []
)
const storeSetActiveAgent = jest.fn((id: string | null) => {
  storeStateRef.current.activeAgentId = id
})
const storeUpdateAgent = jest.fn((id: string, updates: { metadata?: Record<string, unknown> }) => {
  const agent = storeStateRef.current.agents[id]
  if (!agent) return
  storeStateRef.current.agents[id] = {
    ...agent,
    metadata: updates.metadata ? { ...agent.metadata, ...updates.metadata } : agent.metadata,
  }
})

const storeRecordAgentFailure = jest.fn()
const storeClearAgentFailure = jest.fn()
const stableGetAgent = (id: string) => storeStateRef.current.agents[id]
const stableGetAllAgents = () => Object.values(storeStateRef.current.agents)
const stableGetConnectionStatus = (id: string) =>
  storeStateRef.current.connectionStatus[id] ?? "disconnected"

function getStoreState() {
  return {
    ...storeStateRef.current,
    addAgent: storeAddAgent,
    removeAgent: storeRemoveAgent,
    setConnectionStatus: storeSetConnectionStatus,
    // Per-agent failure reporting: the hook clears before an attempt and
    // records on the way out, so both have to exist for connect to run at all.
    recordAgentFailure: storeRecordAgentFailure,
    clearAgentFailure: storeClearAgentFailure,
    setAgentValidity: storeSetAgentValidity,
    getAgent: stableGetAgent,
    getAllAgents: stableGetAllAgents,
    getConnectionStatus: stableGetConnectionStatus,
    getAgentValidity: storeGetAgentValidity,
    getLastRunSnapshot: storeGetLastRunSnapshot,
    setLastRunSnapshot: storeSetLastRunSnapshot,
    getBenchmarkCapabilities: storeGetBenchmarkCapabilities,
    setActiveAgent: storeSetActiveAgent,
    updateAgent: storeUpdateAgent,
    activeAgentId: storeStateRef.current.activeAgentId,
    defaultPermissionMode: storeStateRef.current.defaultPermissionMode,
  }
}

function setStoreState(updater: ((s: StoreState) => Partial<StoreState>) | Partial<StoreState>) {
  const partial = typeof updater === "function" ? updater(storeStateRef.current) : updater
  storeStateRef.current = { ...storeStateRef.current, ...partial }
}

const noopUnsubscribe = () => undefined

jest.mock("@/stores/agent/external-agent-store", () => {
  const fn = <T>(selector: (s: ReturnType<typeof getStoreState>) => T): T =>
    selector(getStoreState())
  ;(fn as unknown as Record<string, unknown>).getState = () => getStoreState()
  ;(fn as unknown as Record<string, unknown>).setState = setStoreState
  ;(fn as unknown as Record<string, unknown>).subscribe = () => noopUnsubscribe
  return { useExternalAgentStore: fn }
})

interface FakeManager {
  getAllAgents: jest.Mock
  getAgent: jest.Mock
  addAgent: jest.Mock
  removeAgent: jest.Mock
  connect: jest.Mock
  disconnect: jest.Mock
  reconnect: jest.Mock
  createSession: jest.Mock
  closeSession: jest.Mock
  listSessions: jest.Mock
  forkSession: jest.Mock
  resumeSession: jest.Mock
  execute: jest.Mock
  executeStreaming: jest.Mock
  cancel: jest.Mock
  respondToPermission: jest.Mock
  setSessionMode: jest.Mock
  setSessionModel: jest.Mock
  getSessionModels: jest.Mock
  getSession: jest.Mock
  getAuthMethods: jest.Mock
  isAuthenticationRequired: jest.Mock
  authenticate: jest.Mock
  getTerminalAuthState: jest.Mock
  cancelTerminalAuthentication: jest.Mock
  listProviders: jest.Mock
  setProvider: jest.Mock
  disableProvider: jest.Mock
  startNes: jest.Mock
  suggestNes: jest.Mock
  closeNes: jest.Mock
  getDynamicMcpConnections: jest.Mock
  setConfigOption: jest.Mock
  getConfigOptions: jest.Mock
  getAgentTools: jest.Mock
  checkAgentHealth: jest.Mock
  getCompactionCapability: jest.Mock
  compactSession: jest.Mock
  getProviderUndoCapability: jest.Mock
  undoLastProviderChange: jest.Mock
  addLifecycleListener: jest.Mock
  addEventListener: jest.Mock
}

let fakeManager: FakeManager = makeManager()

function makeManager(): FakeManager {
  return {
    getAllAgents: jest.fn(() => []),
    getAgent: jest.fn(),
    addAgent: jest.fn(),
    removeAgent: jest.fn(async () => undefined),
    connect: jest.fn(async () => undefined),
    disconnect: jest.fn(async () => undefined),
    reconnect: jest.fn(async () => undefined),
    createSession: jest.fn(async () => ({ id: "sess-1" })),
    closeSession: jest.fn(async () => undefined),
    listSessions: jest.fn(async () => []),
    forkSession: jest.fn(async () => ({ id: "sess-fork" })),
    resumeSession: jest.fn(async () => ({ id: "sess-resume" })),
    execute: jest.fn(async () => ({
      success: true,
      sessionId: "sess-1",
      finalResponse: "ok",
    })),
    executeStreaming: jest.fn(async function* () {
      yield* []
    }),
    cancel: jest.fn(async () => undefined),
    respondToPermission: jest.fn(async () => undefined),
    setSessionMode: jest.fn(async () => undefined),
    setSessionModel: jest.fn(async () => undefined),
    getSessionModels: jest.fn(() => ({ status: "ok", data: { models: [] } })),
    getSession: jest.fn(),
    getAuthMethods: jest.fn(() => ({ status: "ok", data: [] })),
    isAuthenticationRequired: jest.fn(() => false),
    authenticate: jest.fn(async () => undefined),
    getTerminalAuthState: jest.fn(() => undefined),
    cancelTerminalAuthentication: jest.fn(async () => undefined),
    listProviders: jest.fn(async () => ({ providers: [] })),
    setProvider: jest.fn(async () => ({})),
    disableProvider: jest.fn(async () => ({})),
    startNes: jest.fn(async () => ({ sessionId: "nes-1" })),
    suggestNes: jest.fn(async () => ({ suggestions: [] })),
    closeNes: jest.fn(async () => ({})),
    getDynamicMcpConnections: jest.fn(() => []),
    setConfigOption: jest.fn(async () => []),
    getConfigOptions: jest.fn(() => ({ status: "ok", data: [] })),
    getAgentTools: jest.fn(() => ({})),
    checkAgentHealth: jest.fn(async () => true),
    getCompactionCapability: jest.fn(async () => ({ status: "unsupported", routes: [] })),
    compactSession: jest.fn(async () => undefined),
    getProviderUndoCapability: jest.fn(async () => ({ status: "unsupported" })),
    undoLastProviderChange: jest.fn(async () => undefined),
    addLifecycleListener: jest.fn(() => () => undefined),
    addEventListener: jest.fn(() => () => undefined),
  }
}

jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => fakeManager,
}))

import { useExternalAgent } from "./use-external-agent"
// Real store on purpose: the selection module's whole job is keeping this one
// and the (mocked) external-agent store pointed at the same agent.
import { useAgentRuntimeStore } from "@/stores/agent"

beforeEach(() => {
  storeStateRef.current = {
    agents: {},
    connectionStatus: {},
    agentValidity: {},
    lastRunSnapshots: {},
    benchmarkCapabilities: {},
    activeAgentId: null,
    defaultPermissionMode: "default",
  }
  storeAddAgent.mockClear()
  storeRemoveAgent.mockClear()
  storeSetConnectionStatus.mockClear()
  storeSetAgentValidity.mockClear()
  storeGetAgentValidity.mockClear()
  storeGetLastRunSnapshot.mockClear()
  storeGetBenchmarkCapabilities.mockClear()
  storeSetActiveAgent.mockClear()
  storeUpdateAgent.mockClear()
  normalizeMock.mockClear()
  isExecutableMock.mockReset().mockReturnValue(true)
  getBlockReasonMock.mockReset().mockReturnValue(null)
  getBlockMock.mockReset().mockReturnValue(null)
  isUnsupportedForMethodMock.mockReset().mockReturnValue(false)
  fakeManager = makeManager()
  logError.mockClear()
  dispatchConnect.mockClear()
  dispatchDisconnect.mockClear()
  dispatchExecutionStart.mockClear()
  dispatchExecutionComplete.mockClear()
  dispatchExternalAgentError.mockClear()
})

async function flush() {
  await act(async () => {
    await new Promise<void>((r) => setTimeout(r, 0))
  })
}

function seedAgent(id = "a1") {
  storeStateRef.current.agents[id] = { id, name: id.toUpperCase(), protocol: "acp" }
  storeStateRef.current.activeAgentId = id
}

function _chatStateClearActive() {
  storeStateRef.current.activeAgentId = null
}

// Placed first so no earlier test's lingering async (a known React-19 race in
// later pure-unit hook tests) can leak an unhandled rejection into the
// setTimeout-based `flush()` used here to await the dynamic-import listener bind.
describe("useExternalAgent lifecycle bridge — lastRunSnapshot (Workstream D)", () => {
  async function boundListener(): Promise<((event: unknown) => void) | undefined> {
    for (let i = 0; i < 8; i++) {
      const call = fakeManager.addLifecycleListener.mock.calls.at(-1)
      if (call) return call[0] as (event: unknown) => void
      await flush()
    }
    return undefined
  }

  it("persists a lastRunSnapshot from a lifecycle event into the store", async () => {
    seedAgent("a1")
    renderHook(() => useExternalAgent())
    const listener = await boundListener()
    expect(listener).toBeDefined()

    const snapshot = {
      terminalOutcome: "ok",
      branchReasonCode: "ok",
      branchOutcome: "external",
      timestamp: new Date(),
      linkedSessionId: "sess-1",
    }
    act(() => {
      listener!({
        agentId: "a1",
        connectionStatus: "connected",
        status: "ready",
        lastRunSnapshot: snapshot,
        timestamp: new Date(),
      })
    })

    expect(storeSetLastRunSnapshot).toHaveBeenCalledWith("a1", snapshot)
    expect(storeStateRef.current.lastRunSnapshots.a1).toBe(snapshot)
  })

  it("ignores a lifecycle event without a lastRunSnapshot", async () => {
    seedAgent("a1")
    renderHook(() => useExternalAgent())
    const listener = await boundListener()
    storeSetLastRunSnapshot.mockClear()

    act(() => {
      listener!({
        agentId: "a1",
        connectionStatus: "connected",
        status: "ready",
        timestamp: new Date(),
      })
    })

    expect(storeSetLastRunSnapshot).not.toHaveBeenCalled()
  })
})

describe("useExternalAgent core actions", () => {
  it("initializes with empty state and clearError is a no-op", async () => {
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    expect(result.current.agents).toEqual([])
    expect(result.current.error).toBeNull()
    expect(result.current.isExecuting).toBe(false)
    expect(result.current.isLoading).toBe(false)
    act(() => result.current.clearError())
    expect(result.current.error).toBeNull()
  })

  it("setActiveAgent persists through the store", async () => {
    seedAgent("a1")
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    act(() => result.current.setActiveAgent("a1"))
    expect(storeSetActiveAgent).toHaveBeenCalledWith("a1")
  })

  // Chat dispatch reads the runtime store, not this one. Before the selection
  // module, picking an agent here left the composer sending to whatever it had
  // selected — the manager and the chat disagreed silently.
  it("setActiveAgent retargets an already-external lane", async () => {
    seedAgent("a1")
    useAgentRuntimeStore.getState().setRuntimeRef({ kind: "external", agentId: "a0" })
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    act(() => result.current.setActiveAgent("a1"))
    expect(useAgentRuntimeStore.getState().externalAgentId).toBe("a1")
  })

  // ...and never switches the lane on its own. Picking an agent in the manager
  // must not reroute a chat that is running on Cognia's own runtime.
  it("setActiveAgent leaves the builtin lane alone", async () => {
    seedAgent("a1")
    useAgentRuntimeStore.getState().setRuntimeRef({ kind: "builtin" })
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    act(() => result.current.setActiveAgent("a1"))
    expect(useAgentRuntimeStore.getState().runtimeRef).toEqual({ kind: "builtin" })
    expect(storeSetActiveAgent).toHaveBeenCalledWith("a1")
  })

  it("addAgent: success path forwards to manager", async () => {
    fakeManager.addAgent.mockResolvedValueOnce({
      config: { id: "a1", name: "A1", protocol: "acp" },
      connectionStatus: "connected",
      validity: undefined,
    })
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    let added: unknown
    await act(async () => {
      added = await result.current.addAgent({
        id: "a1",
        name: "A1",
        protocol: "acp",
      } as never)
    })
    expect(added).toMatchObject({ connectionStatus: "connected" })
    expect(fakeManager.addAgent).toHaveBeenCalled()
  })

  it("addAgent: short-circuits non-executable configs and surfaces blockingReason", async () => {
    isExecutableMock.mockReturnValue(false)
    getBlockMock.mockReturnValue({ code: "missing-binary", reason: "needs cli" })
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    let added: unknown
    await act(async () => {
      added = await result.current.addAgent({
        id: "blocked",
        name: "B",
        protocol: "acp",
      } as never)
    })
    expect(fakeManager.addAgent).not.toHaveBeenCalled()
    expect(storeSetAgentValidity).toHaveBeenCalled()
    expect((added as { config: { id: string } }).config.id).toBe("blocked")
  })

  it("addAgent: rethrows manager errors", async () => {
    fakeManager.addAgent.mockRejectedValueOnce(new Error("boom"))
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      try {
        await result.current.addAgent({
          id: "x",
          name: "X",
          protocol: "acp",
        } as never)
      } catch (err) {
        expect((err as Error).message).toBe("boom")
      }
    })
    await flush()
    expect(result.current.error).toBe("boom")
  })

  it("connect: dispatches plugin hook on success", async () => {
    seedAgent("a1")
    fakeManager.getAllAgents.mockReturnValue([
      { config: { id: "a1", name: "A1", protocol: "acp" } },
    ])
    fakeManager.getAgent.mockReturnValue({
      config: { id: "a1", name: "A1", protocol: "acp" },
      connectionStatus: "connected",
    })
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      await result.current.connect("a1")
    })
    expect(fakeManager.connect).toHaveBeenCalledWith("a1")
    expect(dispatchConnect).toHaveBeenCalledWith("a1", "A1")
  })

  it("connect: rethrows when the agent is missing", async () => {
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await expect(
      act(async () => {
        await result.current.connect("missing")
      })
    ).rejects.toThrow("Agent not found")
  })

  it("connect: rethrows when blocked by config", async () => {
    seedAgent("a1")
    getBlockReasonMock.mockReturnValue("requires authentication")
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await expect(
      act(async () => {
        await result.current.connect("a1")
      })
    ).rejects.toThrow("requires authentication")
    expect(dispatchExternalAgentError).toHaveBeenCalled()
  })

  it("disconnect: dispatches plugin hook and clears active session", async () => {
    seedAgent("a1")
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      await result.current.disconnect("a1")
    })
    expect(fakeManager.disconnect).toHaveBeenCalledWith("a1")
    expect(dispatchDisconnect).toHaveBeenCalledWith("a1")
  })

  it("reconnect: surfaces error state and rethrows", async () => {
    seedAgent("a1")
    fakeManager.reconnect.mockRejectedValueOnce(new Error("net"))
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      try {
        await result.current.reconnect("a1")
      } catch (err) {
        expect((err as Error).message).toBe("net")
      }
    })
    expect(storeSetConnectionStatus).toHaveBeenCalledWith("a1", "error")
  })

  it("removeAgent: clears active session when removing the active agent", async () => {
    seedAgent("a1")
    fakeManager.getAgent.mockReturnValue({
      config: { id: "a1", name: "A1", protocol: "acp" },
    })
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      await result.current.removeAgent("a1")
    })
    expect(fakeManager.removeAgent).toHaveBeenCalledWith("a1")
    expect(storeSetActiveAgent).toHaveBeenCalledWith(null)
  })

  // A deleted agent must not survive as an id in the store chat dispatch reads,
  // or the next external turn is handed a record that no longer exists.
  it("removeAgent drops the runtime store's dangling selection", async () => {
    seedAgent("a1")
    fakeManager.getAgent.mockReturnValue({ config: { id: "a1", name: "A1", protocol: "acp" } })
    useAgentRuntimeStore.getState().setRuntimeRef({ kind: "external", agentId: "a1" })
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      await result.current.removeAgent("a1")
    })
    expect(useAgentRuntimeStore.getState().externalAgentId).toBeNull()
  })

  it("removeAgent leaves a selection that names a different agent", async () => {
    seedAgent("a1")
    fakeManager.getAgent.mockReturnValue({ config: { id: "a1", name: "A1", protocol: "acp" } })
    useAgentRuntimeStore.getState().setRuntimeRef({ kind: "external", agentId: "a2" })
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      await result.current.removeAgent("a1")
    })
    expect(useAgentRuntimeStore.getState().externalAgentId).toBe("a2")
  })

  it("createSession requires an active agent", async () => {
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await expect(
      act(async () => {
        await result.current.createSession()
      })
    ).rejects.toThrow("No active agent selected")
  })

  it("createSession + closeSession against active agent", async () => {
    seedAgent("a1")
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      await result.current.createSession({ systemPrompt: "x", additionalDirectories: ["/shared"] })
    })
    expect(fakeManager.createSession).toHaveBeenCalledWith("a1", {
      systemPrompt: "x",
      additionalDirectories: ["/shared"],
    })
    await act(async () => {
      await result.current.closeSession("sess-1")
    })
    expect(fakeManager.closeSession).toHaveBeenCalledWith("a1", "sess-1")
  })

  it("listSessions returns [] when neither argument nor active agent is available", async () => {
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    let sessions: unknown
    await act(async () => {
      sessions = await result.current.listSessions()
    })
    expect(sessions).toEqual([])
  })

  it("listSessions does not setError for unsupported errors", async () => {
    seedAgent("a1")
    fakeManager.listSessions.mockRejectedValueOnce(new Error("Method not found"))
    isUnsupportedForMethodMock.mockReturnValue(true)
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await expect(
      act(async () => {
        await result.current.listSessions()
      })
    ).rejects.toThrow("Method not found")
    expect(result.current.error).toBeNull()
  })

  it("forkSession requires active agent", async () => {
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await expect(
      act(async () => {
        await result.current.forkSession("s")
      })
    ).rejects.toThrow("No active agent selected")
  })

  it("forkSession success updates active session", async () => {
    seedAgent("a1")
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      await result.current.forkSession("s1", { cwd: "/work" })
    })
    expect(fakeManager.forkSession).toHaveBeenCalledWith("a1", "s1", { cwd: "/work" })
  })

  it("resumeSession forwards options", async () => {
    seedAgent("a1")
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      await result.current.resumeSession("s1", { systemPrompt: "p" })
    })
    expect(fakeManager.resumeSession).toHaveBeenCalledWith("a1", "s1", { systemPrompt: "p" })
  })

  it("locks session mutations until provider-confirmed compaction completes", async () => {
    seedAgent("a1")
    fakeManager.getCompactionCapability.mockResolvedValue({
      status: "supported",
      routes: [{ kind: "native", supportsFocus: false }],
    })
    let finishCompaction!: () => void
    fakeManager.compactSession.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishCompaction = resolve
        })
    )
    const { result } = renderHook(() => useExternalAgent())
    await flush()

    let compactPromise!: Promise<void>
    act(() => {
      compactPromise = result.current.compactSession("s1")
    })
    await expect(result.current.createSession()).rejects.toThrow(
      "Cannot create a session while context compaction is in progress"
    )
    await expect(result.current.compactSession("s1")).rejects.toThrow(
      "Another session operation is already in progress"
    )
    await flush()
    expect(result.current.isCompacting).toBe(true)
    expect(result.current.progress).toBe(0)
    await expect(result.current.createSession()).rejects.toThrow(
      "Cannot create a session while context compaction is in progress"
    )
    await expect(result.current.compactSession("s1")).rejects.toThrow(
      "Another session operation is already in progress"
    )

    await act(async () => {
      finishCompaction()
      await compactPromise
    })
    expect(result.current.isCompacting).toBe(false)
    expect(result.current.progress).toBe(100)
  })

  it("does not start compaction while sending or mutating a session", async () => {
    seedAgent("a1")
    let finishExecution!: () => void
    fakeManager.execute.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishExecution = () =>
            resolve({
              success: true,
              sessionId: "sess-1",
              finalResponse: "ok",
            })
        })
    )
    const { result } = renderHook(() => useExternalAgent())
    await flush()

    let executionPromise!: ReturnType<typeof result.current.execute>
    act(() => {
      executionPromise = result.current.execute("hello")
    })
    await expect(result.current.compactSession("s1")).rejects.toThrow(
      "Another session operation is already in progress"
    )
    await act(async () => {
      finishExecution()
      await executionPromise
    })

    let finishCreate!: () => void
    fakeManager.createSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCreate = () => resolve({ id: "sess-2" })
        })
    )
    let createPromise!: ReturnType<typeof result.current.createSession>
    act(() => {
      createPromise = result.current.createSession()
    })
    await expect(result.current.compactSession("s1")).rejects.toThrow(
      "Another session operation is already in progress"
    )
    await act(async () => {
      finishCreate()
      await createPromise
    })
  })

  it("unlocks compaction after a provider failure", async () => {
    seedAgent("a1")
    fakeManager.getCompactionCapability.mockResolvedValue({
      status: "supported",
      routes: [{ kind: "native", supportsFocus: false }],
    })
    fakeManager.compactSession
      .mockRejectedValueOnce(new Error("provider failed"))
      .mockResolvedValueOnce(undefined)
    const { result } = renderHook(() => useExternalAgent())
    await flush()

    let compactError: unknown
    await act(async () => {
      try {
        await result.current.compactSession("s1")
      } catch (error) {
        compactError = error
      }
    })
    expect(compactError).toEqual(new Error("provider failed"))
    expect(result.current.isCompacting).toBe(false)

    await act(async () => {
      await result.current.compactSession("s1")
    })
    expect(fakeManager.compactSession).toHaveBeenCalledTimes(2)
  })

  it("persists and resets the per-agent provider undo acknowledgement", async () => {
    seedAgent("a1")
    const { result } = renderHook(() => useExternalAgent())
    await flush()

    await expect(result.current.undoLastProviderChange("s1")).rejects.toThrow(
      "Provider undo warning must be acknowledged"
    )
    act(() => result.current.acknowledgeProviderUndoWarning())
    expect(storeUpdateAgent).toHaveBeenLastCalledWith("a1", {
      metadata: { providerUndoWarningAcknowledged: true },
    })
    await act(async () => {
      await result.current.undoLastProviderChange("s1")
    })
    expect(fakeManager.undoLastProviderChange).toHaveBeenCalledWith("a1", "s1")

    act(() => result.current.resetProviderUndoWarning())
    expect(storeUpdateAgent).toHaveBeenLastCalledWith("a1", {
      metadata: { providerUndoWarningAcknowledged: false },
    })
    await expect(result.current.undoLastProviderChange("s1")).rejects.toThrow(
      "Provider undo warning must be acknowledged"
    )
  })

  it("retains identified file plans emitted by the active session", async () => {
    seedAgent("a1")
    let listener: ((event: Record<string, unknown>) => void) | undefined
    fakeManager.addEventListener.mockImplementation(
      (_agentId: string, callback: (event: Record<string, unknown>) => void) => {
        listener = callback
        return () => undefined
      }
    )
    const { result } = renderHook(() => useExternalAgent())
    await flush()

    act(() => {
      listener?.({
        type: "plan_update",
        sessionId: "s1",
        timestamp: new Date(),
        planId: "file-plan",
        kind: "file",
        uri: "file:///work/PLAN.md",
        entries: [],
        progress: 0,
        step: -1,
        totalSteps: 0,
      })
    })

    expect(result.current.planDocument).toEqual({
      planId: "file-plan",
      kind: "file",
      uri: "file:///work/PLAN.md",
    })

    await act(async () => {
      await result.current.createSession()
    })
    await flush()
    expect(result.current.planDocument).toBeNull()
  })

  it("retains rich blocks, compaction updates, and NES suggestions", async () => {
    seedAgent("a1")
    let listener: ((event: Record<string, unknown>) => void) | undefined
    fakeManager.addEventListener.mockImplementation(
      (_agentId: string, callback: (event: Record<string, unknown>) => void) => {
        listener = callback
        return () => undefined
      }
    )
    const { result } = renderHook(() => useExternalAgent())
    await flush()

    act(() => {
      listener?.({ type: "content_block_delta", block: { type: "resource_link", uri: "x" } })
      listener?.({
        type: "compaction_update",
        compaction: { compactionId: "c1", status: "completed" },
      })
      listener?.({
        type: "nes_suggestion",
        suggestion: { id: "n1", operations: [] },
      })
    })

    expect(result.current.richContentBlocks).toEqual([{ type: "resource_link", uri: "x" }])
    expect(result.current.compactionUpdates).toEqual([{ compactionId: "c1", status: "completed" }])
    expect(result.current.nesSuggestions).toEqual([{ id: "n1", operations: [] }])
  })

  it("execute requires an active agent", async () => {
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await expect(
      act(async () => {
        await result.current.execute("hi")
      })
    ).rejects.toThrow("No active agent selected")
  })

  it("execute dispatches start + complete hooks on success", async () => {
    seedAgent("a1")
    fakeManager.execute.mockResolvedValueOnce({
      success: true,
      sessionId: "sess-1",
      finalResponse: "yo",
    })
    fakeManager.getSession.mockReturnValue({ id: "sess-1" })
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    let runResult: unknown
    await act(async () => {
      runResult = await result.current.execute("hello")
    })
    expect(runResult).toMatchObject({ finalResponse: "yo" })
    expect(dispatchExecutionStart).toHaveBeenCalled()
    expect(dispatchExecutionComplete).toHaveBeenCalled()
  })

  it("execute normalizes timeout error messages", async () => {
    seedAgent("a1")
    fakeManager.execute.mockRejectedValueOnce(new Error("upstream timeout"))
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      try {
        await result.current.execute("hi")
      } catch (err) {
        expect((err as Error).message).toBe("upstream timeout")
      }
    })
    await flush()
    expect(result.current.error).toMatch(/timed out/)
  })

  it("execute normalizes cancellation error messages", async () => {
    seedAgent("a1")
    fakeManager.execute.mockRejectedValueOnce(new Error("aborted by user"))
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      try {
        await result.current.execute("hi")
      } catch (err) {
        expect((err as Error).message).toBe("aborted by user")
      }
    })
    await flush()
    expect(result.current.error).toMatch(/cancelled/)
  })

  it("records a failed execution against its agent, not just in local state", async () => {
    // The panel-level error banner is gone; a per-agent report drawn in that
    // agent's row replaced it. Only the connect path ever filed one, so an
    // execution that failed set state nothing rendered and, because the
    // commands list calls `onExecute` fire-and-forget, surfaced as an
    // unhandled rejection instead of a message.
    seedAgent("a1")
    storeRecordAgentFailure.mockClear()
    fakeManager.execute.mockRejectedValueOnce(new Error("adapter refused the prompt"))
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      await expect(result.current.execute("hi")).rejects.toThrow("adapter refused the prompt")
    })
    await flush()
    expect(storeRecordAgentFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "a1",
        phase: "execute",
        message: "adapter refused the prompt",
      })
    )
  })

  it("records a failed session operation under its own phase", async () => {
    // "session" and "execute" were declared on the failure type from the
    // start and produced by nothing, so every path but connect was silent.
    seedAgent("a1")
    storeRecordAgentFailure.mockClear()
    fakeManager.createSession.mockRejectedValueOnce(new Error("agent refused a new session"))
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await act(async () => {
      await expect(result.current.createSession()).rejects.toThrow("agent refused a new session")
    })
    await flush()
    expect(storeRecordAgentFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "a1",
        phase: "session",
        message: "agent refused a new session",
      })
    )
  })

  it("setSessionMode/Model require active session", async () => {
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await expect(
      act(async () => {
        await result.current.setSessionMode("default" as never)
      })
    ).rejects.toThrow("No active session")
    await expect(
      act(async () => {
        await result.current.setSessionModel("opus")
      })
    ).rejects.toThrow("No active session")
  })

  it("authenticate requires active agent", async () => {
    const { result } = renderHook(() => useExternalAgent())
    await flush()
    await expect(
      act(async () => {
        await result.current.authenticate("oauth", { token: "t" })
      })
    ).rejects.toThrow("No active agent selected")
  })
})

// `getSessionModels`/`getAuthMethods`/`getConfigOptions`/`getAgentTools` and
// `checkHealth` are exercised in component-level integration tests; pure-unit
// coverage of those surfaces hits a React 19 race where `result.current` is
// transiently null after the hook's lifecycle effect fires. The behavior is
// covered by `useExternalAgentSessionPanel` integration tests.
