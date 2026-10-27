/** @jest-environment node */
import type { AgentFetch } from "@cognia/agent-contracts/host"
import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
} from "@cognia/agent-contracts/external-agent"
import { RovoDevAdapter } from "./client"
function setup(finish = true) {
  let stream!: ReadableStreamDefaultController<Uint8Array>
  const encoder = new TextEncoder(),
    close = jest.fn(async () => {})
  const push = (kind: string, data?: unknown) =>
    stream.enqueue(
      encoder.encode(
        `event: ${kind}\n${data === undefined ? "" : "data: " + JSON.stringify(data) + "\n"}\n`
      )
    )
  const fetch = jest.fn<ReturnType<AgentFetch>, Parameters<AgentFetch>>(async (url, init) => {
    const path = new URL(String(url)).pathname
    if (path === "/healthcheck") return Response.json({ status: "healthy" })
    if (path === "/v3/sessions/create")
      return new Response("{}", { headers: { "x-session-id": "native-s" } })
    if (path === "/v3/sessions/current_session")
      return Response.json({ id: "native-s", workspace_path: "/workspace" })
    if (path === "/v3/stream_chat")
      return new Response(
        new ReadableStream({
          start(c) {
            stream = c
            push("part_start", { part: { part_kind: "text", content: "hello" } })
            if (finish) {
              push("close")
              c.close()
            } else
              init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")), {
                once: true,
              })
          },
        })
      )
    if (path === "/v3/resume_tool_calls") {
      push("close")
      stream.close()
    }
    return Response.json({})
  })
  const gate = jest.fn(() => true),
    adapter = new RovoDevAdapter({
      fetch,
      outboundGate: gate,
      redactDiagnostic: (s) => s,
      approvalPolicy: () => null,
      launch: async () => ({
        endpoint: "http://127.0.0.1:1234",
        headers: { Authorization: "Bearer private-lease" },
        close,
      }),
    })
  const config = {
    id: "rovo",
    protocol: "rovo-http",
    transport: "http",
    process: { command: "acli", cwd: "/workspace" },
  } as ExternalAgentConfig
  return { adapter, config, fetch, close, gate, push, end: () => stream.close() }
}
const message = {
  id: "user",
  timestamp: new Date(),
  role: "user" as const,
  content: [{ type: "text" as const, text: "question" }],
}
async function collect(iterable: AsyncIterable<ExternalAgentEvent>) {
  const result: ExternalAgentEvent[] = []
  for await (const e of iterable) result.push(e)
  return result
}

describe("Rovo Dev native lifecycle", () => {
  it("creates/restores exact native sessions and completes only on native close", async () => {
    const s = setup()
    await s.adapter.connect(s.config)
    const session = await s.adapter.createSession()
    expect(session.id).toBe("native-s")
    const events = await collect(s.adapter.prompt(session.id, message))
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "message_delta", delta: { type: "text", text: "hello" } }),
        expect.objectContaining({ type: "done", success: true }),
      ])
    )
    expect(
      s.fetch.mock.calls.some(([url]) => String(url).includes("/v3/sessions/native-s/restore"))
    ).toBe(true)
    await s.adapter.disconnect()
    expect(s.close).toHaveBeenCalledTimes(1)
  })
  it("waits for all tool decisions before resuming native execution", async () => {
    const s = setup(false)
    await s.adapter.connect(s.config)
    const session = await s.adapter.createSession()
    const iterator = s.adapter.prompt(session.id, message)[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    s.push("on_call_tools_start", {
      parts: [
        { tool_call_id: "t1", tool_name: "edit", args: { path: "a" } },
        { tool_call_id: "t2", tool_name: "shell", args: {} },
      ],
      permissions: { t1: "ASK", t2: "ASK" },
    })
    const one = (await iterator.next()).value,
      two = (await iterator.next()).value
    expect(one).toMatchObject({ type: "permission_request" })
    expect(two).toMatchObject({ type: "permission_request" })
    await s.adapter.respondToPermission(session.id, { requestId: "t1", granted: true })
    expect(
      s.fetch.mock.calls.filter(([url]) => String(url).endsWith("/resume_tool_calls"))
    ).toHaveLength(0)
    await s.adapter.respondToPermission(session.id, { requestId: "t2", granted: false })
    const call = s.fetch.mock.calls.find(([url]) => String(url).endsWith("/resume_tool_calls"))!
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      decisions: [
        { tool_call_id: "t1", deny_message: null },
        { tool_call_id: "t2", deny_message: "Denied by Cognia permission policy" },
      ],
    })
    const rest: ExternalAgentEvent[] = []
    for (;;) {
      const e = await iterator.next()
      if (e.done) break
      rest.push(e.value)
    }
    expect(rest.at(-1)).toMatchObject({ type: "done", success: true })
    await s.adapter.disconnect()
  })
  it("fails truncated streams, cancels native execution and never sends blocked prompts", async () => {
    const s = setup(false)
    await s.adapter.connect(s.config)
    const session = await s.adapter.createSession()
    const iterator = s.adapter.prompt(session.id, message)[Symbol.asyncIterator]()
    await iterator.next()
    await iterator.next()
    s.end()
    const events: ExternalAgentEvent[] = []
    for (;;) {
      const e = await iterator.next()
      if (e.done) break
      events.push(e.value)
    }
    expect(events.at(-1)).toMatchObject({ type: "done", success: false })
    expect(s.fetch.mock.calls.some(([url]) => String(url).endsWith("/v3/cancel"))).toBe(true)
    s.gate.mockReturnValue(false)
    const before = s.fetch.mock.calls.length
    await expect(collect(s.adapter.prompt(session.id, message))).rejects.toThrow(/PII/)
    expect(s.fetch).toHaveBeenCalledTimes(before)
    await s.adapter.disconnect()
  })
})
