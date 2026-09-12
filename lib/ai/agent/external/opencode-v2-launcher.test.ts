jest.mock("./agent-transport", () => ({
  agentInvoke: jest.fn(),
  agentListen: jest.fn(),
  runsExternalAgentProcessesLocally: () => true,
}))
import {
  canProjectOpenCodeV2Mcp,
  launchOpenCodeV2Service,
  openCodeV2McpConfig,
} from "./opencode-v2-launcher"
import type { ExternalAgentConfig, AcpMcpServerConfig } from "@/types/agent/external-agent"

const config = {
  id: "oc",
  protocol: "opencode-v2",
  process: { command: "opencode", cwd: "/workspace" },
} as ExternalAgentConfig
const servers = [
  {
    name: "cognia-tools",
    type: "http",
    url: "http://127.0.0.1:9000/mcp",
    headers: [{ name: "Authorization", value: "Bearer session-only" }],
  },
] satisfies AcpMcpServerConfig[]
function setup() {
  const callbacks = new Map<string, (event: { agentId: string; data: string }) => void>()
  const unlisten = jest.fn()
  let id = ""
  const invoke = jest.fn(async (operation, args) => {
    if (operation === "spawn_external_agent") {
      id = args.config.id
      callbacks.get("external-agent://stdout")?.({
        agentId: id,
        data: "server listening on http://127.0.0.1:12345\n",
      })
    }
  })
  const host = {
    invoke: invoke as never,
    listen: jest.fn(async (event, callback) => {
      callbacks.set(event, callback)
      return unlisten
    }) as never,
    available: () => true,
  }
  return { host, invoke, callbacks, unlisten, id: () => id }
}

describe("OpenCode V2 session-owned services", () => {
  it("projects only stdio/HTTP and disables codemode and OAuth for bearer servers", () => {
    expect(
      openCodeV2McpConfig([
        ...servers,
        { name: "stdio", command: "tool", args: ["run"], env: [{ name: "MODE", value: "safe" }] },
      ])
    ).toEqual({
      "cognia-tools": {
        type: "remote",
        url: servers[0].url,
        headers: { Authorization: "Bearer session-only" },
        oauth: false,
        codemode: false,
      },
      stdio: {
        type: "local",
        command: ["tool", "run"],
        environment: { MODE: "safe" },
        codemode: false,
      },
    })
    expect(() => openCodeV2McpConfig([...servers, ...servers])).toThrow("unique")
    expect(() =>
      openCodeV2McpConfig([{ type: "sse", name: "legacy", url: "https://example.com" }])
    ).toThrow("only")
    expect(() =>
      openCodeV2McpConfig([{ type: "http", name: "bad", url: "file:///tmp/a" }])
    ).toThrow("HTTP")
  })

  it("keeps inherited provider configuration in env while each service gets its own password", async () => {
    const { host, invoke, unlisten } = setup()
    const service = await launchOpenCodeV2Service(
      {
        ...config,
        process: {
          ...config.process!,
          env: {
            OPENCODE_CONFIG_CONTENT: JSON.stringify({
              model: "cognia/model",
              mcp: { timeout: { startup: 5000 } },
            }),
          },
        },
      },
      servers,
      "/workspace",
      undefined,
      host
    )
    const launched = invoke.mock.calls.find(
      ([operation]) => operation === "spawn_external_agent"
    )![1].config
    expect(launched.args).toEqual(["serve", "--hostname=127.0.0.1", "--port=0"])
    expect(JSON.parse(launched.env.OPENCODE_CONFIG_CONTENT)).toMatchObject({
      model: "cognia/model",
      mcp: {
        timeout: { startup: 5000 },
        servers: { "cognia-tools": { headers: { Authorization: "Bearer session-only" } } },
      },
    })
    expect(service.endpoint).toBe("http://127.0.0.1:12345")
    expect(atob(service.headers.Authorization.slice(6))).toBe(
      `opencode:${launched.env.OPENCODE_SERVER_PASSWORD}`
    )
    await service.close()
    await service.close()
    expect(
      invoke.mock.calls.filter(([operation]) => operation === "kill_external_agent")
    ).toHaveLength(1)
    expect(unlisten).toHaveBeenCalledTimes(3)
  })

  it("refuses external endpoint mutation and unsupported hosts", async () => {
    expect(canProjectOpenCodeV2Mcp(config, true)).toBe(true)
    expect(canProjectOpenCodeV2Mcp(config, false)).toBe(false)
    const remote = { ...config, process: undefined, network: { endpoint: "https://host" } }
    expect(canProjectOpenCodeV2Mcp(remote, true)).toBe(false)
    await expect(
      launchOpenCodeV2Service(remote, servers, undefined, undefined, setup().host)
    ).rejects.toThrow("existing")
    await expect(
      launchOpenCodeV2Service(config, servers, undefined, undefined, {
        ...setup().host,
        available: () => false,
      })
    ).rejects.toThrow("local")
  })

  it("kills a started service if cancellation races its ready response", async () => {
    const { host, invoke } = setup()
    const controller = new AbortController()
    invoke.mockImplementationOnce(async () => {
      controller.abort()
    })
    await expect(
      launchOpenCodeV2Service(config, servers, undefined, controller.signal, host)
    ).rejects.toMatchObject({ name: "AbortError" })
    expect(invoke).toHaveBeenCalledWith("kill_external_agent", expect.any(Object))
  })

  it("ignores unrelated process output and handles early native exit", async () => {
    const { host, invoke, callbacks, unlisten } = setup()
    invoke.mockImplementationOnce(async (_op, args) => {
      callbacks.get("external-agent://stdout")?.({
        agentId: "other",
        data: "server listening on http://127.0.0.1:1",
      })
      callbacks.get("external-agent://exit")?.({ agentId: "other", data: "" })
      callbacks.get("external-agent://exit")?.({ agentId: args.config.id, data: "" })
    })
    await expect(launchOpenCodeV2Service(config, [], undefined, undefined, host)).rejects.toThrow(
      "exited"
    )
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(unlisten).toHaveBeenCalledTimes(3)
  })

  it("bounds startup waiting and kills a process that never becomes ready", async () => {
    jest.useFakeTimers()
    try {
      const { host, invoke } = setup()
      invoke.mockImplementation(async () => undefined)
      const pending = launchOpenCodeV2Service(
        { ...config, process: { ...config.process!, startupTimeout: 10 } },
        [],
        undefined,
        undefined,
        host
      )
      const rejected = expect(pending).rejects.toThrow("timed out")
      await jest.advanceTimersByTimeAsync(10)
      await rejected
      expect(invoke).toHaveBeenCalledWith("kill_external_agent", expect.any(Object))
    } finally {
      jest.useRealTimers()
    }
  })

  it("accepts split stderr readiness, preserves stdio defaults and retries failed teardown", async () => {
    expect(
      openCodeV2McpConfig([
        { name: "local", command: "node", args: [] },
        { name: "remote", type: "http", url: "https://example.test/mcp" },
      ])
    ).toMatchObject({ local: { command: ["node"] }, remote: { oauth: false } })
    const { host, invoke, callbacks } = setup()
    invoke.mockImplementation(async (operation, args) => {
      if (operation === "spawn_external_agent") {
        callbacks.get("external-agent://stderr")?.({
          agentId: args.config.id,
          data: "server listening on ",
        })
        callbacks.get("external-agent://stderr")?.({
          agentId: args.config.id,
          data: "http://127.0.0.1:12345",
        })
        callbacks.get("external-agent://stdout")?.({ agentId: args.config.id, data: "ignored" })
      }
    })
    const service = await launchOpenCodeV2Service(
      { ...config, process: undefined },
      [],
      undefined,
      undefined,
      host
    )
    invoke.mockRejectedValueOnce(new Error("kill unavailable"))
    await expect(service.close()).rejects.toThrow("kill unavailable")
    await service.close()
    expect(
      invoke.mock.calls.filter(([operation]) => operation === "kill_external_agent")
    ).toHaveLength(2)
  })

  it("closes listeners after launch failure without exposing raw output", async () => {
    const { host, invoke, unlisten } = setup()
    invoke.mockRejectedValueOnce(new Error("spawn failed"))
    await expect(
      launchOpenCodeV2Service(config, servers, undefined, undefined, host)
    ).rejects.toThrow("spawn failed")
    expect(unlisten).toHaveBeenCalledTimes(3)
  })

  it.each(["not JSON", "[]", "null"])("rejects invalid inline config %s", async (content) => {
    await expect(
      launchOpenCodeV2Service(
        { ...config, process: { ...config.process!, env: { OPENCODE_CONFIG_CONTENT: content } } },
        servers,
        undefined,
        undefined,
        setup().host
      )
    ).rejects.toThrow("inline")
  })
})
