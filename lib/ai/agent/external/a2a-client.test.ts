import { A2aClientAdapter, mapA2aResult } from "./a2a-client"
import type { ExternalAgentConfig, ExternalAgentMessage } from "@/types/agent/external-agent"

// ── pure mapper ──────────────────────────────────────────────────────────────

describe("mapA2aResult", () => {
  it("maps A2A 1.0 response wrappers, ProtoJSON enums, and discriminator-free parts", () => {
    const ctx: { contextId: string; taskId?: string } = { contextId: "c1" }
    const { events, done } = mapA2aResult(
      {
        statusUpdate: {
          taskId: "t-v1",
          contextId: "c-v1",
          status: {
            state: "TASK_STATE_COMPLETED",
            message: { role: "ROLE_AGENT", parts: [{ text: "v1 done" }] },
          },
        },
      } as never,
      ctx
    )
    expect(done).toBe(true)
    expect(ctx).toEqual({ contextId: "c-v1", taskId: "t-v1" })
    expect(events[0]).toMatchObject({ type: "message_delta", delta: { text: "v1 done" } })
    expect(events.at(-1)).toMatchObject({ type: "done", success: true })
  })

  it("maps an A2A 1.0 artifactUpdate wrapper", () => {
    const { events, done } = mapA2aResult(
      {
        artifactUpdate: {
          taskId: "t-v1",
          contextId: "c-v1",
          artifact: {
            artifactId: "artifact-1",
            parts: [{ filename: "report.pdf", mediaType: "application/pdf", url: "https://x/r" }],
          },
        },
      } as never,
      { contextId: "c" }
    )
    expect(done).toBe(false)
    expect(events[0]).toMatchObject({
      type: "message_delta",
      delta: { text: "[file: report.pdf application/pdf (https://x/r)]" },
    })
  })

  it("maps a bare agent message to a text delta + done", () => {
    const ctx: { contextId: string; taskId?: string } = { contextId: "c1" }
    const { events, done } = mapA2aResult(
      { kind: "message", role: "agent", parts: [{ kind: "text", text: "hello" }], taskId: "t1" },
      ctx
    )
    expect(done).toBe(true)
    expect(events[0]).toMatchObject({ type: "message_delta", delta: { text: "hello" } })
    expect(events.at(-1)).toMatchObject({ type: "done", success: true })
    expect(ctx.taskId).toBe("t1")
  })

  it("maps a working status-update to progress (not done)", () => {
    const ctx: { contextId: string; taskId?: string } = { contextId: "c1" }
    const { events, done } = mapA2aResult(
      { kind: "status-update", taskId: "t1", status: { state: "working" } },
      ctx
    )
    expect(done).toBe(false)
    expect(events[0]).toMatchObject({ type: "progress" })
    expect(ctx.taskId).toBe("t1")
  })

  it("maps a completed task (with status message text) to delta + done", () => {
    const { events, done } = mapA2aResult(
      {
        kind: "task",
        id: "t2",
        status: { state: "completed", message: { parts: [{ kind: "text", text: "final" }] } },
        artifacts: [{ parts: [{ kind: "text", text: " art" }] }],
      },
      { contextId: "c1" }
    )
    expect(done).toBe(true)
    expect(
      events
        .filter((e) => e.type === "message_delta")
        .map((e) => (e as { delta: { text: string } }).delta.text)
    ).toEqual(["final", " art"])
    expect(events.at(-1)).toMatchObject({ type: "done", success: true })
  })

  it("maps failed / rejected to an error event", () => {
    for (const state of ["failed", "rejected"] as const) {
      const { events, done } = mapA2aResult(
        { kind: "status-update", taskId: "t", status: { state } },
        { contextId: "c" }
      )
      expect(done).toBe(true)
      expect(events.at(-1)).toMatchObject({ type: "error", code: state })
    }
  })

  it("treats auth-required as a resumable end-of-turn done, not an error", () => {
    const { events, done } = mapA2aResult(
      { kind: "status-update", taskId: "t", status: { state: "auth-required" } },
      { contextId: "c" }
    )
    expect(done).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "done", success: true, stopReason: "end_turn" })
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  it("renders file and data parts instead of dropping them", () => {
    const { events } = mapA2aResult(
      {
        kind: "message",
        role: "agent",
        parts: [
          { kind: "text", text: "see " },
          {
            kind: "file",
            file: { name: "report.pdf", mimeType: "application/pdf", uri: "https://x/r.pdf" },
          },
          { kind: "data", data: { score: 0.9 } },
        ],
      },
      { contextId: "c" }
    )
    const text = events
      .filter((e) => e.type === "message_delta")
      .map((e) => (e as { delta: { text: string } }).delta.text)
      .join("")
    expect(text).toContain("see ")
    expect(text).toContain("[file: report.pdf application/pdf (https://x/r.pdf)]")
    expect(text).toContain('"score": 0.9')
  })

  it("maps canceled to a non-success done", () => {
    const { events } = mapA2aResult(
      { kind: "status-update", taskId: "t", status: { state: "canceled" } },
      { contextId: "c" }
    )
    expect(events.at(-1)).toMatchObject({ type: "done", success: false })
  })

  it("treats input-required as an end-of-turn done", () => {
    const { events, done } = mapA2aResult(
      { kind: "status-update", taskId: "t", status: { state: "input-required" } },
      { contextId: "c" }
    )
    expect(done).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "done", success: true })
  })

  it("emits artifact-update text without ending the turn", () => {
    const { events, done } = mapA2aResult(
      {
        kind: "artifact-update",
        taskId: "t",
        artifact: { parts: [{ kind: "text", text: "chunk" }] },
      },
      { contextId: "c" }
    )
    expect(done).toBe(false)
    expect(events[0]).toMatchObject({ type: "message_delta", delta: { text: "chunk" } })
  })
})

// ── adapter (mocked fetch) ───────────────────────────────────────────────────

function cardResponse(streaming: boolean): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ name: "Remote", url: "https://x/rpc", capabilities: { streaming } }),
  } as unknown as Response
}

function v1CardResponse(streaming: boolean): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      name: "Remote v1",
      supportedInterfaces: [
        {
          url: "https://x/v1/rpc",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
          tenant: "tenant-1",
        },
      ],
      capabilities: { streaming },
    }),
  } as unknown as Response
}

function interfacesCardResponse(
  supportedInterfaces: Array<{
    url: string
    protocolBinding: string
    protocolVersion: string
    tenant?: string
  }>
): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ name: "Remote", supportedInterfaces, capabilities: {} }),
  } as unknown as Response
}

function makeConfig(): ExternalAgentConfig {
  return {
    id: "a2a-1",
    protocol: "a2a",
    transport: "http",
    network: { endpoint: "https://x", authMethod: "bearer", bearerToken: "tok" },
  } as ExternalAgentConfig
}

function userMessage(text: string): ExternalAgentMessage {
  return { id: "m1", role: "user", content: [{ type: "text", text }], timestamp: new Date() }
}

async function collect(it: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const e of it) out.push(e)
  return out
}

describe("A2aClientAdapter", () => {
  it("skips unsupported interfaces and negotiates a later supported JSON-RPC interface", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      interfacesCardResponse([
        {
          url: "https://x/v2/rpc",
          protocolBinding: "JSONRPC",
          protocolVersion: "2.0",
        },
        {
          url: "https://x/v1/rpc",
          protocolBinding: "JSONRPC",
          protocolVersion: "1.0",
        },
      ])
    )
    const a = new A2aClientAdapter({ fetchImpl })

    await a.connect(makeConfig())

    await a.createSession()
    expect(a.isConnected()).toBe(true)
  })

  it("rejects an Agent Card that only advertises unsupported JSON-RPC versions", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      interfacesCardResponse([
        {
          url: "https://x/v2/rpc",
          protocolBinding: "JSONRPC",
          protocolVersion: "2.0",
        },
      ])
    )
    const a = new A2aClientAdapter({ fetchImpl })

    await expect(a.connect(makeConfig())).rejects.toThrow(/supported JSON-RPC interface/i)
  })

  it("rejects an Agent Card that explicitly advertises no interfaces", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(interfacesCardResponse([]))
    const a = new A2aClientAdapter({ fetchImpl })

    await expect(a.connect(makeConfig())).rejects.toThrow(/supported JSON-RPC interface/i)
  })

  it("rejects a path-only local file instead of sending an invalid A2A 1.0 Part", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(v1CardResponse(false))
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    const message: ExternalAgentMessage = {
      id: "file-message",
      role: "user",
      timestamp: new Date(),
      content: [{ type: "file", path: "/work/report.pdf", mimeType: "application/pdf" }],
    }

    const events = (await collect(a.prompt(session.id, message))) as Array<{
      type: string
      error?: string
    }>

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.stringMatching(/file content or URL/i),
      })
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("sends a zero-byte A2A 1.0 file as an empty raw part", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(v1CardResponse(false))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { message: { role: "ROLE_AGENT", parts: [{ text: "ok" }] } },
        }),
      } as unknown as Response)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    const message: ExternalAgentMessage = {
      id: "empty-file",
      role: "user",
      timestamp: new Date(),
      content: [
        {
          type: "file",
          path: "empty.bin",
          content: "",
          encoding: "base64",
          mimeType: "application/octet-stream",
        },
      ],
    }

    await collect(a.prompt(session.id, message))

    const body = JSON.parse(fetchImpl.mock.calls[1][1].body as string)
    expect(body.params.message.parts).toEqual([
      { raw: "", filename: "empty.bin", mediaType: "application/octet-stream" },
    ])
  })

  it("reports an empty streaming response as an unsuccessful turn", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(v1CardResponse(true))
      .mockResolvedValueOnce({ ok: true, status: 200, body: stream } as unknown as Response)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()

    const events = (await collect(a.prompt(session.id, userMessage("stream")))) as Array<{
      type: string
      success?: boolean
    }>

    expect(events).toContainEqual(expect.objectContaining({ type: "error" }))
    expect(events.at(-1)).toMatchObject({ type: "done", success: false })
  })

  it("reports a still-working polled task after a dropped stream as unsuccessful", async () => {
    const firstStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ result: { kind: "status-update", taskId: "task-working", status: { state: "working" } } })}\n\n`
          )
        )
        controller.close()
      },
    })
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(cardResponse(true))
      .mockResolvedValueOnce({ ok: true, status: 200, body: firstStream } as unknown as Response)
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          result: { kind: "task", id: "task-working", status: { state: "working" } },
        }),
      } as unknown as Response)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()

    const events = (await collect(a.prompt(session.id, userMessage("stream")))) as Array<{
      type: string
      success?: boolean
    }>

    expect(events).toContainEqual(expect.objectContaining({ type: "error" }))
    expect(events.at(-1)).toMatchObject({ type: "done", success: false })
  })

  it("rejects an image part with neither URL nor content", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(v1CardResponse(false))
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    const message: ExternalAgentMessage = {
      id: "missing-image",
      role: "user",
      timestamp: new Date(),
      content: [
        {
          type: "image",
          source: { type: "base64", data: undefined as unknown as string, mediaType: "image/png" },
        },
      ],
    }

    const events = (await collect(a.prompt(session.id, message))) as Array<{ type: string }>

    expect(events).toContainEqual(expect.objectContaining({ type: "error" }))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("blocks PII-bearing messages before the A2A network request", async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(v1CardResponse(false))
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()

    const events = (await collect(
      a.prompt(session.id, userMessage("Contact alice@example.com"))
    )) as Array<{ type: string; error?: string }>

    expect(events).toContainEqual(
      expect.objectContaining({ type: "error", error: expect.stringMatching(/PII gate/i) })
    )
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("negotiates A2A 1.0 from the Agent Card and sends its canonical JSON-RPC shape", async () => {
    const card = v1CardResponse(false)
    const sendRes = {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        result: {
          message: { messageId: "reply", role: "ROLE_AGENT", parts: [{ text: "v1 reply" }] },
        },
      }),
    } as unknown as Response
    const fetchImpl = jest.fn().mockResolvedValueOnce(card).mockResolvedValueOnce(sendRes)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    const events = (await collect(a.prompt(session.id, userMessage("hello")))) as Array<{
      type: string
    }>

    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(url).toBe("https://x/v1/rpc")
    expect(init.headers).toMatchObject({ "A2A-Version": "1.0" })
    expect(body).toMatchObject({
      method: "SendMessage",
      params: {
        tenant: "tenant-1",
        message: { role: "ROLE_USER", parts: [{ text: "hello" }] },
      },
    })
    expect(events[0]).toMatchObject({ type: "message_delta", delta: { text: "v1 reply" } })
    expect(events.at(-1)).toMatchObject({ type: "done", success: true })
  })

  it("uses A2A 1.0 streaming and cancellation method names", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({
              result: {
                statusUpdate: {
                  taskId: "task-v1",
                  contextId: "context-v1",
                  status: { state: "TASK_STATE_COMPLETED" },
                },
              },
            })}\n\n`
          )
        )
        controller.close()
      },
    })
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(v1CardResponse(true))
      .mockResolvedValueOnce({ ok: true, status: 200, body: stream } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ result: { task: { id: "task-v1" } } }),
      } as unknown as Response)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    await collect(a.prompt(session.id, userMessage("stream")))
    await a.cancel(session.id)

    const streamBody = JSON.parse(fetchImpl.mock.calls[1][1].body as string)
    const cancelBody = JSON.parse(fetchImpl.mock.calls[2][1].body as string)
    expect(streamBody.method).toBe("SendStreamingMessage")
    expect(cancelBody).toMatchObject({
      method: "CancelTask",
      params: { tenant: "tenant-1", id: "task-v1" },
    })
  })

  it("parses CRLF-delimited SSE events split across chunks", async () => {
    const payload = JSON.stringify({
      result: {
        statusUpdate: {
          taskId: "task-crlf",
          contextId: "context-crlf",
          status: {
            state: "TASK_STATE_COMPLETED",
            message: {
              messageId: "message-crlf",
              role: "ROLE_AGENT",
              parts: [{ text: "parsed CRLF event" }],
            },
          },
        },
      },
    })
    const bytes = new TextEncoder().encode(`data: ${payload}\r\n\r\n`)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, bytes.length - 3))
        controller.enqueue(bytes.slice(bytes.length - 3))
        controller.close()
      },
    })
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(v1CardResponse(true))
      .mockResolvedValueOnce({ ok: true, status: 200, body: stream } as unknown as Response)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()

    const events = (await collect(a.prompt(session.id, userMessage("stream")))) as Array<{
      type: string
    }>

    expect(events).toContainEqual(
      expect.objectContaining({
        type: "message_delta",
        delta: { type: "text", text: "parsed CRLF event" },
      })
    )
    expect(events.at(-1)).toMatchObject({ type: "done", success: true })
  })

  it("connects by fetching the agent card and reflects streaming capability", async () => {
    const fetchImpl = jest.fn().mockResolvedValue(cardResponse(true))
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    expect(a.isConnected()).toBe(true)
    expect(a.capabilities).toMatchObject({ streaming: true })
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://x/.well-known/agent-card.json",
      expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer tok" }) })
    )
  })

  it("degrades to connected (non-streaming) when the card is unreachable", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 404 } as Response)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    expect(a.isConnected()).toBe(true)
    expect(a.capabilities).toBeUndefined()
  })

  it("throws when network.endpoint is missing", async () => {
    const a = new A2aClientAdapter({ fetchImpl: jest.fn() })
    await expect(
      a.connect({ id: "x", protocol: "a2a", transport: "http" } as ExternalAgentConfig)
    ).rejects.toThrow(/network.endpoint/)
  })

  it("streams a prompt over message/stream and yields mapped events", async () => {
    const card = cardResponse(true)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder()
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ result: { kind: "status-update", taskId: "t", status: { state: "working" } } })}\n\n`
          )
        )
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({ result: { kind: "message", role: "agent", parts: [{ kind: "text", text: "hi" }] } })}\n\n`
          )
        )
        controller.close()
      },
    })
    const streamRes = { ok: true, status: 200, body: stream } as unknown as Response
    const fetchImpl = jest.fn().mockResolvedValueOnce(card).mockResolvedValueOnce(streamRes)

    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    const events = (await collect(a.prompt(session.id, userMessage("yo")))) as Array<{
      type: string
    }>
    expect(events.some((e) => e.type === "progress")).toBe(true)
    expect(events.some((e) => e.type === "message_delta")).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "done", success: true })
    // The stream POST targeted the card url with the SSE Accept header.
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "https://x/rpc",
      expect.objectContaining({ headers: expect.objectContaining({ accept: "text/event-stream" }) })
    )
  })

  it("falls back to message/send when the agent does not stream", async () => {
    const card = cardResponse(false)
    const sendRes = {
      ok: true,
      status: 200,
      json: async () => ({
        result: { kind: "message", role: "agent", parts: [{ kind: "text", text: "done" }] },
      }),
    } as unknown as Response
    const fetchImpl = jest.fn().mockResolvedValueOnce(card).mockResolvedValueOnce(sendRes)

    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    const events = (await collect(a.prompt(session.id, userMessage("yo")))) as Array<{
      type: string
    }>
    expect(events.some((e) => e.type === "message_delta")).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "done", success: true })
  })

  it("surfaces an HTTP failure as an error event", async () => {
    const card = cardResponse(true)
    const fail = { ok: false, status: 500, body: null } as unknown as Response
    const fetchImpl = jest.fn().mockResolvedValueOnce(card).mockResolvedValueOnce(fail)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    const events = (await collect(a.prompt(session.id, userMessage("x")))) as Array<{
      type: string
    }>
    expect(events.at(-1)).toMatchObject({ type: "error" })
  })

  it("surfaces a JSON-RPC error body (HTTP 200) as an error event", async () => {
    const card = cardResponse(false) // non-streaming → message/send path
    const rpcErr = {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "Task not found" },
      }),
    } as unknown as Response
    const fetchImpl = jest.fn().mockResolvedValueOnce(card).mockResolvedValueOnce(rpcErr)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    const events = (await collect(a.prompt(session.id, userMessage("x")))) as Array<{
      type: string
      error?: string
    }>
    const err = events.find((e) => e.type === "error")
    expect(err).toBeDefined()
    expect(err?.error).toContain("-32001")
    expect(err?.error).toContain("Task not found")
  })

  it("surfaces a JSON-RPC error frame inside the SSE stream", async () => {
    const card = cardResponse(true)
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "boom" } })}\n\n`
          )
        )
        c.close()
      },
    })
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(card)
      .mockResolvedValueOnce({ ok: true, status: 200, body: stream } as unknown as Response)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    const events = (await collect(a.prompt(session.id, userMessage("x")))) as Array<{
      type: string
      error?: string
    }>
    expect(events.some((e) => e.type === "error" && e.error?.includes("-32603"))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: "done", success: false })
  })

  it("recovers a dropped stream via tasks/resubscribe", async () => {
    const card = cardResponse(true)
    // First stream: a working status-update assigns a taskId, then it drops
    // with no terminal event.
    const firstStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ result: { kind: "status-update", taskId: "task-7", status: { state: "working" } } })}\n\n`
          )
        )
        c.close()
      },
    })
    // Resubscribe stream: delivers the completion.
    const resubStream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ result: { kind: "status-update", taskId: "task-7", status: { state: "completed", message: { parts: [{ kind: "text", text: "resumed" }] } } } })}\n\n`
          )
        )
        c.close()
      },
    })
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(card)
      .mockResolvedValueOnce({ ok: true, status: 200, body: firstStream } as unknown as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, body: resubStream } as unknown as Response)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    const events = (await collect(a.prompt(session.id, userMessage("x")))) as Array<{
      type: string
    }>
    // The resubscribe POST was issued for the dropped task.
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://x/rpc",
      expect.objectContaining({ body: expect.stringContaining("tasks/resubscribe") })
    )
    expect(events.at(-1)).toMatchObject({ type: "done", success: true })
  })

  it("sends image content as an A2A file part", async () => {
    const card = cardResponse(false)
    const sendRes = {
      ok: true,
      status: 200,
      json: async () => ({
        result: { kind: "message", role: "agent", parts: [{ kind: "text", text: "ok" }] },
      }),
    } as unknown as Response
    const fetchImpl = jest.fn().mockResolvedValueOnce(card).mockResolvedValueOnce(sendRes)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    const msg: ExternalAgentMessage = {
      id: "m",
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: { type: "url", url: "https://x/i.png", mediaType: "image/png" } },
      ],
      timestamp: new Date(),
    }
    await collect(a.prompt(session.id, msg))
    const body = JSON.parse(fetchImpl.mock.calls[1][1].body as string)
    const parts = body.params.message.parts as Array<{ kind: string; file?: { uri?: string } }>
    expect(parts.some((p) => p.kind === "file" && p.file?.uri === "https://x/i.png")).toBe(true)
  })

  it("falls back to the legacy /.well-known/agent.json card path", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 404 } as Response) // agent-card.json
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          name: "Legacy",
          url: "https://x/rpc",
          capabilities: { streaming: true },
        }),
      } as unknown as Response) // agent.json
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    expect(a.capabilities).toMatchObject({ streaming: true })
    expect(fetchImpl).toHaveBeenCalledWith("https://x/.well-known/agent.json", expect.anything())
  })

  it("cancels via tasks/cancel using the session's taskId", async () => {
    const card = cardResponse(true)
    const fetchImpl = jest.fn().mockResolvedValueOnce(card)
    const a = new A2aClientAdapter({ fetchImpl })
    await a.connect(makeConfig())
    const session = await a.createSession()
    // Prime a taskId through the mapper by streaming one status-update.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ result: { kind: "status-update", taskId: "task-9", status: { state: "completed" } } })}\n\n`
          )
        )
        c.close()
      },
    })
    fetchImpl.mockResolvedValueOnce({ ok: true, status: 200, body: stream } as unknown as Response)
    await collect(a.prompt(session.id, userMessage("x")))
    fetchImpl.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response)
    await a.cancel(session.id)
    expect(fetchImpl).toHaveBeenLastCalledWith(
      "https://x/rpc",
      expect.objectContaining({ body: expect.stringContaining("tasks/cancel") })
    )
  })
})
