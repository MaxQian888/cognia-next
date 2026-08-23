import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"

import { HostConnection, isTransportFailure } from "./connection"
import { ConnectionLostError, ReconnectFailedError, RpcError } from "./errors"
import { RPC_METHODS, RPC_PROTOCOL_VERSION } from "./rpc/protocol"

/** One host process. `kill()` drops the transport the way a crash would. */
function spawnFakeHost(
  options: { onRequest?: (request: Record<string, unknown>) => unknown } = {}
) {
  const hostToClient = new PassThrough()
  const clientToHost = new PassThrough()
  const requests: Record<string, unknown>[] = []
  const lines = createInterface({ input: clientToHost, crlfDelay: Infinity })

  void (async () => {
    for await (const line of lines) {
      const request = JSON.parse(line) as Record<string, unknown>
      requests.push(request)
      if (request.id === undefined) continue
      let result: unknown
      if (request.method === "initialize") {
        result = {
          protocolVersion: RPC_PROTOCOL_VERSION,
          host: { name: "test-host", version: "0.1.0" },
          runtimeVersion: "0.1.0",
          instanceId: "host-1",
          methods: RPC_METHODS,
          capabilities: ["sessions-v1"],
          limits: {},
        }
      } else if (request.method === "session/open") {
        result = { sessionId: (request.params as { sessionId: string }).sessionId, spec: {} }
      } else if (request.method === "session/list") {
        result = { sessions: [] }
      } else if (request.method === "model/list" || request.method === "model/refresh") {
        result = { models: [] }
      } else {
        result = options.onRequest?.(request) ?? { ok: true }
      }
      hostToClient.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
    }
  })()

  return {
    streams: { readable: hostToClient, writable: clientToHost },
    requests,
    methods: () => requests.map((request) => request.method),
    kill() {
      lines.close()
      hostToClient.destroy()
      clientToHost.destroy()
    },
  }
}

/** Let a killed transport's close event propagate to the peer. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function silentHooks(overrides: Partial<Parameters<typeof HostConnection.open>[0]["hooks"]> = {}) {
  return {
    onAgentEvent: () => {},
    onTraceEvent: () => {},
    onDiagnostic: () => {},
    invokeTool: async () => ({ ok: true }),
    invokeHook: async () => ({ ok: true }),
    onReattach: async () => {},
    onGiveUp: () => {},
    ...overrides,
  }
}

describe("HostConnection", () => {
  it("reconnects a stream host through its factory and re-establishes registrations", async () => {
    const hosts = [spawnFakeHost(), spawnFakeHost()]
    let index = 0
    const reattached: number[] = []

    const connection = await HostConnection.open({
      host: {
        kind: "streams",
        ...hosts[0]!.streams,
        factory: () => hosts[Math.min(++index, hosts.length - 1)]!.streams,
      },
      requestTimeoutMs: 1_000,
      sleep: async () => {},
      hooks: silentHooks({
        onReattach: async () => {
          reattached.push(1)
        },
      }),
    })

    await connection.call("runtime/status", {}, { timeoutMs: 500 })
    hosts[0]!.kill()
    await settle()

    // A read survives the drop by being retried on the fresh transport.
    await expect(connection.call("session/list", {}, { timeoutMs: 500 })).resolves.toBeDefined()
    expect(reattached).toHaveLength(1)
    expect(hosts[1]!.methods()).toContain("initialize")
    expect(hosts[1]!.methods()).toContain("session/list")
    await connection.close()
  })

  it("never re-sends a command whose outcome it does not know", async () => {
    const hosts = [spawnFakeHost(), spawnFakeHost()]
    let index = 0
    const connection = await HostConnection.open({
      host: {
        kind: "streams",
        ...hosts[0]!.streams,
        factory: () => hosts[Math.min(++index, hosts.length - 1)]!.streams,
      },
      requestTimeoutMs: 1_000,
      sleep: async () => {},
      hooks: silentHooks(),
    })

    hosts[0]!.kill()
    await settle()
    await expect(
      connection.call(
        "turn/run",
        { sessionId: "s1", input: "go", commandId: "cmd-42" },
        { timeoutMs: 500 }
      )
    ).rejects.toMatchObject({
      code: "indeterminate_command",
      commandId: "cmd-42",
      method: "turn/run",
      sessionId: "s1",
    })
    // Reconnected, but the turn was not replayed onto the new host.
    expect(hosts[1]!.methods()).toContain("initialize")
    expect(hosts[1]!.methods()).not.toContain("turn/run")
    await connection.close()
  })

  it("gives up after the attempt budget and reports it once", async () => {
    const host = spawnFakeHost()
    const failures: Error[] = []
    const connection = await HostConnection.open({
      host: {
        kind: "streams",
        ...host.streams,
        factory: () => {
          throw new Error("host will not start")
        },
      },
      requestTimeoutMs: 500,
      reconnect: { maxAttempts: 3 },
      sleep: async () => {},
      hooks: silentHooks({
        onGiveUp: (error) => {
          failures.push(error)
        },
      }),
    })

    host.kill()
    await settle()
    await expect(connection.call("session/list", {}, { timeoutMs: 300 })).rejects.toBeDefined()
    expect(failures).toHaveLength(1)
    expect(failures[0]).toBeInstanceOf(ReconnectFailedError)
    expect((failures[0] as ReconnectFailedError).attempts).toBe(3)
  })

  it("does not reconnect an injected stream host that has no factory", async () => {
    const host = spawnFakeHost()
    const connection = await HostConnection.open({
      host: { kind: "streams", ...host.streams },
      requestTimeoutMs: 500,
      sleep: async () => {},
      hooks: silentHooks(),
    })
    expect(connection.reconnectEnabled).toBe(false)
    host.kill()
    await settle()
    await expect(connection.call("session/list", {}, { timeoutMs: 300 })).rejects.toBeInstanceOf(
      ConnectionLostError
    )
  })

  it("runs exactly one reconnect for concurrent callers that hit the same drop", async () => {
    const hosts = [spawnFakeHost(), spawnFakeHost()]
    let index = 0
    let handshakes = 0
    const connection = await HostConnection.open({
      host: {
        kind: "streams",
        ...hosts[0]!.streams,
        factory: () => {
          handshakes += 1
          return hosts[Math.min(++index, hosts.length - 1)]!.streams
        },
      },
      requestTimeoutMs: 1_000,
      sleep: async () => {},
      hooks: silentHooks(),
    })

    hosts[0]!.kill()
    await settle()
    await Promise.all([
      connection.call("session/list", {}, { timeoutMs: 500 }),
      connection.call("runtime/status", {}, { timeoutMs: 500 }),
      connection.call("model/list", {}, { timeoutMs: 500 }).catch(() => undefined),
    ])
    expect(handshakes).toBe(1)
    await connection.close()
  })

  it("applies the host's negotiated limits rather than storing them unused", async () => {
    const host = spawnFakeHost()
    const connection = await HostConnection.open({
      host: { kind: "streams", ...host.streams },
      requestTimeoutMs: 500,
      hooks: silentHooks(),
    })
    // Host answered with `limits: {}`; the defaults are what gets enforced.
    expect(connection.negotiatedLimits.maxOpenSessions).toBeGreaterThan(0)
    expect(connection.negotiatedLimits.maxFrameBytes).toBeGreaterThan(0)
    await connection.close()
  })

  it("classifies only transport deaths as recoverable", () => {
    expect(isTransportFailure(new ConnectionLostError())).toBe(true)
    expect(isTransportFailure(Object.assign(new Error("broken"), { code: "EPIPE" }))).toBe(true)
    expect(isTransportFailure(new RpcError(-32002, "session not found"))).toBe(false)
    expect(isTransportFailure(new Error("plain"))).toBe(false)
    expect(isTransportFailure("nope")).toBe(false)
  })
})
