import { OmpHostRequests } from "./host-requests"
import type { AcpElicitationResponse } from "@cognia/agent-contracts/external-agent"
import type { HostToolCallRequest, OmpServerFrame, RpcInbound } from "./wire"
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
function setup(extra: Partial<ConstructorParameters<typeof OmpHostRequests>[0]> = {}) {
  const send = jest.fn(async (_frame: RpcInbound) => {})
  const emit = jest.fn()
  const fatal = jest.fn()
  const helper = new OmpHostRequests({ sessionId: "s", send, emit, fatal, ...extra })
  return { helper, send, emit, fatal }
}
const toolFrame: HostToolCallRequest = {
  type: "host_tool_call",
  id: "native",
  toolCallId: "t",
  toolName: "read",
  arguments: {},
}
describe("OMP host requests", () => {
  it("denies missing tool and URI handlers with explicit correlated results", async () => {
    const { helper, send } = setup()
    expect(helper.handle(toolFrame)).toBe(true)
    helper.handle({ type: "host_uri_request", id: "u", operation: "read", url: "host://a" })
    await tick()
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "host_tool_result", id: "native", isError: true })
    )
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ type: "host_uri_result", id: "u", isError: true })
    )
    helper.dispose()
  })
  it("streams and returns callback results", async () => {
    const { helper, send } = setup({
      tool: async (_r, _signal, update) => {
        await update({ content: [{ type: "text", text: "part" }] })
        return { content: [{ type: "text", text: "done" }] }
      },
    })
    helper.handle(toolFrame)
    await tick()
    expect(send.mock.calls[0][0]).toMatchObject({
      type: "host_tool_update",
      partialResult: { content: [{ text: "part" }] },
    })
    expect(send.mock.calls[1][0]).toMatchObject({
      type: "host_tool_result",
      result: { content: [{ text: "done" }] },
    })
    helper.dispose()
  })
  it("aborts canceled callbacks and ignores their eventual result", async () => {
    let signal: AbortSignal | undefined
    let resolve!: (value: { content: [] }) => void
    const { helper, send } = setup({
      tool: (_r, s) => {
        signal = s
        return new Promise((r) => {
          resolve = r
        })
      },
    })
    helper.handle(toolFrame)
    await tick()
    helper.handle({ type: "host_tool_cancel", id: "cancel", targetId: "native" })
    expect(signal?.aborted).toBe(true)
    resolve({ content: [] })
    await tick()
    expect(send).not.toHaveBeenCalled()
    helper.dispose()
  })
  it("times out callbacks once and redacts thrown errors", async () => {
    jest.useFakeTimers()
    const { helper, send } = setup({ timeoutMs: 10, tool: () => new Promise(() => {}) })
    helper.handle(toolFrame)
    await jest.advanceTimersByTimeAsync(11)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ isError: true }))
    helper.dispose()
    jest.useRealTimers()
    const failed = setup({
      tool: async () => {
        throw new Error("api_key=secret")
      },
    })
    failed.helper.handle(toolFrame)
    await tick()
    expect(JSON.stringify(failed.send.mock.calls)).not.toContain("secret")
    failed.helper.dispose()
  })
  it("scopes UI ids and validates native select answers before sending", async () => {
    const { helper, emit, send } = setup()
    helper.handle({
      type: "extension_ui_request",
      id: "q",
      method: "select",
      title: "Pick",
      options: ["A", "B"],
    })
    const requestId = emit.mock.calls[0][0].request.id as string
    expect(requestId).not.toBe("q")
    await expect(
      helper.respond({ requestId, action: "accept", content: { select: "C" } })
    ).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
    await helper.respond({ requestId, action: "accept", content: { select: "A" } })
    expect(send).toHaveBeenCalledWith({ type: "extension_ui_response", id: "q", value: "A" })
    helper.dispose()
  })
  it("validates ask choices and emits ordered upstream answer shape", async () => {
    const { helper, emit, send } = setup()
    helper.handle({
      type: "extension_ui_request",
      id: "ask",
      method: "ask",
      questions: [
        { id: "single", question: "One?", options: [{ label: "A" }] },
        { id: "multi", question: "Many?", multi: true, options: [{ label: "B" }, { label: "C" }] },
      ],
    })
    const requestId = emit.mock.calls[0][0].request.id as string
    const response: AcpElicitationResponse = {
      requestId,
      action: "accept",
      content: { single: "A", "single:customInput": "other", multi: ["B", "C"] },
    }
    await expect(helper.respond(response)).rejects.toThrow()
    await helper.respond({
      ...response,
      content: { "single:customInput": " other ", multi: ["B", "C"] },
    })
    expect(send).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "ask",
      answers: [
        { id: "single", selectedOptions: [], customInput: "other" },
        { id: "multi", selectedOptions: ["B", "C"] },
      ],
    })
    helper.dispose()
  })
  it("honors remote cancellation and disposes timers without late writes", async () => {
    jest.useFakeTimers()
    const { helper, emit, send } = setup({ timeoutMs: 10 })
    helper.handle({
      type: "extension_ui_request",
      id: "q",
      method: "confirm",
      title: "Ok?",
      message: "yes?",
    })
    const requestId = emit.mock.calls[0][0].request.id as string
    helper.handle({ type: "extension_ui_request", id: "cancel", method: "cancel", targetId: "q" })
    expect(emit).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "elicitation_complete", elicitationId: requestId })
    )
    await expect(
      helper.respond({ requestId, action: "accept", content: { confirm: true } })
    ).rejects.toThrow()
    helper.dispose()
    await jest.advanceTimersByTimeAsync(11)
    expect(send).not.toHaveBeenCalled()
    jest.useRealTimers()
  })
  it("treats duplicate request ids and send failures as fatal", async () => {
    const { helper, fatal } = setup({ tool: () => new Promise(() => {}) })
    helper.handle(toolFrame)
    helper.handle(toolFrame)
    expect(fatal).toHaveBeenCalledTimes(1)
    helper.dispose()
    const failed = setup({
      send: async () => {
        throw new Error("private path")
      },
    })
    failed.helper.handle(toolFrame)
    await tick()
    expect(failed.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ message: "OMP host response transport failed" })
    )
    failed.helper.dispose()
  })
  it("does not consume ordinary events", () => {
    const { helper } = setup()
    expect(helper.handle({ type: "agent_start" } as OmpServerFrame)).toBe(false)
    helper.dispose()
  })
})
