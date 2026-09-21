import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"

import { RPC_PROTOCOL_VERSION } from "@/packages/agent/src/protocol"

import { createAgentRpcServer, type AgentRpcServiceContext } from "./server"

describe("createAgentRpcServer", () => {
  it("enforces negotiation, validates params, and delegates only supported methods", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const responses: Record<string, unknown>[] = []
    const lines = createInterface({ input: output, crlfDelay: Infinity })
    lines.on("line", (line) => responses.push(JSON.parse(line) as Record<string, unknown>))
    const handle = jest.fn(async (method: string) => {
      if (method === "session/create") {
        return { sessionId: "session-1", spec: { runtime: "built-in" } }
      }
      return { ok: true }
    })
    const server = createAgentRpcServer({
      input,
      output,
      diagnostic: new PassThrough(),
      service: {
        methods: ["session/create"],
        capabilities: ["event-replay", "worker-dispatch-v1"],
        workerManifest: {
          manifestVersion: 1,
          runtime: "builtin",
          models: ["test-model"],
          hardCapabilities: ["filesystem.write"],
          maxActiveTurns: 1,
          credentialProfileRefs: ["credential:test"],
          workspaceBindingRefs: ["repository:project-1:repo-1"],
          taskWorkspace: { enabled: true },
          sandbox: { capabilities: ["filesystem.write"] },
          platform: { os: "linux", arch: "x64" },
        },
        handle,
        close: jest.fn(async () => undefined),
      },
      hostVersion: "0.1.0",
      runtimeVersion: "0.1.0",
      instanceId: "host-1",
    })
    const serving = server.serve()

    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/create", params: {} })}\n`
    )
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: {
          client: { name: "test", version: "0.1.0" },
          protocolVersions: [RPC_PROTOCOL_VERSION],
          capabilities: [],
          limits: {},
        },
      })}\n`
    )
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`)
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/state", params: {} })}\n`
    )
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "session/create", params: {} })}\n`
    )
    input.end()
    await serving
    await new Promise((resolve) => setImmediate(resolve))

    expect(responses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 1, error: expect.objectContaining({ code: -32000 }) }),
        expect.objectContaining({
          id: 2,
          result: expect.objectContaining({
            protocolVersion: 2,
            methods: ["initialize", "initialized", "shutdown", "session/create"],
            capabilities: ["event-replay", "worker-dispatch-v1"],
            workerManifest: expect.objectContaining({
              manifestVersion: 1,
              maxActiveTurns: 1,
            }),
          }),
        }),
        expect.objectContaining({ id: 3, error: expect.objectContaining({ code: -32006 }) }),
        expect.objectContaining({
          id: 4,
          result: { sessionId: "session-1", spec: { runtime: "built-in" } },
        }),
      ])
    )
    expect(handle).toHaveBeenCalledWith("session/create", {}, expect.any(Object))
    lines.close()
  })

  it("returns invalid_params without calling the service", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines = createInterface({ input: output, crlfDelay: Infinity })
    const responsePromise = new Promise<Record<string, unknown>>((resolve) => {
      lines.on("line", (line) => {
        const response = JSON.parse(line) as Record<string, unknown>
        if (response.id === 9) resolve(response)
      })
    })
    const handle = jest.fn()
    const server = createAgentRpcServer({
      input,
      output,
      diagnostic: new PassThrough(),
      service: {
        methods: ["session/state"],
        capabilities: [],
        handle,
        close: jest.fn(async () => undefined),
      },
      hostVersion: "0.1.0",
      runtimeVersion: "0.1.0",
      instanceId: "host-1",
    })
    const serving = server.serve()
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "initialize",
        params: {
          client: { name: "test", version: "0.1.0" },
          protocolVersions: [2],
          capabilities: [],
          limits: {},
        },
      })}\n`
    )
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`)
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "session/state", params: {} })}\n`
    )

    await expect(responsePromise).resolves.toMatchObject({
      id: 9,
      error: { code: -32602 },
    })
    expect(handle).not.toHaveBeenCalled()
    input.end()
    await serving
    lines.close()
  })

  it("dispatches a pipelined request while a slow one is still running", async () => {
    // `turn/run` holds its service call for a whole turn; a serialized read
    // loop would make mid-turn methods (steer/abort/followUp/state) dead code.
    // A fast request pipelined behind a slow one must answer out of order.
    const input = new PassThrough()
    const output = new PassThrough()
    const responses: Record<string, unknown>[] = []
    const lines = createInterface({ input: output, crlfDelay: Infinity })
    lines.on("line", (line) => responses.push(JSON.parse(line) as Record<string, unknown>))
    let releaseSlow!: () => void
    const slowDone = new Promise<void>((resolve) => {
      releaseSlow = resolve
    })
    const spec = { runtime: "built-in" }
    const handle = jest.fn(async (_method: string, params: { name?: string }) => {
      if (params.name === "slow") {
        await slowDone
        return { sessionId: "session-slow", spec }
      }
      return { sessionId: "session-fast", spec }
    })
    const server = createAgentRpcServer({
      input,
      output,
      diagnostic: new PassThrough(),
      service: {
        methods: ["session/create"],
        capabilities: [],
        handle,
        close: jest.fn(async () => undefined),
      },
      hostVersion: "0.1.0",
      runtimeVersion: "0.1.0",
      instanceId: "host-1",
    })
    const serving = server.serve()
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          client: { name: "test", version: "0.1.0" },
          protocolVersions: [2],
          capabilities: [],
          limits: {},
        },
      })}\n`
    )
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`)
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/create", params: { name: "slow" } })}\n`
    )
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "session/create", params: { name: "fast" } })}\n`
    )

    // The fast request answers while the slow one is still parked.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(responses).toContainEqual({
      jsonrpc: "2.0",
      id: 3,
      result: { sessionId: "session-fast", spec },
    })
    expect(responses).not.toContainEqual(expect.objectContaining({ id: 2 }))

    // Let the slow request land, then hang up — EOF must still flush the
    // response it is owed before close.
    releaseSlow()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(responses).toContainEqual({
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "session-slow", spec },
    })
    input.end()
    await serving
    lines.close()
  })

  it("EOF rejects unanswered client callbacks instead of hanging serve()", async () => {
    // A turn awaiting `client/tool/invoke` (no timeoutMs) when stdin closes can
    // never be answered — `close()` only ran after the in-flight drain, so the
    // pending callback kept `serve()` parked forever.
    const input = new PassThrough()
    const output = new PassThrough()
    const lines = createInterface({ input: output, crlfDelay: Infinity })
    const responses: Record<string, unknown>[] = []
    lines.on("line", (line) => responses.push(JSON.parse(line) as Record<string, unknown>))
    const close = jest.fn(async () => undefined)
    const handle = jest.fn(
      async (_method: string, _params: unknown, context: AgentRpcServiceContext) => {
        await context.requestClient("client/tool/invoke", {
          handlerId: "h1",
          toolCallId: "tc-1",
          sessionId: "s1",
          runId: "r1",
          attemptId: "a1",
          idempotencyKey: "k1",
          input: {},
        })
        return { ok: true }
      }
    )
    const server = createAgentRpcServer({
      input,
      output,
      diagnostic: new PassThrough(),
      service: { methods: ["turn/run"], capabilities: [], handle, close },
      hostVersion: "0.1.0",
      runtimeVersion: "0.1.0",
      instanceId: "host-1",
    })
    const serving = server.serve()
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          client: { name: "test", version: "0.1.0" },
          protocolVersions: [2],
          capabilities: [],
          limits: {},
        },
      })}\n`
    )
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`)
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "turn/run",
        params: { sessionId: "s1", input: "hi" },
      })}\n`
    )

    // The outbound callback request lands on the wire, then stdin closes —
    // the client can never answer it.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(responses).toContainEqual(
      expect.objectContaining({ id: expect.any(Number), method: "client/tool/invoke" })
    )
    input.end()

    // `serve()` resolves (no hang) and the stranded request fails with
    // callbackFailed (-32013) rather than staying silent.
    await serving
    expect(responses).toContainEqual(
      expect.objectContaining({
        id: 2,
        error: expect.objectContaining({ code: -32013 }),
      })
    )
    expect(close).toHaveBeenCalledTimes(1)
    lines.close()
  })

  it("acknowledges shutdown and closes the service without delegation", async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const lines = createInterface({ input: output, crlfDelay: Infinity })
    const responses: Record<string, unknown>[] = []
    lines.on("line", (line) => responses.push(JSON.parse(line) as Record<string, unknown>))
    const close = jest.fn(async () => undefined)
    const handle = jest.fn()
    const server = createAgentRpcServer({
      input,
      output,
      diagnostic: new PassThrough(),
      service: { methods: [], capabilities: [], handle, close },
      hostVersion: "0.1.0",
      runtimeVersion: "0.1.0",
      instanceId: "host-1",
    })
    const serving = server.serve()
    input.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          client: { name: "test", version: "0.1.0" },
          protocolVersions: [2],
          capabilities: [],
          limits: {},
        },
      })}\n`
    )
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} })}\n`)
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "shutdown", params: {} })}\n`)

    await serving
    await new Promise((resolve) => setImmediate(resolve))
    expect(responses).toContainEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } })
    expect(close).toHaveBeenCalledTimes(1)
    expect(handle).not.toHaveBeenCalled()
    lines.close()
  })
})
