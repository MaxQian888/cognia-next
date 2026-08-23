import { readFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { PassThrough } from "node:stream"

import { createCogniaClient, ProtocolLimitError } from "./client"
import { RPC_METHODS, RPC_PROTOCOL_VERSION } from "./rpc/protocol"

interface HarnessOptions {
  capabilities?: string[]
  limits?: Partial<Record<string, number>>
  entries?: Record<string, unknown>
  onRequest?: (request: Record<string, unknown>) => unknown
}

function createHost(options: HarnessOptions = {}) {
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
      switch (request.method) {
        case "initialize":
          result = {
            protocolVersion: RPC_PROTOCOL_VERSION,
            host: { name: "test-host", version: "0.1.0" },
            runtimeVersion: "0.1.0",
            instanceId: "host-1",
            methods: RPC_METHODS,
            capabilities: options.capabilities ?? [
              "sessions-v1",
              "event-replay-v2",
              "trace-unsubscribe-v1",
              "session-forest-v1",
            ],
            limits: {
              maxOpenSessions: 32,
              maxActiveTurns: 8,
              maxFrameBytes: 16 * 1024 * 1024,
              maxReplayEvents: 10_000,
              maxOutboundBufferBytes: 32 * 1024 * 1024,
              ...options.limits,
            },
          }
          break
        case "session/create":
          result = {
            sessionId: `session-${requests.filter((r) => r.method === "session/create").length}`,
            spec: { runtime: "built-in" },
          }
          break
        case "session/entries":
          result = options.entries ?? { entries: [] }
          break
        case "turn/run":
          result = { status: "completed", result: { status: "completed", text: "done" } }
          break
        case "session/tree":
          result = { roots: [{ sessionId: (request.params as { sessionId: string }).sessionId }] }
          break
        case "session/forest":
          result = { roots: [{ sessionId: "root-a" }, { sessionId: "root-b" }] }
          break
        case "trace/subscribe":
          result = { subscriptionId: "trace-1", redacted: true }
          break
        default:
          result = options.onRequest?.(request) ?? { ok: true, commandId: "command-1" }
      }
      hostToClient.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`)
    }
  })()

  return {
    streams: { readable: hostToClient, writable: clientToHost },
    requests,
    methods: () => requests.map((request) => request.method),
    notify(method: string, params: Record<string, unknown>) {
      hostToClient.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
    },
    close() {
      lines.close()
      hostToClient.end()
      clientToHost.end()
    },
  }
}

const envelope = (id: string) => ({ eventId: id, sequence: 0, event: { kind: "text-delta" } })

describe("client — ADR-0142 Phase 1 surfaces", () => {
  it("sends the real package version, not a hardcoded string", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const manifest = JSON.parse(readFileSync(`${__dirname}/../package.json`, "utf8")) as {
      version: string
      name: string
    }
    const initialize = host.requests.find((request) => request.method === "initialize")
    expect((initialize?.params as { client: { name: string; version: string } }).client).toEqual({
      name: manifest.name,
      version: manifest.version,
    })
    await client.close()
    host.close()
  })

  it("declares versioned client capabilities on initialize", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const initialize = host.requests.find((request) => request.method === "initialize")
    const declared = (initialize?.params as { capabilities: string[] }).capabilities
    expect(declared).toEqual(
      expect.arrayContaining(["client-tools-v1", "client-hooks-v1", "event-replay-v2"])
    )
    for (const capability of declared) expect(capability).toMatch(/-v\d+$/)
    await client.close()
    host.close()
  })

  it("exposes the negotiated limits and matches capabilities exactly", async () => {
    const host = createHost({ limits: { maxOpenSessions: 2 } })
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    expect(client.runtime.limits.maxOpenSessions).toBe(2)
    expect(client.runtime.supports("event-replay-v2")).toBe(true)
    expect(client.runtime.supports("event-replay-v1")).toBe(false)
    await client.close()
    host.close()
  })

  it("refuses to open more sessions than the host allows", async () => {
    const host = createHost({ limits: { maxOpenSessions: 1 } })
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    await client.sessions.create()
    await expect(client.sessions.create()).rejects.toBeInstanceOf(ProtocolLimitError)
    await client.close()
    host.close()
  })

  it("keeps session/tree scoped and routes the forest to its own method", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    await expect(client.sessions.tree("session-7")).resolves.toEqual([{ sessionId: "session-7" }])
    await expect(client.sessions.forest()).resolves.toEqual([
      { sessionId: "root-a" },
      { sessionId: "root-b" },
    ])
    expect(host.methods()).toContain("session/forest")
    await client.close()
    host.close()
  })

  it("rejects a turn carrying attachments before writing any frame", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const session = await client.sessions.create()
    await expect(
      session.run({ prompt: "look", attachments: [{ path: "/tmp/a.png" }] })
    ).rejects.toMatchObject({ code: "invalid_params" })
    expect(host.methods()).not.toContain("turn/run")
    await client.close()
    host.close()
  })

  it("starts a turn without blocking, so events and the result resolve together", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const session = await client.sessions.create()

    const run = await session.start("go")
    expect(run.commandId).toEqual(expect.any(String))
    expect(run.sessionId).toBe(session.id)

    const collected: string[] = []
    const consume = (async () => {
      for await (const event of run.events()) {
        collected.push(event.eventId)
        if (collected.length === 2) break
      }
    })()

    host.notify("agent/event", { sessionId: session.id, envelope: envelope("e1") })
    host.notify("agent/event", { sessionId: session.id, envelope: envelope("e2") })

    await consume
    await expect(run.result).resolves.toMatchObject({ status: "completed" })
    expect(collected).toEqual(["e1", "e2"])
    expect(run.cursor).toBe("e2")
    await client.close()
    host.close()
  })

  it("reads the head cursor once before the turn so the run stream is anchored", async () => {
    const host = createHost({ entries: { entries: [], headEventId: "head-9" } })
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const session = await client.sessions.create()
    const run = await session.start("go")
    expect(run.cursor).toBe("head-9")
    await run.result
    await client.close()
    host.close()
  })

  it("aborts a run through its handle", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const session = await client.sessions.create()
    const run = await session.start("go")
    await run.abort("operator cancelled")
    const abort = host.requests.find((request) => request.method === "turn/abort")
    expect(abort?.params).toMatchObject({ reason: "operator cancelled", sessionId: session.id })
    await run.result
    await client.close()
    host.close()
  })

  it("gives two session subscribers the same sequence", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const session = await client.sessions.create()

    const drain = async (stream: AsyncIterable<{ eventId: string }>) => {
      const out: string[] = []
      for await (const event of stream) {
        out.push(event.eventId)
        if (out.length === 3) break
      }
      return out
    }
    const first = drain(session.events())
    const second = drain(session.events())
    await new Promise((resolve) => setTimeout(resolve, 5))
    for (const id of ["a", "b", "c"]) {
      host.notify("agent/event", { sessionId: session.id, envelope: envelope(id) })
    }

    await expect(first).resolves.toEqual(["a", "b", "c"])
    await expect(second).resolves.toEqual(["a", "b", "c"])
    await client.close()
    host.close()
  })

  it("releases a trace subscription on the host when it is disposed", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const subscription = await client.traces.subscribe("session-1")
    expect(subscription.subscriptionId).toBe("trace-1")
    await subscription.unsubscribe()
    const released = host.requests.find((request) => request.method === "trace/unsubscribe")
    expect(released?.params).toEqual({ subscriptionId: "trace-1" })
    await client.close()
    host.close()
  })

  it("skips trace/unsubscribe against a host that does not declare it", async () => {
    const host = createHost({ capabilities: ["sessions-v1"] })
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const subscription = await client.traces.subscribe()
    await subscription.unsubscribe()
    expect(host.methods()).not.toContain("trace/unsubscribe")
    await client.close()
    host.close()
  })

  it("closes the trace stream when the subscription is disposed", async () => {
    const host = createHost()
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const subscription = await client.traces.subscribe()
    const iterator = subscription[Symbol.asyncIterator]()
    const pending = iterator.next()
    await subscription.unsubscribe()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await client.close()
    host.close()
  })

  it("caps a caller's entries limit at the negotiated replay ceiling", async () => {
    const host = createHost({ limits: { maxReplayEvents: 5 } })
    const client = await createCogniaClient({ host: { kind: "streams", ...host.streams } })
    const session = await client.sessions.create()
    await session.entries({ limit: 9_999 })
    const entries = host.requests.filter((request) => request.method === "session/entries")
    expect((entries.at(-1)?.params as { limit: number }).limit).toBe(5)
    await client.close()
    host.close()
  })
})
