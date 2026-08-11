import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"

import { createCogniaClient, IncompatibleHostError } from "./client"
import { RPC_METHODS, RPC_PROTOCOL_VERSION } from "./rpc/protocol"

function createHostHarness(
  overrides: {
    protocolVersion?: number
    onRequest?: (request: Record<string, unknown>) => unknown
  } = {}
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
          protocolVersion: overrides.protocolVersion ?? RPC_PROTOCOL_VERSION,
          host: { name: "test-host", version: "0.1.0" },
          runtimeVersion: "0.1.0",
          instanceId: "host-1",
          methods: RPC_METHODS,
          capabilities: ["tools", "hooks", "event-replay"],
          limits: {
            maxOpenSessions: 32,
            maxActiveTurns: 8,
            maxFrameBytes: 16 * 1024 * 1024,
            maxReplayEvents: 10_000,
            maxOutboundBufferBytes: 32 * 1024 * 1024,
          },
        }
      } else if (request.method === "session/create") {
        result = { sessionId: "session-1", spec: { runtime: "built-in" } }
      } else if (request.method === "session/state" || request.method === "turn/wait") {
        result = { sessionId: "session-1", status: "idle", turnCount: 1 }
      } else if (request.method === "turn/run") {
        result = { status: "completed", result: { text: "done", status: "completed" } }
      } else if (request.method === "session/messages") {
        result = { messages: [{ turnId: "turn-1", role: "assistant" }] }
      } else if (request.method === "session/entries") {
        result = { entries: [], nextEventId: undefined }
      } else if (request.method === "session/export") {
        result = { sessionId: "session-1", turns: [] }
      } else {
        result = overrides.onRequest?.(request) ?? { ok: true, commandId: "command-1" }
      }

      hostToClient.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
    }
  })()

  return {
    streams: { readable: hostToClient, writable: clientToHost },
    requests,
    notify(method: string, params: Record<string, unknown>) {
      hostToClient.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
    },
    request(id: number, method: string, params: Record<string, unknown>) {
      hostToClient.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    },
    close() {
      lines.close()
      hostToClient.end()
      clientToHost.end()
    },
  }
}

describe("createCogniaClient", () => {
  it("negotiates v2 before exposing typed runtime and session APIs", async () => {
    const host = createHostHarness()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })

    const session = await client.sessions.create({ name: "test" })
    const outcome = await session.run("finish the task")

    expect(session.id).toBe("session-1")
    expect(session.spec).toEqual({ runtime: "built-in" })
    expect(outcome).toMatchObject({ status: "completed", result: { text: "done" } })
    expect(host.requests.map((request) => request.method).slice(0, 3)).toEqual([
      "initialize",
      "initialized",
      "session/create",
    ])

    await client.close()
    host.close()
  })

  it("fails during negotiation when the host selects an incompatible protocol", async () => {
    const host = createHostHarness({ protocolVersion: 1 })

    await expect(
      createCogniaClient({ host: { kind: "streams", ...host.streams } })
    ).rejects.toBeInstanceOf(IncompatibleHostError)

    host.close()
  })

  it("routes deduplicated session events to the async event stream", async () => {
    const host = createHostHarness()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const session = await client.sessions.create()
    const controller = new AbortController()
    const iterator = session.events({ signal: controller.signal })[Symbol.asyncIterator]()
    const envelope = { eventId: "event-1", sequence: 1, event: { kind: "text-delta" } }

    host.notify("agent/event", { sessionId: session.id, envelope })
    host.notify("agent/event", { sessionId: session.id, envelope })

    await expect(iterator.next()).resolves.toEqual({ done: false, value: envelope })
    controller.abort()
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })

    await client.close()
    host.close()
  })

  it("dispatches registered client tools for reverse RPC requests", async () => {
    const host = createHostHarness()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })

    await client.tools.register(
      {
        handlerId: "read-handler",
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object" },
        sideEffect: "none",
      },
      async (input) => ({ content: String((input as { path: string }).path) })
    )

    host.request(91, "client/tool/invoke", {
      handlerId: "read-handler",
      toolCallId: "tool-call-1",
      sessionId: "session-1",
      runId: "run-1",
      attemptId: "attempt-1",
      idempotencyKey: "idem-1",
      input: { path: "README.md" },
    })

    await new Promise((resolve) => setImmediate(resolve))
    const response = host.requests.find((request) => request.id === 91)
    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 91,
      result: { ok: true, output: { content: "README.md" } },
    })

    await client.close()
    host.close()
  })

  it("sends turn/abort when a run signal is cancelled", async () => {
    const host = createHostHarness()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const session = await client.sessions.create()
    const controller = new AbortController()
    controller.abort()

    await expect(session.run("cancel", { signal: controller.signal })).rejects.toMatchObject({
      code: -32007,
    })
    expect(host.requests.some((request) => request.method === "turn/abort")).toBe(true)

    await client.close()
    host.close()
  })

  it("exposes the complete typed control surface without raw RPC calls", async () => {
    const host = createHostHarness({
      onRequest(request) {
        if (request.method === "session/tree") return { roots: [] }
        if (request.method === "task/list") return { tasks: [] }
        if (request.method === "audit/query") return { entries: [] }
        if (request.method === "sandbox/status") return { enabled: true }
        if (request.method === "sandbox/snapshot") return { snapshotId: "snapshot-1" }
        if (request.method === "trace/subscribe") return { subscriptionId: "trace-1" }
        return { ok: true, commandId: "command-1" }
      },
    })
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const session = await client.sessions.create()

    await session.rename("renamed")
    await session.tag(["sdk"])
    await session.resolveExternalTool("external-1", { kind: "result", value: "done" })
    await session.tree()
    await session.sandboxStatus()
    const snapshot = await session.snapshot()
    await session.restoreSnapshot(snapshot.snapshotId)
    await client.auth.status()
    await client.mcp.configure([])
    await client.mcp.status()
    await client.plugins.reload()
    await client.skills.reload()
    await client.tasks.list(session.id)
    await client.tasks.stop("task-1")
    await client.tasks.background("task-1")
    const traceEvents = await client.traces.subscribe(session.id)
    const traceIterator = traceEvents[Symbol.asyncIterator]()
    host.notify("trace/event", { subscriptionId: "trace-1", span: { name: "agent.rpc.turn/run" } })
    await expect(traceIterator.next()).resolves.toEqual({
      done: false,
      value: { name: "agent.rpc.turn/run" },
    })
    await traceIterator.return?.()
    await client.traces.export({ sessionId: session.id, format: "json" })
    await client.audit.query({ sessionId: session.id })
    await session.delete()

    expect(host.requests.map((request) => request.method)).toEqual(
      expect.arrayContaining([
        "session/rename",
        "session/tag",
        "externalTool/respond",
        "sandbox/snapshot",
        "sandbox/restore",
        "mcp/configure",
        "task/background",
        "trace/export",
        "audit/query",
        "session/delete",
      ])
    )

    await client.close()
    host.close()
  })
})
