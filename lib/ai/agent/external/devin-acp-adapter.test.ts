jest.mock("./acp-client", () => ({ AcpClientAdapter: class {} }))

import type { AcpClientAdapter } from "./acp-client"
import type {
  AcpConfigOption,
  ExternalAgentConfig,
  ExternalAgentEvent,
  ExternalAgentSession,
} from "@/types/agent/external-agent"
import { DevinAcpAdapter } from "./devin-acp-adapter"

const config = {
  id: "devin",
  name: "Devin",
  enabled: true,
  protocol: "acp",
  transport: "stdio",
  process: { command: "devin", args: ["acp"], env: { DEVIN_TEST: "kept" }, keepAlive: true },
} as ExternalAgentConfig
const options = {
  cwd: "/workspace",
  mcpServers: [
    { name: "cognia", command: "node", args: ["bridge"], env: [{ name: "TOKEN", value: "first" }] },
  ],
}

function fake(id: string) {
  let session: ExternalAgentSession = {
    id,
    agentId: "child-id",
    status: "active",
    createdAt: new Date(),
    lastActivityAt: new Date(),
  }
  const child = {
    connectionStatus: "connected",
    capabilities: { streaming: true },
    tools: [],
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    createSession: jest.fn().mockImplementation(async () => session),
    loadSession: jest.fn().mockImplementation(async (loaded: string) => {
      session = { ...session, id: loaded }
      return session
    }),
    resumeSession: jest.fn().mockImplementation(async (loaded: string) => {
      session = { ...session, id: loaded }
      return session
    }),
    forkSession: jest.fn().mockImplementation(async () => session),
    closeSession: jest.fn().mockResolvedValue(undefined),
    deleteSession: jest.fn().mockResolvedValue(undefined),
    getSession: jest.fn(() => session),
    healthCheck: jest.fn().mockResolvedValue(true),
    forgetSessions: jest.fn(),
    cancel: jest.fn().mockResolvedValue(undefined),
    respondToPermission: jest.fn().mockResolvedValue(undefined),
    respondToElicitation: jest.fn().mockResolvedValue(undefined),
    cancelRequest: jest.fn().mockResolvedValue(undefined),
    prompt: jest.fn(async function* (): AsyncIterable<ExternalAgentEvent> {
      yield {
        type: "done",
        sessionId: id,
        timestamp: new Date(),
        stopReason: "end_turn",
        success: true,
      }
    }),
    getSessionModels: jest.fn(() => ({ currentModelId: "swe-2-medium", availableModels: [] })),
    getConfigOptions: jest.fn((): AcpConfigOption[] | undefined => []),
    setSessionModel: jest.fn(),
    setSessionMode: jest.fn(),
    setConfigOption: jest.fn(
      async (
        _sessionId: string,
        _configId: string,
        _value: string | boolean
      ): Promise<AcpConfigOption[]> => []
    ),
    getCompactionCapability: jest.fn(),
    compactSession: jest.fn(),
    getProviderUndoCapability: jest.fn(),
    undoLastProviderChange: jest.fn(),
    listSessions: jest.fn().mockResolvedValue([]),
    getAuthMethods: jest.fn(() => []),
    isAuthenticationRequired: jest.fn(() => false),
    authenticate: jest.fn(),
    getTerminalAuthState: jest.fn(),
    cancelTerminalAuthentication: jest.fn(),
    getAcpInitializationMetadata: jest.fn(),
    getSessionExtensionSupport: jest.fn(),
    clearSessionExtensionSupportCache: jest.fn(),
    listProviders: jest.fn(),
    setProvider: jest.fn(),
    disableProvider: jest.fn(),
    startNes: jest.fn(),
    suggestNes: jest.fn(),
    closeNes: jest.fn(),
    didOpenDocument: jest.fn(),
    didChangeDocument: jest.fn(),
    didCloseDocument: jest.fn(),
    didSaveDocument: jest.fn(),
    didFocusDocument: jest.fn(),
    logout: jest.fn(),
    getDynamicMcpConnections: jest.fn(() => []),
  }
  return child
}
function harness() {
  const discovery = fake("discovery")
  const children: ReturnType<typeof fake>[] = []
  const adapter = new DevinAcpAdapter(discovery as unknown as AcpClientAdapter, () => {
    const child = fake(`session-${children.length}`)
    children.push(child)
    return child as unknown as AcpClientAdapter
  })
  return { adapter, discovery, children }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("Devin ACP process ownership", () => {
  it("isolates concurrent MCP credentials and hides process IDs from sessions", async () => {
    const { adapter, children, discovery } = harness()
    await adapter.connect(config)
    const second = {
      ...options,
      mcpServers: [{ ...options.mcpServers[0], env: [{ name: "TOKEN", value: "second" }] }],
    }
    const sessions = await Promise.all([
      adapter.createSession(options),
      adapter.createSession(second),
    ])
    expect(sessions.map((session) => session.agentId)).toEqual(["devin", "devin"])
    expect(discovery.connect.mock.calls[0][0].id).toBe("devin")
    for (const [index, child] of children.entries()) {
      const launched = child.connect.mock.calls[0][0]
      expect(launched.id).toBe(`devin:devin:${index + 1}`)
      expect(launched.process.keepAlive).toBe(false)
      expect(launched.process.restartOnCrash).toBe(false)
      expect(launched.process.env.DEVIN_TEST).toBe("kept")
      expect(JSON.parse(launched.process.env.COGNIA_DEVIN_MCP_SERVERS)[0].env[0].value).toBe(
        index === 0 ? "first" : "second"
      )
      expect(child.createSession).toHaveBeenCalledWith({ ...options, mcpServers: [] })
    }
    expect(adapter.getSessions()).toHaveLength(2)
    expect(adapter.getSessionModels(sessions[0].id)?.currentModelId).toBe("swe-2-medium")
    expect(adapter.getConfigOptions(sessions[0].id)).toEqual([])
    await adapter.disconnect()
    expect(children.every((child) => child.disconnect.mock.calls.length === 1)).toBe(true)
    expect(adapter.getSessions()).toEqual([])
  })

  it.each(["loadSession", "resumeSession"] as const)(
    "rotates the process and credentials on %s",
    async (method) => {
      const { adapter, children } = harness()
      await adapter.connect(config)
      const original = await adapter.createSession(options)
      const loaded = await adapter[method](original.id, { ...options, mcpServers: [] })
      expect(loaded.id).toBe(original.id)
      expect(children[0].disconnect).toHaveBeenCalledTimes(1)
      expect(children[1][method]).toHaveBeenCalledWith(original.id, { ...options, mcpServers: [] })
      expect(adapter.getSessions()).toHaveLength(1)
      await adapter.disconnect()
    }
  )

  it("forks into a new process and routes mutations only to the owner", async () => {
    const { adapter, children, discovery } = harness()
    await adapter.connect(config)
    const original = await adapter.createSession(options)
    const fork = await adapter.forkSession(original.id, options)
    const permission = { requestId: "tool", granted: true, optionId: "allow" }
    await adapter.respondToPermission(fork.id, permission)
    await adapter.cancel(fork.id)
    expect(children[1].respondToPermission).toHaveBeenCalledWith(fork.id, permission)
    expect(children[0].respondToPermission).not.toHaveBeenCalled()
    expect(discovery.cancel).not.toHaveBeenCalled()
    await adapter.closeSession(fork.id)
    expect(adapter.getSessions().map((session) => session.id)).toEqual([original.id])
    await adapter.deleteSession(original.id)
    await adapter.deleteSession("saved-history")
    expect(discovery.deleteSession).toHaveBeenCalledWith("saved-history")
    await adapter.disconnect()
  })

  it("stops partially created processes when create and close fail", async () => {
    const child = fake("fail")
    child.createSession.mockRejectedValue(new Error("create failed"))
    const adapter = new DevinAcpAdapter(
      fake("discovery") as unknown as AcpClientAdapter,
      () => child as unknown as AcpClientAdapter
    )
    await adapter.connect(config)
    await expect(adapter.createSession(options)).rejects.toThrow("create failed")
    expect(child.disconnect).toHaveBeenCalledTimes(1)
    child.createSession.mockResolvedValue({ id: "fail", agentId: "child" })
    await adapter.createSession(options)
    child.closeSession.mockRejectedValue(new Error("close failed"))
    await expect(adapter.closeSession("fail")).rejects.toThrow("close failed")
    expect(child.disconnect).toHaveBeenCalledTimes(2)
    expect(adapter.getSessions()).toEqual([])
    await adapter.disconnect()
  })

  it("waits for a racing child connect and destroys it before disconnect returns", async () => {
    const child = fake("pending")
    const gate = deferred<void>()
    child.connect.mockReturnValue(gate.promise)
    const adapter = new DevinAcpAdapter(
      fake("discovery") as unknown as AcpClientAdapter,
      () => child as unknown as AcpClientAdapter
    )
    await adapter.connect(config)
    const creating = adapter.createSession(options)
    const rejected = expect(creating).rejects.toThrow("cancelled")
    const disconnecting = adapter.disconnect()
    gate.resolve()
    await Promise.all([rejected, disconnecting])
    expect(child.createSession).not.toHaveBeenCalled()
    expect(child.disconnect).toHaveBeenCalledTimes(1)
    expect(adapter.isConnected()).toBe(false)
  })

  it("routes identical elicitation wire IDs to their owning processes", async () => {
    const { adapter, children } = harness()
    await adapter.connect(config)
    const sessions = await Promise.all([adapter.createSession(), adapter.createSession()])
    const ids: string[] = []
    for (const [index, child] of children.entries()) {
      child.prompt.mockImplementation(async function* () {
        yield {
          type: "elicitation_request",
          sessionId: sessions[index].id,
          timestamp: new Date(),
          request: { id: "rpc:7", requestId: 7, mode: "form", message: "Input", raw: {} },
        }
      })
      for await (const event of adapter.prompt(sessions[index].id, {
        id: "m",
        role: "user",
        content: [],
        timestamp: new Date(),
      })) {
        if (event.type === "elicitation_request") ids.push(event.request.id)
      }
    }
    expect(ids[0]).not.toBe(ids[1])
    await adapter.respondToElicitation({ requestId: ids[0], action: "accept" })
    await adapter.cancelRequest(ids[1])
    expect(children[0].respondToElicitation).toHaveBeenCalledWith({
      requestId: "rpc:7",
      action: "accept",
    })
    expect(children[1].cancelRequest).toHaveBeenCalledWith(7)
    expect(children[0].cancelRequest).not.toHaveBeenCalled()
    await expect(adapter.cancelRequest(7)).rejects.toThrow("Unknown Devin request")
    await expect(
      adapter.respondToElicitation({ requestId: "missing", action: "cancel" })
    ).rejects.toThrow("Unknown Devin elicitation")
    await adapter.disconnect()
  })

  it("keeps discovery metadata separate and reports unhealthy children", async () => {
    const { adapter, discovery, children } = harness()
    await expect(adapter.createSession()).rejects.toThrow("not connected")
    await adapter.connect(config)
    expect(adapter.capabilities).toEqual(discovery.capabilities)
    expect(adapter.tools).toEqual([])
    expect(await adapter.healthCheck()).toBe(true)
    await adapter.listSessions({ cwd: "/workspace" })
    expect(discovery.listSessions).toHaveBeenCalledWith({ cwd: "/workspace" })
    await adapter.createSession()
    children[0].healthCheck.mockResolvedValue(false)
    expect(await adapter.healthCheck()).toBe(true)
    adapter.forgetSessions()
    await adapter.disconnect()
    expect(adapter.getSessions()).toEqual([])
  })
})

it("retains failed shutdown handles for a retry", async () => {
  const { adapter, children } = harness()
  await adapter.connect(config)
  await adapter.createSession()
  children[0].disconnect.mockRejectedValueOnce(new Error("stop failed"))
  await expect(adapter.disconnect()).rejects.toThrow("stop failed")
  await adapter.disconnect()
  expect(children[0].disconnect).toHaveBeenCalledTimes(2)
})

it("rejects duplicate restore operations before starting another child", async () => {
  const { adapter, children } = harness()
  await adapter.connect(config)
  const gate = deferred<void>()
  const first = adapter.createSession()
  await first
  children[0].disconnect.mockReturnValueOnce(gate.promise)
  const restoring = adapter.loadSession("session-0", options)
  await expect(adapter.resumeSession("session-0", options)).rejects.toThrow(
    "already being restored"
  )
  gate.resolve()
  await restoring
  expect(children).toHaveLength(2)
  await adapter.disconnect()
})

it("passes per-session model, configuration and advertised commands to their owner", async () => {
  const { adapter, children } = harness()
  await adapter.connect(config)
  const session = await adapter.createSession()
  await adapter.setSessionModel(session.id, "swe-2-medium")
  await adapter.setSessionMode(session.id, "acceptEdits")
  await adapter.setConfigOption(session.id, "mode", "accept-edits")
  await adapter.getCompactionCapability(session.id)
  await adapter.compactSession(session.id)
  await adapter.getProviderUndoCapability(session.id)
  await adapter.undoLastProviderChange(session.id)
  expect(children[0].setSessionModel).toHaveBeenCalledWith(session.id, "swe-2-medium")
  expect(children[0].setSessionMode).toHaveBeenCalledWith(session.id, "acceptEdits")
  expect(children[0].setConfigOption).toHaveBeenCalledWith(session.id, "mode", "accept-edits")
  expect(children[0].compactSession).toHaveBeenCalledWith(session.id)
  expect(children[0].undoLastProviderChange).toHaveBeenCalledWith(session.id)
  await adapter.disconnect()
  expect(() => adapter.cancel(session.id)).toThrow("Session not found")
})

it("synthesizes a thought_level axis out of the Devin model list", async () => {
  const { adapter, children } = harness()
  await adapter.connect(config)
  const session = await adapter.createSession()
  let wireOptions: AcpConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: "claude-opus-5-high",
      options: [
        { value: "claude-opus-5-low", name: "Claude Opus 5 Low Thinking" },
        { value: "claude-opus-5-medium", name: "Claude Opus 5 Medium Thinking" },
        { value: "claude-opus-5-high", name: "Claude Opus 5 High Thinking" },
        { value: "claude-opus-5-max", name: "Claude Opus 5 Max Thinking" },
        { value: "swe-1-6", name: "SWE-1.6" },
        { value: "swe-1-7", name: "SWE-1.7 Max" },
      ],
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select" as const,
      currentValue: "smart",
      options: [{ value: "smart", name: "Smart" }],
    },
  ]
  children[0].getConfigOptions.mockImplementation(() => wireOptions)
  children[0].setConfigOption.mockImplementation(
    async (_id: string, configId: string, value: string | boolean) => {
      wireOptions = wireOptions.map((option) =>
        option.id === configId && option.type === "select"
          ? { ...option, currentValue: String(value) }
          : option
      )
      return wireOptions
    }
  )

  const listed = adapter.getConfigOptions(session.id)
  expect(listed?.map((option) => option.id)).toEqual(["model", "mode", "devin.thought_level"])
  const axis = listed?.[2]
  expect(axis).toMatchObject({ category: "thought_level", currentValue: "high" })
  expect(
    axis?.type === "select" &&
      axis.options
        .flatMap((entry) => ("group" in entry ? entry.options : [entry]))
        .map((e) => e.value)
  ).toEqual(["low", "medium", "high", "max"])

  // A thinking write is a model write to the family member carrying that level.
  const after = await adapter.setConfigOption(session.id, "devin.thought_level", "low")
  expect(children[0].setConfigOption).toHaveBeenCalledWith(session.id, "model", "claude-opus-5-low")
  expect(after.find((option) => option.id === "model")).toMatchObject({
    currentValue: "claude-opus-5-low",
  })
  expect(after.find((option) => option.id === "devin.thought_level")).toMatchObject({
    currentValue: "low",
  })

  // Other config ids delegate untouched; unknown levels reject without a write.
  await adapter.setConfigOption(session.id, "mode", "plan")
  expect(children[0].setConfigOption).toHaveBeenLastCalledWith(session.id, "mode", "plan")
  await expect(adapter.setConfigOption(session.id, "devin.thought_level", "none")).rejects.toThrow(
    "not available"
  )
  await expect(adapter.setConfigOption(session.id, "devin.thought_level", true)).rejects.toThrow(
    "not available"
  )
  await adapter.disconnect()
})

it("retains the discovery connection's feature gates for connection-level APIs", async () => {
  const { adapter, discovery } = harness()
  await adapter.connect(config)
  adapter.getAuthMethods()
  adapter.isAuthenticationRequired()
  await adapter.authenticate("native")
  adapter.getTerminalAuthState()
  await adapter.cancelTerminalAuthentication()
  adapter.getAcpInitializationMetadata()
  adapter.getSessionExtensionSupport()
  adapter.clearSessionExtensionSupportCache()
  adapter.getDynamicMcpConnections()
  await adapter.logout()
  discovery.listProviders.mockRejectedValue(new Error("providers not negotiated"))
  await expect(adapter.listProviders()).rejects.toThrow("providers not negotiated")
  for (const name of [
    "getAuthMethods",
    "isAuthenticationRequired",
    "authenticate",
    "getTerminalAuthState",
    "cancelTerminalAuthentication",
    "getAcpInitializationMetadata",
    "getSessionExtensionSupport",
    "clearSessionExtensionSupportCache",
    "getDynamicMcpConnections",
    "logout",
  ] as const) {
    expect(discovery[name]).toHaveBeenCalledTimes(1)
  }
  await adapter.setProvider({ providerId: "provider" } as never)
  await adapter.disableProvider({ providerId: "provider" } as never)
  await adapter.startNes({ sessionId: "nes" } as never)
  await adapter.suggestNes({ sessionId: "nes" } as never)
  await adapter.closeNes({ sessionId: "nes" } as never)
  adapter.didOpenDocument({ sessionId: "nes" } as never)
  adapter.didChangeDocument({ sessionId: "nes" } as never)
  adapter.didCloseDocument({ sessionId: "nes" } as never)
  adapter.didSaveDocument({ sessionId: "nes" } as never)
  adapter.didFocusDocument({ sessionId: "nes" } as never)
  expect(discovery.didFocusDocument).toHaveBeenCalledWith({ sessionId: "nes" })
  await adapter.disconnect()
})

it("cleans up discovery on failed and cancelled connections", async () => {
  const { adapter, discovery } = harness()
  discovery.connect.mockRejectedValueOnce(new Error("initialize failed"))
  await expect(adapter.connect(config)).rejects.toThrow("initialize failed")
  expect(adapter.connectionStatus).toBe("error")
  const gate = deferred<void>()
  discovery.connect.mockReturnValueOnce(gate.promise)
  const connecting = adapter.connect(config)
  // Allow the prior transport teardown and new connect to start.
  for (let i = 0; i < 10; ++i) await Promise.resolve()
  const rejected = expect(connecting).rejects.toThrow("cancelled")
  const stopping = adapter.disconnect()
  gate.resolve()
  await Promise.all([rejected, stopping])
  expect(adapter.connectionStatus).toBe("disconnected")
})

it("rejects invalid process configuration without leaving a connecting adapter", async () => {
  const { adapter, discovery } = harness()
  await expect(adapter.connect({ ...config, process: undefined })).rejects.toThrow(
    "process configuration"
  )
  expect(adapter.connectionStatus).toBe("error")
  expect(discovery.connect).not.toHaveBeenCalled()
  await adapter.disconnect()
})

it("retires a crashed child without reconnecting or stopping its healthy sibling", async () => {
  const { adapter, children, discovery } = harness()
  await adapter.connect(config)
  const [first, second] = await Promise.all([
    adapter.createSession(options),
    adapter.createSession(options),
  ])
  children[0].connectionStatus = "disconnected"
  children[0].healthCheck.mockResolvedValue(false)
  expect(await adapter.healthCheck()).toBe(true)
  expect(adapter.getSession(first.id)).toBeUndefined()
  expect(adapter.getSession(second.id)).toBeDefined()
  expect(children[0].disconnect).toHaveBeenCalledTimes(1)
  expect(children[1].disconnect).not.toHaveBeenCalled()
  expect(discovery.connect).toHaveBeenCalledTimes(1)
  await adapter.cancel(second.id)
  expect(children[1].cancel).toHaveBeenCalledWith(second.id)
  await adapter.resumeSession(first.id, options)
  expect(children).toHaveLength(3)
  expect(adapter.getSessions()).toHaveLength(2)
  await adapter.disconnect()
})

it("preserves safe fork context and workspace without inheriting broker credentials", async () => {
  const { adapter, children } = harness()
  await adapter.connect(config)
  const source = await adapter.createSession(options)
  source.metadata = {
    cwd: "/different-workspace",
    additionalDirectories: ["/extra"],
    cogniaSessionId: "chat",
    instructionEnvelope: { hash: "instruction" },
    token: "must-not-inherit",
  }
  const fork = await adapter.forkSession(source.id)
  expect(children[1].connect.mock.calls[0][0].process).toMatchObject({
    cwd: "/different-workspace",
    env: { COGNIA_DEVIN_MCP_SERVERS: "[]" },
  })
  expect(children[1].forkSession).toHaveBeenCalledWith(source.id, {
    cwd: "/different-workspace",
    additionalDirectories: ["/extra"],
    mcpServers: [],
  })
  expect(fork.metadata).toMatchObject({
    cogniaSessionId: "chat",
    instructionEnvelope: { hash: "instruction" },
  })
  expect(fork.metadata).not.toHaveProperty("token")
  await adapter.disconnect()
})
