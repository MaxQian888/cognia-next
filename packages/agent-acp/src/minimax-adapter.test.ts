import type { AcpClientAdapter } from "./client"
import type {
  ExternalAgentConfig,
  ExternalAgentSession,
} from "@cognia/agent-contracts/external-agent"
import { MiniMaxAcpAdapter } from "./minimax-adapter"

const config = {
  id: "mm",
  enabled: true,
  name: "MiniMax Code",
  protocol: "acp",
  transport: "stdio",
  process: { command: "mcode", args: ["acp"], env: { MINIMAX_DATA_DIR: "/state" } },
} as ExternalAgentConfig

function fake(id: string) {
  const session = {
    id,
    agentId: "child",
    status: "active",
    createdAt: new Date(),
    lastActivityAt: new Date(),
    permissionMode: "default",
    metadata: { cwd: "/work" },
  } as ExternalAgentSession
  return {
    session,
    connectionStatus: "connected",
    capabilities: { streaming: true },
    tools: [],
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    createSession: jest.fn().mockResolvedValue(session),
    loadSession: jest.fn().mockImplementation(async (loaded: string) => {
      session.id = loaded
      return session
    }),
    resumeSession: jest.fn().mockImplementation(async (loaded: string) => {
      session.id = loaded
      return session
    }),
    forkSession: jest.fn().mockResolvedValue(session),
    getSession: jest.fn(() => session),
    closeSession: jest.fn(),
    deleteSession: jest.fn(),
    setSessionMode: jest.fn().mockImplementation(async (_id: string, mode: string) => {
      session.permissionMode = mode as never
    }),
    setConfigOption: jest.fn().mockResolvedValue([]),
    getConfigOptions: jest.fn(() => [
      {
        id: "permissionMode",
        type: "select",
        category: "_permission",
        currentValue: "default",
        options: [
          { value: "default", name: "Ask" },
          { value: "auto", name: "Auto" },
          { value: "bypassPermissions", name: "Full access" },
        ],
      },
    ]),
    respondToPermission: jest.fn(),
    cancel: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue(true),
  }
}
function harness() {
  const discovery = fake("discovery")
  const children: ReturnType<typeof fake>[] = []
  const adapter = new MiniMaxAcpAdapter(discovery as unknown as AcpClientAdapter, () => {
    const child = fake(`s${children.length}`)
    children.push(child)
    return child as unknown as AcpClientAdapter
  })
  return { adapter, children, discovery }
}

describe("MiniMax ACP", () => {
  it.each([
    ["default", "default", "default"],
    ["plan", "default", "plan"],
    ["bypassPermissions", "bypassPermissions", "default"],
  ] as const)(
    "separates %s permissions from interaction mode",
    async (canonical, permission, interaction) => {
      const { adapter, children } = harness()
      await adapter.connect(config)
      const session = await adapter.createSession({ cwd: "/work", permissionMode: canonical })
      expect(children[0].setConfigOption).toHaveBeenLastCalledWith(
        session.id,
        "permissionMode",
        permission
      )
      expect(children[0].setSessionMode).toHaveBeenLastCalledWith(session.id, interaction)
      expect(adapter.getSession(session.id)?.permissionMode).toBe(canonical)
      await adapter.disconnect()
    }
  )

  it("isolates concurrent process permissions and preserves session MCP scopes", async () => {
    const { adapter, children } = harness()
    await adapter.connect(config)
    const mcpServers = [{ name: "scope", command: "node", args: ["bridge"], env: [] }]
    const [a, b] = await Promise.all([
      adapter.createSession({ cwd: "/work", mcpServers, permissionMode: "default" }),
      adapter.createSession({ cwd: "/work", mcpServers: [], permissionMode: "plan" }),
    ])
    const launches = children.map((c) => c.connect.mock.calls[0][0])
    expect(new Set(launches.map((c) => c.id)).size).toBe(2)
    expect(
      launches.every((c) => c.process.restartOnCrash === false && c.process.keepAlive === false)
    ).toBe(true)
    expect(children[0].createSession).toHaveBeenCalledWith(expect.objectContaining({ mcpServers }))
    await adapter.setSessionMode(a.id, "bypassPermissions")
    expect(children[1].setConfigOption).toHaveBeenCalledTimes(1)
    expect(adapter.getSession(b.id)?.permissionMode).toBe("plan")
    await adapter.closeSession(a.id)
    expect(children[0].disconnect).toHaveBeenCalledTimes(1)
    expect(children[1].disconnect).not.toHaveBeenCalled()
    expect(adapter.getSession(b.id)).toBeDefined()
    await adapter.disconnect()
  })

  it("refuses native Auto and stops an incompletely configured child", async () => {
    const { adapter, children } = harness()
    await adapter.connect(config)
    const session = await adapter.createSession()
    await expect(adapter.setConfigOption(session.id, "permissionMode", "auto")).rejects.toThrow(
      "Auto"
    )
    expect(
      adapter.getConfigOptions(session.id)?.find((o) => o.id === "permissionMode")
    ).toBeUndefined()
    children[0].setConfigOption.mockRejectedValueOnce(new Error("permission failed"))
    await expect(adapter.setSessionMode(session.id, "bypassPermissions")).rejects.toThrow(
      "permission failed"
    )
    expect(adapter.getSession(session.id)).toBeUndefined()
    expect(children[0].disconnect).toHaveBeenCalledTimes(1)
    await adapter.disconnect()
  })

  it.each(["loadSession", "resumeSession"] as const)(
    "rotates the process and resets inherited full access on %s",
    async (method) => {
      const { adapter, children } = harness()
      await adapter.connect(config)
      const session = await adapter.createSession({ permissionMode: "bypassPermissions" })
      await adapter[method](session.id, { cwd: "/work", permissionMode: "default" })
      expect(children[0].disconnect).toHaveBeenCalledTimes(1)
      expect(children[1].setConfigOption).toHaveBeenLastCalledWith(
        session.id,
        "permissionMode",
        "default"
      )
      expect(adapter.getSession(session.id)?.permissionMode).toBe("default")
      await adapter.disconnect()
    }
  )
})

it("retires the child if the second axis fails after native permission changed", async () => {
  const { adapter, children } = harness()
  await adapter.connect(config)
  const session = await adapter.createSession()
  children[0].setSessionMode.mockRejectedValueOnce(new Error("plan transition failed"))
  await expect(adapter.setSessionMode(session.id, "plan")).rejects.toThrow("plan transition failed")
  expect(adapter.getSession(session.id)).toBeUndefined()
  expect(children[0].disconnect).toHaveBeenCalledTimes(1)
  await adapter.disconnect()
})

it("serializes both axes and does not start a prompt before a pending downgrade", async () => {
  const { adapter, children } = harness()
  await adapter.connect(config)
  const session = await adapter.createSession()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  children[0].setConfigOption.mockImplementationOnce(async () => {
    await gate
    return []
  })
  const calls: string[] = []
  children[0].setSessionMode.mockImplementation(async (_id, mode) => {
    calls.push(mode)
  })
  const first = adapter.setSessionMode(session.id, "plan")
  const second = adapter.setSessionMode(session.id, "default")
  const prompt = jest.fn(async function* () {
    yield {
      type: "done",
      sessionId: session.id,
      timestamp: new Date(),
      success: true,
      stopReason: "end_turn",
    }
  })
  Object.assign(children[0], { prompt })
  const iterator = adapter.prompt(session.id, {
    id: "m",
    role: "user",
    content: [],
    timestamp: new Date(),
  })
  const stream = iterator[Symbol.asyncIterator]()
  const next = stream.next()
  await Promise.resolve()
  expect(prompt).not.toHaveBeenCalled()
  release()
  await Promise.all([first, second, next])
  expect(calls).toEqual(["plan", "default"])
  await expect(adapter.setSessionMode(session.id, "bypassPermissions")).rejects.toThrow("finish")
  await stream.return?.(undefined)
  await adapter.disconnect()
})

it("returns the prepared session even when child mode changes replace the cached object", async () => {
  const discovery = fake("discovery"),
    child = fake("session")
  let cached = child.session
  child.getSession.mockImplementation(() => cached)
  child.setSessionMode.mockImplementation(async (_id, mode) => {
    cached = { ...cached, permissionMode: mode as never }
  })
  const adapter = new MiniMaxAcpAdapter(
    discovery as unknown as AcpClientAdapter,
    () => child as unknown as AcpClientAdapter
  )
  await adapter.connect(config)
  expect((await adapter.createSession({ permissionMode: "plan" })).permissionMode).toBe("plan")
  await adapter.disconnect()
})

it.each(["acceptEdits", "dontAsk"] as const)(
  "refuses unsupported %s without broadening authority",
  async (mode) => {
    const { adapter, children, discovery } = harness()
    await expect(adapter.connect({ ...config, defaultPermissionMode: mode })).rejects.toThrow(
      "cannot enforce"
    )
    expect(discovery.connect).not.toHaveBeenCalled()
    await adapter.connect(config)
    await expect(adapter.createSession({ permissionMode: mode })).rejects.toThrow("cannot enforce")
    expect(children[0].connect).not.toHaveBeenCalled()
    const session = await adapter.createSession()
    await expect(adapter.setSessionMode(session.id, mode)).rejects.toThrow("cannot enforce")
    expect(adapter.getSession(session.id)?.permissionMode).toBe("default")
    expect(adapter.capabilities.permissionModes).toEqual(["default", "plan", "bypassPermissions"])
    await adapter.disconnect()
  }
)

it("refuses mandatory host approval rules before starting MiniMax", async () => {
  const { adapter, discovery } = harness()
  await expect(adapter.connect({ ...config, requireApprovalFor: ["write"] })).rejects.toThrow(
    "requireApprovalFor"
  )
  expect(discovery.connect).not.toHaveBeenCalled()
})

it("respects a configured native permission default", async () => {
  const { adapter, children } = harness()
  await adapter.connect({ ...config, defaultPermissionMode: "bypassPermissions" })
  const session = await adapter.createSession()
  expect(session.permissionMode).toBe("bypassPermissions")
  expect(children[0].setConfigOption).toHaveBeenLastCalledWith(
    session.id,
    "permissionMode",
    "bypassPermissions"
  )
  await adapter.disconnect()
})

it("applies an execution downgrade and refuses unsupported prompt overrides before sending", async () => {
  const { adapter, children } = harness()
  await adapter.connect(config)
  const session = await adapter.createSession({ permissionMode: "bypassPermissions" })
  const prompt = jest.fn(async function* () {
    expect(session.permissionMode).toBe("default")
  })
  Object.assign(children[0], { prompt })
  const message = { id: "m", role: "user" as const, content: [], timestamp: new Date() }
  expect(
    await adapter
      .prompt(session.id, message, { permissionMode: "default" })
      [Symbol.asyncIterator]()
      .next()
  ).toMatchObject({ done: true })
  expect(children[0].setConfigOption).toHaveBeenLastCalledWith(
    session.id,
    "permissionMode",
    "default"
  )
  await expect(
    adapter
      .prompt(session.id, message, { permissionMode: "dontAsk" })
      [Symbol.asyncIterator]()
      .next()
  ).rejects.toThrow("cannot enforce")
  expect(prompt).toHaveBeenCalledTimes(1)
  await adapter.disconnect()
})
