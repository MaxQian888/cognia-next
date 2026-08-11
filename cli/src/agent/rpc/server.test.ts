import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"

import { RPC_PROTOCOL_VERSION } from "@/packages/agent/src/protocol"

import { createAgentRpcServer } from "./server"

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
        capabilities: ["event-replay"],
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
