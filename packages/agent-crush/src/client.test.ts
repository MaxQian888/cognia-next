/** @jest-environment node */
import type { AgentFetch } from "@cognia/agent-contracts/host"
import type {
  ExternalAgentConfig,
  ExternalAgentEvent,
} from "@cognia/agent-contracts/external-agent"
import { CrushAdapter } from "./client"
function setup() {
  let controller!: ReadableStreamDefaultController<Uint8Array>,
    run = ""
  const close = jest.fn(async () => {}),
    order: string[] = [],
    gate = jest.fn(() => true)
  const push = (type: string, payload: unknown) =>
    controller.enqueue(
      new TextEncoder().encode(
        "data: " + JSON.stringify({ type, payload: { type: "created", payload } }) + "\n\n"
      )
    )
  const fetch = jest.fn<ReturnType<AgentFetch>, Parameters<AgentFetch>>(async (url, init) => {
    const path = new URL(String(url)).pathname
    order.push(path)
    if (path === "/v1/workspaces") return Response.json({ id: "w" })
    if (path.endsWith("/sessions")) return Response.json({ id: "s" })
    if (path.endsWith("/messages")) return Response.json([{ id: "old" }])
    if (path.endsWith("/events"))
      return new Response(
        new ReadableStream({
          start(c) {
            controller = c
            init?.signal?.addEventListener("abort", () => c.error(new Error("aborted")), {
              once: true,
            })
          },
        })
      )
    if (path.endsWith("/agent")) {
      run = JSON.parse(String(init?.body)).run_id
      push("message", {
        id: "old",
        session_id: "s",
        role: "assistant",
        parts: [{ type: "text", data: { text: "stale" } }],
      })
      push("permission_request", {
        id: "p",
        session_id: "native-child",
        tool_call_id: "t",
        tool_name: "edit",
        params: { path: "a" },
      })
    }
    if (path.endsWith("/permissions/grant")) {
      push("message", {
        id: "new",
        session_id: "s",
        role: "assistant",
        parts: [{ type: "text", data: { text: "answer" } }],
      })
      push("run_complete", { session_id: "s", run_id: "other", text: "wrong" })
      push("run_complete", { session_id: "s", run_id: run, message_id: "new", text: "answer" })
      controller.close()
    }
    return Response.json({})
  })
  const adapter = new CrushAdapter({
    fetch,
    outboundGate: gate,
    redactDiagnostic: (s) => s,
    approvalPolicy: () => null,
    launch: async () => ({ endpoint: "http://127.0.0.1:1234", close }),
  })
  const config = {
    id: "cr",
    protocol: "crush-http",
    transport: "http",
    process: { command: "crush", cwd: "/workspace" },
  } as ExternalAgentConfig
  return { adapter, config, fetch, order, gate, close }
}
const message = {
  id: "user",
  timestamp: new Date(),
  role: "user" as const,
  content: [{ type: "text" as const, text: "hello" }],
}
it("subscribes before prompt, ignores existing snapshots, gates native permission and owns completion", async () => {
  const s = setup()
  await s.adapter.connect(s.config)
  const session = await s.adapter.createSession()
  const events: ExternalAgentEvent[] = []
  for await (const e of s.adapter.prompt(session.id, message, { timeout: 50 })) {
    events.push(e)
    if (e.type === "permission_request" && e.request)
      await s.adapter.respondToPermission(session.id, {
        requestId: e.request.requestId!,
        granted: false,
      })
  }
  expect(s.order.indexOf("/v1/workspaces/w/events")).toBeLessThan(
    s.order.indexOf("/v1/workspaces/w/agent")
  )
  expect(
    events
      .filter((e) => e.type === "message_delta")
      .map((e) => e.delta?.text)
      .join("")
  ).toBe("answer")
  expect(events.filter((e) => e.type === "done")).toEqual([
    expect.objectContaining({ success: true }),
  ])
  expect(
    JSON.parse(
      String(
        s.fetch.mock.calls.find(([url]) => String(url).endsWith("/permissions/grant"))?.[1]?.body
      )
    ).permission.session_id
  ).toBe("native-child")
  expect(
    JSON.parse(
      String(
        s.fetch.mock.calls.find(([url]) => String(url).endsWith("/permissions/grant"))?.[1]?.body
      )
    ).action
  ).toBe("deny")
  await s.adapter.disconnect()
  expect(s.close).toHaveBeenCalledTimes(1)
})
it("refuses unsupported MCP and blocked instructions before creating a native workspace", async () => {
  const s = setup()
  await s.adapter.connect(s.config)
  await expect(
    s.adapter.createSession({ mcpServers: [{ name: "x", command: "x", args: [], env: [] }] })
  ).rejects.toThrow(/MCP/)
  expect(s.fetch).not.toHaveBeenCalled()
  s.gate.mockReturnValue(false)
  await expect(s.adapter.createSession({ systemPrompt: "secret" })).rejects.toThrow(/PII/)
  expect(s.fetch).not.toHaveBeenCalled()
})
