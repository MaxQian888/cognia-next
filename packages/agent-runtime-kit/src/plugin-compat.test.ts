import {
  ExternalAgentAdapterContractError,
  ExternalAgentUnsupportedOperationError,
  supportsSessionModels,
} from "@cognia/agent-contracts/adapter"
import type {
  ExternalAgentEvent,
  ExternalAgentSession,
} from "@cognia/agent-contracts/external-agent"
import { adaptPluginProtocolAdapter } from "./plugin-compat"

function session(id: string): ExternalAgentSession {
  return {
    id,
    agentId: "a",
    status: "active",
    createdAt: new Date(0),
    lastActivityAt: new Date(0),
  } as ExternalAgentSession
}

/** The members a Python proxy forwards: nothing else. */
function minimal(events: ExternalAgentEvent[] = []) {
  let next = 0
  return {
    connect: jest.fn(async () => {}),
    disconnect: jest.fn(async () => {}),
    createSession: jest.fn(async () => session(`s${++next}`)),
    closeSession: jest.fn(async () => {}),
    prompt: jest.fn(async function* () {
      for (const event of events) yield event
    }),
  }
}

describe("adaptPluginProtocolAdapter", () => {
  it("refuses an adapter missing a member the host cannot stand in for", () => {
    const { prompt: _prompt, ...noPrompt } = minimal()
    expect(() => adaptPluginProtocolAdapter(noPrompt, "p:x")).toThrow(
      ExternalAgentAdapterContractError
    )
    expect(() => adaptPluginProtocolAdapter(noPrompt, "p:x")).toThrow(/prompt/)
    expect(() => adaptPluginProtocolAdapter(null, "p:x")).toThrow(ExternalAgentAdapterContractError)
  })

  it("supplies the protocol, connection state and session registry", async () => {
    const adapter = adaptPluginProtocolAdapter(minimal(), "plugin:agent")
    expect(adapter.protocol).toBe("plugin:agent")
    expect(adapter.isConnected()).toBe(false)
    await adapter.connect({ id: "c" } as never)
    expect(adapter.connectionStatus).toBe("connected")
    expect(await adapter.healthCheck()).toBe(true)
    const created = await adapter.createSession()
    expect(adapter.getSession(created.id)).toBe(created)
    expect(adapter.getSessions()).toEqual([created])
    await adapter.closeSession(created.id)
    expect(adapter.getSessions()).toEqual([])
    await adapter.disconnect()
    expect(adapter.isConnected()).toBe(false)
  })

  it("records a failed connect as an error state", async () => {
    const raw = minimal()
    raw.connect.mockRejectedValueOnce(new Error("no binary"))
    const adapter = adaptPluginProtocolAdapter(raw, "p:x")
    await expect(adapter.connect({ id: "c" } as never)).rejects.toThrow("no binary")
    expect(adapter.connectionStatus).toBe("error")
  })

  it("throws a typed error for cancel and permission answers the plugin cannot perform", async () => {
    const adapter = adaptPluginProtocolAdapter(minimal(), "p:x")
    await expect(adapter.cancel("s1")).rejects.toBeInstanceOf(
      ExternalAgentUnsupportedOperationError
    )
    await expect(
      adapter.respondToPermission("s1", { requestId: "r", granted: true } as never)
    ).rejects.toThrow(/permission responses/)
  })

  it("folds execute from prompt when the plugin has no execute", async () => {
    const adapter = adaptPluginProtocolAdapter(
      minimal([
        { type: "message_delta", sessionId: "s1", delta: { type: "text", text: "hi" } } as never,
        { type: "done", sessionId: "s1", success: true } as never,
      ]),
      "p:x"
    )
    const result = await adapter.execute("s1", { role: "user", content: "go" } as never)
    expect(result.success).toBe(true)
  })

  it("delegates to the plugin's own members when it has them", async () => {
    const raw = {
      ...minimal(),
      protocol: "ignored",
      cancel: jest.fn(async () => {}),
      getSessions: jest.fn(() => [session("own")]),
      getSession: jest.fn((id: string) => (id === "own" ? session("own") : undefined)),
      healthCheck: jest.fn(async () => false),
      execute: jest.fn(async () => ({ success: true }) as never),
    }
    const adapter = adaptPluginProtocolAdapter(raw, "p:x")
    expect(adapter.protocol).toBe("p:x")
    await adapter.cancel("own")
    expect(raw.cancel).toHaveBeenCalledWith("own")
    expect(adapter.getSessions().map((s) => s.id)).toEqual(["own"])
    expect(await adapter.healthCheck()).toBe(false)
    await adapter.execute("own", { role: "user", content: "x" } as never)
    expect(raw.execute).toHaveBeenCalled()
  })

  it("forgets sessions even when the plugin keeps its own registry and cannot forget", async () => {
    const raw = {
      ...minimal(),
      getSessions: () => [session("own")],
      getSession: () => session("own"),
    }
    const adapter = adaptPluginProtocolAdapter(raw, "p:x")
    adapter.forgetSessions?.()
    expect(adapter.getSessions()).toEqual([])
    expect(adapter.getSession("own")).toBeUndefined()
  })

  it("passes optional capabilities and semantics through so guards see the truth", () => {
    const semantics = {
      cancel: { scope: "turn", reconnectsAfterCancel: false },
      resume: "native",
      fork: "unsupported",
      approvals: "per-tool-call",
      processModel: "shared",
    } as const
    const withModels = adaptPluginProtocolAdapter(
      {
        ...minimal(),
        semantics,
        getSessionModels: () => ({ availableModels: [] }),
        setSessionModel: async () => {},
      },
      "p:x"
    )
    expect(withModels.semantics).toBe(semantics)
    expect(supportsSessionModels(withModels)).toBe(true)
    const plain = adaptPluginProtocolAdapter(minimal(), "p:x")
    expect(plain.semantics).toBeUndefined()
    expect(supportsSessionModels(plain)).toBe(false)
  })
})
