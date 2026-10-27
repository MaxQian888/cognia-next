import type { AgentProcessHost, AgentProcessOutputEvent } from "@cognia/agent-contracts/host"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import { OpenClaudeAdapter, type OpenClaudeDeps } from "./client"

function harness() {
  let stdout: ((event: AgentProcessOutputEvent) => void) | undefined
  const sends: Record<string, unknown>[] = []
  const emit = (id: string, data: unknown) =>
    stdout?.({ processId: id, data: Buffer.from(JSON.stringify(data) + "\n").toString("base64") })
  const processHost: AgentProcessHost = {
    available: true,
    spawn: jest.fn(async (spec) => spec.id),
    send: jest.fn(async (id, raw) => {
      const data = JSON.parse(raw) as Record<string, unknown>
      sends.push(data)
      if (data.type === "control_request")
        queueMicrotask(() =>
          emit(id, {
            type: "control_response",
            response: { subtype: "success", request_id: data.request_id, response: {} },
          })
        )
    }),
    kill: jest.fn(async () => undefined),
    commandExists: jest.fn(async () => true),
    onStdoutLine: async () => () => undefined,
    onStdoutRaw: async (cb) => {
      stdout = cb
      return () => {
        stdout = undefined
      }
    },
    onStderr: async () => () => undefined,
    onExit: async () => () => undefined,
  }
  const deps: OpenClaudeDeps = {
    processHost,
    resolveLaunchEnvironment: async (_config, env) => env,
    approvalPolicy: () => null,
    toolPreApproval: () => false,
    outboundGate: jest.fn(() => true),
    redactDiagnostic: (text) => text,
    logger: { info() {}, debug() {}, warn() {}, error() {} },
    permissionTimeoutMs: 30,
    cancelTimeoutMs: 30,
  }
  const adapter = new OpenClaudeAdapter(deps)
  const config = {
    id: "oc",
    name: "OpenClaude",
    enabled: true,
    protocol: "openclaude-cli",
    transport: "stdio",
    process: { command: "openclaude", cwd: "/work" },
  } as unknown as ExternalAgentConfig
  return {
    adapter,
    config,
    deps,
    processHost,
    sends,
    emit,
    raw: (id: string, raw: Uint8Array) =>
      stdout?.({ processId: id, data: Buffer.from(raw).toString("base64") }),
  }
}

describe("OpenClaude native stream-json", () => {
  it("does not expire a turn while its host approval is awaiting a person", async () => {
    const h = harness()
    h.deps.permissionTimeoutMs = 1000
    h.config.timeout = 20
    await h.adapter.connect(h.config)
    const session = await h.adapter.createSession({ cwd: "/work" })
    let answer: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      answer = resolve
    })
    const collecting = h.adapter.execute(
      session.id,
      {
        id: "waiting-for-person",
        role: "user",
        content: [{ type: "text", text: "inspect" }],
        timestamp: new Date(),
      },
      {
        onPermissionRequest: async (request) => {
          await waiting
          return { requestId: request.id, granted: false }
        },
      }
    )
    await Promise.resolve()
    const processId = (h.processHost.spawn as jest.Mock).mock.calls[0][0].id
    h.emit(processId, {
      type: "control_request",
      request_id: "wait",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        tool_use_id: "tool-wait",
        input: { command: "touch file" },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(
      h.sends.some((frame) => (frame.request as { subtype?: string })?.subtype === "interrupt")
    ).toBe(false)
    answer!()
    await new Promise((resolve) => setTimeout(resolve, 0))
    h.emit(processId, {
      type: "result",
      subtype: "success",
      session_id: session.id,
      result: "done",
    })
    expect(await collecting).toMatchObject({ success: true, finalResponse: "done" })
    await h.adapter.disconnect()
  })

  it("retains all native text blocks across assistant steps without replaying a snapshot", async () => {
    const h = harness()
    await h.adapter.connect(h.config)
    const session = await h.adapter.createSession({ cwd: "/work" })
    const collecting = h.adapter.execute(session.id, {
      id: "multiple-steps",
      role: "user",
      content: [{ type: "text", text: "inspect" }],
      timestamp: new Date(),
    })
    await Promise.resolve()
    const processId = (h.processHost.spawn as jest.Mock).mock.calls[0][0].id
    const first = {
      type: "assistant",
      message: {
        id: "m1",
        content: [
          { type: "text", text: "one" },
          { type: "text", text: "two" },
        ],
      },
    }
    h.emit(processId, first)
    h.emit(processId, first)
    h.emit(processId, {
      type: "assistant",
      message: { id: "m2", content: [{ type: "text", text: "three" }] },
    })
    h.emit(processId, {
      type: "result",
      subtype: "success",
      session_id: session.id,
      result: "three",
    })
    expect(await collecting).toMatchObject({ success: true, finalResponse: "onetwothree" })
    await h.adapter.disconnect()
  })

  it("streams a turn, answers permission, and resumes the exact native session", async () => {
    const h = harness()
    await h.adapter.connect(h.config)
    const session = await h.adapter.createSession({ cwd: "/work" })
    const collecting = h.adapter.execute(
      session.id,
      {
        id: "u1",
        role: "user",
        content: [{ type: "text", text: "inspect" }],
        timestamp: new Date(),
      },
      { onPermissionRequest: async (request) => ({ requestId: request.id, granted: false }) }
    )
    await Promise.resolve()
    const processId = (h.processHost.spawn as jest.Mock).mock.calls[0][0].id
    h.emit(processId, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
    })
    h.emit(processId, {
      type: "control_request",
      request_id: "p1",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm file" },
        tool_use_id: "t1",
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.sends).toContainEqual(
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          request_id: "p1",
          response: expect.objectContaining({ behavior: "deny" }),
        }),
      })
    )
    h.emit(processId, {
      type: "result",
      subtype: "success",
      session_id: session.id,
      result: "hello",
      usage: { input_tokens: 4, output_tokens: 2 },
    })
    expect(await collecting).toMatchObject({
      success: true,
      finalResponse: "hello",
      tokenUsage: { promptTokens: 4, completionTokens: 2 },
    })
    await h.adapter.closeSession(session.id)
    await h.adapter.resumeSession(session.id, { cwd: "/work" })
    expect((h.processHost.spawn as jest.Mock).mock.calls.at(-1)[0].args).toEqual(
      expect.arrayContaining(["--resume", session.id])
    )
    await h.adapter.disconnect()
  })

  it("blocks outbound PII before writing a user prompt", async () => {
    const h = harness()
    await h.adapter.connect(h.config)
    const session = await h.adapter.createSession({ cwd: "/work" })
    ;(h.deps.outboundGate as jest.Mock).mockReturnValue(false)
    const result = await h.adapter.execute(session.id, {
      id: "u2",
      role: "user",
      content: [{ type: "text", text: "private" }],
      timestamp: new Date(),
    })
    expect(result.success).toBe(false)
    expect(h.sends.some((frame) => frame.type === "user")).toBe(false)
    await h.adapter.disconnect()
  })

  it("rejects unsafe launch overrides and unsupported MCP channels before spawn", async () => {
    const h = harness()
    await expect(
      h.adapter.connect({
        ...h.config,
        process: { ...h.config.process!, args: ["--dangerously-skip-permissions"] },
      })
    ).rejects.toThrow("launch")
    await h.adapter.connect(h.config)
    await expect(
      h.adapter.createSession({
        cwd: "/work",
        mcpServers: [{ type: "acp", name: "tools", serverId: "x" } as never],
      })
    ).rejects.toThrow("MCP")
    expect(h.processHost.spawn).not.toHaveBeenCalled()
    await h.adapter.disconnect()
  })

  it("forces a PreToolUse callback even for tools native rules would allow", async () => {
    const h = harness()
    await h.adapter.connect(h.config)
    const session = await h.adapter.createSession({ cwd: "/work", permissionMode: "dontAsk" })
    expect(h.sends[0]).toMatchObject({
      request: { hooks: { PreToolUse: [{ hookCallbackIds: ["cognia-openclaude-pre-tool"] }] } },
    })
    const collecting = h.adapter.execute(session.id, {
      id: "u",
      role: "user",
      content: [{ type: "text", text: "read" }],
      timestamp: new Date(),
    })
    await Promise.resolve()
    const pid = (h.processHost.spawn as jest.Mock).mock.calls[0][0].id
    h.emit(pid, {
      type: "control_request",
      request_id: "pre",
      request: {
        subtype: "hook_callback",
        callback_id: "cognia-openclaude-pre-tool",
        input: {
          hook_event_name: "PreToolUse",
          tool_name: "Read",
          tool_input: { file_path: "/private" },
          tool_use_id: "read-1",
        },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.sends).toContainEqual(
      expect.objectContaining({
        type: "control_response",
        response: expect.objectContaining({
          request_id: "pre",
          response: { hookSpecificOutput: expect.objectContaining({ permissionDecision: "deny" }) },
        }),
      })
    )
    h.emit(pid, { type: "result", subtype: "success", session_id: session.id, result: "denied" })
    await collecting
    await h.adapter.disconnect()
  })

  it("decodes split UTF-8 safely and reconstructs tool input without duplicate tools", async () => {
    const h = harness()
    await h.adapter.connect(h.config)
    const session = await h.adapter.createSession({ cwd: "/work" })
    const collecting = h.adapter.execute(session.id, {
      id: "u",
      role: "user",
      content: [{ type: "text", text: "inspect" }],
      timestamp: new Date(),
    })
    await Promise.resolve()
    const pid = (h.processHost.spawn as jest.Mock).mock.calls[0][0].id
    const encoded = Buffer.from(
      JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "中文\u2028ok" } },
      }) + "\n"
    )
    const cut = encoded.indexOf(Buffer.from("中")) + 1
    h.raw(pid, encoded.subarray(0, cut))
    h.raw(pid, encoded.subarray(cut))
    h.emit(pid, {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "t", name: "Read", input: {} },
      },
    })
    for (const partial_json of ['{"file_', 'path":"a"}'])
      h.emit(pid, {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json },
        },
      })
    h.emit(pid, { type: "stream_event", event: { type: "content_block_stop", index: 1 } })
    h.emit(pid, {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "a" } }],
      },
    })
    h.emit(pid, {
      type: "result",
      subtype: "success",
      session_id: session.id,
      result: "中文\u2028ok",
    })
    const result = await collecting
    expect(result.finalResponse).toBe("中文\u2028ok")
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0].input).toEqual({ file_path: "a" })
    await h.adapter.disconnect()
  })

  it("routes native questions through validated host forms", async () => {
    const h = harness()
    await h.adapter.connect(h.config)
    const session = await h.adapter.createSession({ cwd: "/work" })
    const collecting = h.adapter.execute(
      session.id,
      { id: "u", role: "user", content: [{ type: "text", text: "choose" }], timestamp: new Date() },
      {
        onElicitationRequest: async (request) => ({
          requestId: request.id,
          action: "accept",
          content: { q0: "One" },
        }),
      }
    )
    await Promise.resolve()
    const pid = (h.processHost.spawn as jest.Mock).mock.calls[0][0].id
    h.emit(pid, {
      type: "control_request",
      request_id: "ask",
      request: {
        subtype: "can_use_tool",
        tool_name: "AskUserQuestion",
        tool_use_id: "q",
        input: {
          questions: [{ question: "Which?", options: [{ label: "One" }, { label: "Two" }] }],
        },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.sends).toContainEqual(
      expect.objectContaining({
        response: expect.objectContaining({
          request_id: "ask",
          response: expect.objectContaining({
            updatedInput: expect.objectContaining({ answers: { "Which?": "One" } }),
          }),
        }),
      })
    )
    h.emit(pid, { type: "result", subtype: "success", session_id: session.id, result: "One" })
    await collecting
    await h.adapter.disconnect()
  })

  it("does not call a cancellation successful until a terminal result arrives", async () => {
    const h = harness()
    await h.adapter.connect(h.config)
    const session = await h.adapter.createSession({ cwd: "/work" })
    const collecting = h.adapter.execute(session.id, {
      id: "u",
      role: "user",
      content: [{ type: "text", text: "wait" }],
      timestamp: new Date(),
    })
    await Promise.resolve()
    const cancelling = h.adapter.cancel(session.id)
    await expect(cancelling).rejects.toThrow("stop was not confirmed")
    expect(h.processHost.kill).toHaveBeenCalledTimes(1)
    expect((await collecting).success).toBe(false)
    await h.adapter.disconnect()
  })

  it("kills malformed transport and keeps parallel session output isolated", async () => {
    const h = harness()
    await h.adapter.connect(h.config)
    const a = await h.adapter.createSession({ cwd: "/work" }),
      b = await h.adapter.createSession({ cwd: "/work" })
    const message = {
      id: "u",
      role: "user" as const,
      content: [{ type: "text" as const, text: "inspect" }],
      timestamp: new Date(),
    }
    const first = h.adapter.execute(a.id, message),
      second = h.adapter.execute(b.id, message)
    await Promise.resolve()
    const calls = (h.processHost.spawn as jest.Mock).mock.calls
    h.raw(calls[0][0].id, Buffer.from("not json\n"))
    h.emit(calls[1][0].id, {
      type: "result",
      subtype: "success",
      session_id: b.id,
      result: "second",
    })
    expect((await first).success).toBe(false)
    expect(await second).toMatchObject({ success: true, finalResponse: "second" })
    await h.adapter.disconnect()
  })
})
