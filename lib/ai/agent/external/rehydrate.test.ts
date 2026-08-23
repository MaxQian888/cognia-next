/**
 * @jest-environment node
 *
 * Host-agnostic external-agent rehydration (ADR-0059 T-A10). The desktop React
 * binding is covered by `external-agent-initializer.test.tsx`; this suite drives
 * the extracted logic directly, including the headless orchestration
 * (`startExternalAgentRehydration`) and its lazy-manager guard.
 */

import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import type { ExternalAgentManager } from "@/lib/ai/agent/external/manager"
import type { ProtocolAdapterRegistryChange } from "@/lib/ai/agent/external/protocol-adapter"

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

interface FakeInstance {
  config: ExternalAgentConfig
  connectionStatus: string
  validity?: { executable: boolean; blockingReason?: string }
}

const agentsInManager = new Map<string, FakeInstance>()
const addAgentMock = jest.fn(
  async (config: ExternalAgentConfig, options: { connect?: boolean } = {}) => {
    const inst: FakeInstance = {
      config,
      connectionStatus: "disconnected",
      validity: { executable: true },
    }
    agentsInManager.set(config.id, inst)
    if (config.enabled && options.connect !== false) {
      await connectMock(config.id)
    }
    return inst
  }
)
const connectMock = jest.fn(async (id: string) => {
  const inst = agentsInManager.get(id)
  if (inst) inst.connectionStatus = "connected"
})
const getAgentMock = jest.fn((id: string) => agentsInManager.get(id))
// Only the three methods `rehydrate` actually calls are stubbed; the rest of the
// manager surface is irrelevant here.
const fakeManager = {
  addAgent: addAgentMock,
  connect: connectMock,
  getAgent: getAgentMock,
} as unknown as ExternalAgentManager
// Spied getter so a test can assert the manager (and its health-check interval)
// is NOT instantiated when there is nothing to rehydrate.
const getManagerMock = jest.fn(() => fakeManager)
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => getManagerMock(),
}))

const getBlockReasonMock = jest.fn<string | null, [ExternalAgentConfig]>(() => null)
const isExecutableMock = jest.fn(() => true)
const isSupportedMock = jest.fn((p: string) => p === "acp" || p === "opencode")
jest.mock("@/lib/ai/agent/external/config-normalizer", () => ({
  getExternalAgentExecutionBlockReason: (c: ExternalAgentConfig) => getBlockReasonMock(c),
  isExternalAgentExecutable: () => isExecutableMock(),
  isSupportedExternalAgentProtocol: (p: string) => isSupportedMock(p),
}))

const hasMock = jest.fn<boolean, [string]>(() => false)
let registryListener: ((c: ProtocolAdapterRegistryChange) => void) | null = null
const unsubscribeMock = jest.fn()
jest.mock("@/lib/ai/agent/external/protocol-adapter", () => ({
  protocolAdapterRegistry: { has: (p: string) => hasMock(p) },
  onProtocolAdapterRegistryChange: (l: (c: ProtocolAdapterRegistryChange) => void) => {
    registryListener = l
    return unsubscribeMock
  },
}))

const setConnectionStatusMock = jest.fn()
const setStateMock = jest.fn()
let storeState: {
  autoConnectOnStartup: boolean
  getAllAgents: () => ExternalAgentConfig[]
  setConnectionStatus: (id: string, status: string) => void
}
jest.mock("@/stores/agent/external-agent-store", () => ({
  useExternalAgentStore: Object.assign(() => storeState, {
    getState: () => storeState,
    setState: (...args: unknown[]) => setStateMock(...args),
  }),
}))

const migrateLegacyCredentialsMock = jest.fn(async () => ({ migrated: [], failed: [] }))
const reviewAllMock = jest.fn(async () => new Map())
const getLifecycleServiceMock = jest.fn(async () => ({
  migrateLegacyCredentials: migrateLegacyCredentialsMock,
  reviewAll: reviewAllMock,
}))
jest.mock("./lifecycle/service", () => ({
  getExternalAgentLifecycleService: () => getLifecycleServiceMock(),
}))

import {
  isRehydratableProtocol,
  prepareExternalAgentsForRehydration,
  rehydrateExternalAgent,
  startExternalAgentRehydration,
} from "./rehydrate"

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function makeAgent(overrides: Partial<ExternalAgentConfig> = {}): ExternalAgentConfig {
  return {
    id: "a1",
    name: "Agent",
    protocol: "acp",
    transport: "http",
    enabled: true,
    defaultPermissionMode: "default",
    timeout: 1000,
    metadata: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ExternalAgentConfig
}

/** Let the fire-and-forget async startup settle. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

beforeEach(() => {
  jest.clearAllMocks()
  agentsInManager.clear()
  registryListener = null
  hasMock.mockReturnValue(false)
  isSupportedMock.mockImplementation((p: string) => p === "acp" || p === "opencode")
  isExecutableMock.mockReturnValue(true)
  getBlockReasonMock.mockReturnValue(null)
  storeState = {
    autoConnectOnStartup: true,
    getAllAgents: () => [],
    setConnectionStatus: setConnectionStatusMock,
  }
  migrateLegacyCredentialsMock.mockResolvedValue({ migrated: [], failed: [] })
  reviewAllMock.mockResolvedValue(new Map())
  getLifecycleServiceMock.mockResolvedValue({
    migrateLegacyCredentials: migrateLegacyCredentialsMock,
    reviewAll: reviewAllMock,
  })
})

// --------------------------------------------------------------------------
// startExternalAgentRehydration — headless orchestration
// --------------------------------------------------------------------------

describe("startExternalAgentRehydration", () => {
  it("rehydrates and auto-connects every persisted executable agent", async () => {
    storeState.getAllAgents = () => [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })]

    const dispose = startExternalAgentRehydration()
    await flush()

    expect(addAgentMock).toHaveBeenCalledTimes(2)
    expect(connectMock).toHaveBeenCalledTimes(2)
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "connected")
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a2", "connected")
    dispose()
  })

  it("does NOT instantiate the manager when there are no persisted agents", async () => {
    storeState.getAllAgents = () => []

    const dispose = startExternalAgentRehydration()
    await flush()

    // Care-point: an empty brain must not spin up the manager's 30s health-check
    // interval (would strand a timer in the headless Node process).
    expect(getManagerMock).not.toHaveBeenCalled()
    dispose()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it("rehydrates persisted agents when a plugin registers its adapter mid-session", async () => {
    storeState.autoConnectOnStartup = false
    storeState.getAllAgents = () => [makeAgent({ id: "p1", protocol: "plug:demo" as never })]

    const dispose = startExternalAgentRehydration()
    await flush()
    expect(addAgentMock).not.toHaveBeenCalled()
    expect(registryListener).toBeInstanceOf(Function)

    hasMock.mockReturnValue(true)
    registryListener?.({ kind: "register", protocols: ["plug:demo"], pluginId: "plug" })
    await flush()

    expect(addAgentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ id: "p1", protocol: "plug:demo" })
    )
    dispose()
  })

  it("ignores unregister changes and protocols with no persisted agent", async () => {
    storeState.getAllAgents = () => [makeAgent({ id: "p1", protocol: "plug:demo" as never })]

    const dispose = startExternalAgentRehydration()
    await flush()
    addAgentMock.mockClear()

    registryListener?.({ kind: "unregister", protocols: ["plug:demo"], pluginId: "plug" })
    registryListener?.({ kind: "register", protocols: ["other:thing"], pluginId: "other" })
    await flush()

    expect(addAgentMock).not.toHaveBeenCalled()
    dispose()
  })

  it("stops reacting to registry changes after dispose", async () => {
    storeState.getAllAgents = () => [makeAgent({ id: "p1", protocol: "plug:demo" as never })]
    hasMock.mockReturnValue(true)

    const dispose = startExternalAgentRehydration()
    await flush()
    addAgentMock.mockClear()

    dispose()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)

    registryListener?.({ kind: "register", protocols: ["plug:demo"], pluginId: "plug" })
    await flush()
    expect(addAgentMock).not.toHaveBeenCalled()
  })
})

// --------------------------------------------------------------------------
// rehydrateExternalAgent — per-agent branches
// --------------------------------------------------------------------------

describe("rehydrateExternalAgent", () => {
  const alive = () => true

  it("registers without connecting when auto-connect is off", async () => {
    storeState.autoConnectOnStartup = false
    await rehydrateExternalAgent(makeAgent({ id: "a1" }), fakeManager, alive)
    expect(addAgentMock).toHaveBeenCalledTimes(1)
    expect(connectMock).not.toHaveBeenCalled()
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "disconnected")
  })

  it("marks the agent errored and records lastError when connect rejects", async () => {
    connectMock.mockRejectedValueOnce(new Error("refused"))
    await rehydrateExternalAgent(makeAgent({ id: "a1" }), fakeManager, alive)
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "error")
    expect(setStateMock).toHaveBeenCalledWith({ lastError: "refused" })
  })

  it("skips a plugin-protocol agent whose adapter is not registered", async () => {
    hasMock.mockReturnValue(false)
    await rehydrateExternalAgent(
      makeAgent({ id: "p1", protocol: "plug:demo" as never }),
      fakeManager,
      alive
    )
    expect(addAgentMock).not.toHaveBeenCalled()
  })

  it("resolves a runtime-blocked agent to its status without connecting", async () => {
    addAgentMock.mockResolvedValueOnce({
      config: makeAgent({ id: "a1" }),
      connectionStatus: "disconnected",
      validity: { executable: false, blockingReason: "blocked-runtime" },
    })
    await rehydrateExternalAgent(makeAgent({ id: "a1" }), fakeManager, alive)
    expect(connectMock).not.toHaveBeenCalled()
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "disconnected")
  })

  it("resolves an execution-blocked agent without connecting", async () => {
    getBlockReasonMock.mockReturnValue("exec-blocked")
    await rehydrateExternalAgent(makeAgent({ id: "a1" }), fakeManager, alive)
    expect(connectMock).not.toHaveBeenCalled()
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "disconnected")
  })

  it("marks a non-executable config errored", async () => {
    isExecutableMock.mockReturnValue(false)
    await rehydrateExternalAgent(makeAgent({ id: "a1" }), fakeManager, alive)
    expect(connectMock).not.toHaveBeenCalled()
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "error")
  })

  it("bails before connecting when the run is cancelled after registration", async () => {
    await rehydrateExternalAgent(makeAgent({ id: "a1" }), fakeManager, () => false)
    expect(addAgentMock).toHaveBeenCalledTimes(1)
    expect(connectMock).not.toHaveBeenCalled()
  })

  it("bails before stamping connected when cancelled after connect", async () => {
    let calls = 0
    await rehydrateExternalAgent(makeAgent({ id: "a1" }), fakeManager, () => {
      calls += 1
      return calls === 1
    })
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(setConnectionStatusMock).not.toHaveBeenCalledWith("a1", "connected")
  })

  it("records lastError when addAgent throws a real (non-race) error", async () => {
    addAgentMock.mockRejectedValueOnce(new Error("spawn failed"))
    await rehydrateExternalAgent(makeAgent({ id: "a1" }), fakeManager, alive)
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "error")
    expect(setStateMock).toHaveBeenCalledWith({ lastError: "spawn failed" })
  })
})

// --------------------------------------------------------------------------
// isRehydratableProtocol
// --------------------------------------------------------------------------

describe("isRehydratableProtocol", () => {
  it("accepts built-in supported protocols", () => {
    expect(isRehydratableProtocol("acp")).toBe(true)
    expect(isRehydratableProtocol("opencode" as never)).toBe(true)
  })

  it("accepts a plugin protocol only when its adapter is registered", () => {
    hasMock.mockReturnValue(false)
    expect(isRehydratableProtocol("plug:demo" as never)).toBe(false)
    hasMock.mockReturnValue(true)
    expect(isRehydratableProtocol("plug:demo" as never)).toBe(true)
  })
})

describe("prepareExternalAgentsForRehydration", () => {
  it("migrates legacy secrets before it judges anything", async () => {
    const order: string[] = []
    migrateLegacyCredentialsMock.mockImplementation(async () => {
      order.push("migrate")
      return { migrated: [], failed: [] }
    })
    reviewAllMock.mockImplementation(async () => {
      order.push("review")
      return new Map()
    })

    await prepareExternalAgentsForRehydration()

    // Order is the whole point: no adapter may be constructed from a config
    // that still carries plaintext.
    expect(order).toEqual(["migrate", "review"])
  })

  it("returns the verdicts the review produced", async () => {
    reviewAllMock.mockResolvedValue(
      new Map([["a1", { status: "blocked", reasonCode: "adapter_unavailable" }]])
    )
    const verdicts = await prepareExternalAgentsForRehydration()
    expect(verdicts.get("a1")).toMatchObject({ reasonCode: "adapter_unavailable" })
  })

  it("degrades to no verdicts rather than bricking boot", async () => {
    getLifecycleServiceMock.mockRejectedValue(new Error("vault locked"))

    const verdicts = await prepareExternalAgentsForRehydration()

    expect(verdicts.size).toBe(0)
    expect(setStateMock).toHaveBeenCalledWith({ lastError: "vault locked" })
  })
})

describe("lifecycle verdict gating", () => {
  it("does not register an agent the lifecycle judged unrunnable", async () => {
    await rehydrateExternalAgent(makeAgent(), fakeManager, () => true, {
      status: "needs-consent",
      reasonCode: "consent_required",
    })

    // The reason is already recorded on the config, so this returns quietly
    // instead of spawning a process that would fail unexplained.
    expect(addAgentMock).not.toHaveBeenCalled()
    expect(connectMock).not.toHaveBeenCalled()
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "disconnected")
  })

  it("proceeds normally for a ready verdict", async () => {
    await rehydrateExternalAgent(makeAgent(), fakeManager, () => true, { status: "ready" })
    expect(addAgentMock).toHaveBeenCalled()
  })

  it("proceeds when no verdict was produced at all", async () => {
    await rehydrateExternalAgent(makeAgent(), fakeManager, () => true, undefined)
    expect(addAgentMock).toHaveBeenCalled()
  })

  it("runs preparation before rehydrating, and gates on its verdicts", async () => {
    storeState.getAllAgents = () => [makeAgent({ id: "ok" }), makeAgent({ id: "blocked" })]
    reviewAllMock.mockResolvedValue(
      new Map([["blocked", { status: "blocked", reasonCode: "adapter_unavailable" }]])
    )

    const dispose = startExternalAgentRehydration()
    await flush()
    await flush()
    dispose()

    expect(migrateLegacyCredentialsMock).toHaveBeenCalled()
    expect(addAgentMock).toHaveBeenCalledTimes(1)
    expect(addAgentMock.mock.calls[0][0].id).toBe("ok")
  })

  it("skips preparation entirely when nothing is persisted", async () => {
    const dispose = startExternalAgentRehydration()
    await flush()
    dispose()
    expect(getLifecycleServiceMock).not.toHaveBeenCalled()
  })
})
