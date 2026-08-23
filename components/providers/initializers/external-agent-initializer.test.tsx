/**
 * @jest-environment jsdom
 */

import { render, act, waitFor } from "@testing-library/react"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import type { ProtocolAdapterRegistryChange } from "@/lib/ai/agent/external/protocol-adapter"

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

interface FakeInstance {
  config: ExternalAgentConfig
  connectionStatus: string
  validity?: { executable: boolean; blockingReason?: string }
}

const setAcpDynamicMcpHostControllerMock = jest.fn()
const dynamicMcpController = { connect: jest.fn(), message: jest.fn(), disconnect: jest.fn() }
jest.mock("@/lib/ai/agent/external/acp-client", () => ({
  setAcpDynamicMcpHostController: (...args: unknown[]) =>
    setAcpDynamicMcpHostControllerMock(...args),
}))
jest.mock("@/lib/ai/agent/external/acp-dynamic-mcp-controller", () => ({
  createAcpDynamicMcpHostController: () => dynamicMcpController,
}))

const agentsInManager = new Map<string, FakeInstance>()
const addAgentMock = jest.fn(async (config: ExternalAgentConfig) => {
  const inst: FakeInstance = {
    config,
    connectionStatus: "disconnected",
    validity: { executable: true },
  }
  agentsInManager.set(config.id, inst)
  return inst
})
const connectMock = jest.fn(async (id: string) => {
  const inst = agentsInManager.get(id)
  if (inst) inst.connectionStatus = "connected"
})
const getAgentMock = jest.fn((id: string) => agentsInManager.get(id))
const fakeManager = { addAgent: addAgentMock, connect: connectMock, getAgent: getAgentMock }
jest.mock("@/lib/ai/agent/external/manager", () => ({
  getExternalAgentManager: () => fakeManager,
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

import { ExternalAgentInitializer } from "./external-agent-initializer"

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
})

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("ExternalAgentInitializer", () => {
  it("attaches and detaches the governed dynamic MCP controller", async () => {
    const view = render(<ExternalAgentInitializer />)
    await waitFor(() =>
      expect(setAcpDynamicMcpHostControllerMock).toHaveBeenCalledWith(dynamicMcpController)
    )
    view.unmount()
    expect(setAcpDynamicMcpHostControllerMock).toHaveBeenLastCalledWith(undefined)
  })

  it("rehydrates and auto-connects every executable agent (in parallel)", async () => {
    storeState.getAllAgents = () => [makeAgent({ id: "a1" }), makeAgent({ id: "a2" })]

    await act(async () => {
      render(<ExternalAgentInitializer />)
    })

    await waitFor(() => expect(connectMock).toHaveBeenCalledTimes(2))
    expect(addAgentMock).toHaveBeenCalledTimes(2)
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "connected")
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a2", "connected")
  })

  it("does not connect when autoConnectOnStartup is off", async () => {
    storeState.autoConnectOnStartup = false
    storeState.getAllAgents = () => [makeAgent({ id: "a1" })]

    await act(async () => {
      render(<ExternalAgentInitializer />)
    })

    await waitFor(() => expect(addAgentMock).toHaveBeenCalledTimes(1))
    expect(connectMock).not.toHaveBeenCalled()
    expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "disconnected")
  })

  it("marks an agent errored and records lastError when connect rejects", async () => {
    storeState.getAllAgents = () => [makeAgent({ id: "a1" })]
    connectMock.mockRejectedValueOnce(new Error("refused"))

    await act(async () => {
      render(<ExternalAgentInitializer />)
    })

    await waitFor(() => expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "error"))
    expect(setStateMock).toHaveBeenCalledWith({ lastError: "refused" })
  })

  it("times the connect out so one hanging agent never wedges startup", async () => {
    jest.useFakeTimers()
    storeState.getAllAgents = () => [makeAgent({ id: "a1" })]
    connectMock.mockImplementationOnce(() => new Promise<void>(() => {}))

    render(<ExternalAgentInitializer />)
    await act(async () => {
      await jest.advanceTimersByTimeAsync(30000)
    })

    expect(setConnectionStatusMock).toHaveBeenCalledWith("a1", "error")
    jest.useRealTimers()
  })

  it("skips a plugin-protocol agent whose adapter is not registered", async () => {
    storeState.getAllAgents = () => [makeAgent({ id: "p1", protocol: "plug:demo" as never })]
    hasMock.mockReturnValue(false)

    await act(async () => {
      render(<ExternalAgentInitializer />)
    })

    await waitFor(() => expect(setConnectionStatusMock).toHaveBeenCalled())
    expect(addAgentMock).not.toHaveBeenCalled()
  })

  it("rehydrates a plugin-protocol agent once its adapter is registered", async () => {
    storeState.getAllAgents = () => [makeAgent({ id: "p1", protocol: "plug:demo" as never })]
    hasMock.mockReturnValue(true)

    await act(async () => {
      render(<ExternalAgentInitializer />)
    })

    await waitFor(() => expect(addAgentMock).toHaveBeenCalledTimes(1))
    expect(addAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: "p1", protocol: "plug:demo" })
    )
  })

  it("rehydrates persisted agents when a plugin registers its adapter mid-session", async () => {
    storeState.autoConnectOnStartup = false
    storeState.getAllAgents = () => [makeAgent({ id: "p1", protocol: "plug:demo" as never })]
    hasMock.mockReturnValue(false)

    await act(async () => {
      render(<ExternalAgentInitializer />)
    })
    expect(addAgentMock).not.toHaveBeenCalled()
    expect(registryListener).toBeInstanceOf(Function)

    // Plugin now enabled: its adapter is registered and the change fires.
    hasMock.mockReturnValue(true)
    await act(async () => {
      registryListener?.({ kind: "register", protocols: ["plug:demo"], pluginId: "plug" })
    })

    await waitFor(() =>
      expect(addAgentMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "p1", protocol: "plug:demo" })
      )
    )
  })

  it("ignores unregister changes and protocols with no persisted agent", async () => {
    storeState.getAllAgents = () => [makeAgent({ id: "p1", protocol: "plug:demo" as never })]

    await act(async () => {
      render(<ExternalAgentInitializer />)
    })
    addAgentMock.mockClear()

    await act(async () => {
      registryListener?.({ kind: "unregister", protocols: ["plug:demo"], pluginId: "plug" })
      registryListener?.({ kind: "register", protocols: ["other:thing"], pluginId: "other" })
    })

    expect(addAgentMock).not.toHaveBeenCalled()
  })

  it("unsubscribes from registry changes on unmount", async () => {
    let unmount = () => {}
    await act(async () => {
      ;({ unmount } = render(<ExternalAgentInitializer />))
    })
    unmount()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })
})
