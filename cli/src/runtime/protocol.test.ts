/**
 * @jest-environment node
 */
import { commandToInbound, COMMAND } from "./protocol"

describe("commandToInbound", () => {
  it("maps claude_send (with options)", () => {
    expect(
      commandToInbound(COMMAND.SEND, { sessionId: "s1", prompt: "hi", options: { model: "m" } })
    ).toEqual({ type: "send", sessionId: "s1", prompt: "hi", options: { model: "m" } })
  })

  it("omits options when undefined", () => {
    const msg = commandToInbound(COMMAND.SEND, { sessionId: "s1", prompt: "hi" })
    expect(msg).toEqual({ type: "send", sessionId: "s1", prompt: "hi" })
    expect("options" in (msg as object)).toBe(false)
  })

  it("maps claude_interrupt", () => {
    expect(commandToInbound(COMMAND.INTERRUPT, { sessionId: "s1" })).toEqual({
      type: "interrupt",
      sessionId: "s1",
    })
  })

  it("maps claude_approve with all fields", () => {
    expect(
      commandToInbound(COMMAND.APPROVE, {
        sessionId: "s1",
        requestId: "r1",
        decision: "allow",
        message: "ok",
        updatedInput: { a: 1 },
      })
    ).toEqual({
      type: "permission_response",
      sessionId: "s1",
      requestId: "r1",
      decision: "allow",
      message: "ok",
      updatedInput: { a: 1 },
    })
  })

  it("rejects an invalid approval decision", () => {
    expect(() =>
      commandToInbound(COMMAND.APPROVE, { sessionId: "s1", requestId: "r1", decision: "maybe" })
    ).toThrow(/invalid approval decision/)
  })

  it("maps claude_close_session", () => {
    expect(commandToInbound(COMMAND.CLOSE, { sessionId: "s1" })).toEqual({
      type: "close",
      sessionId: "s1",
    })
  })

  it("maps tool_result_decision", () => {
    expect(
      commandToInbound(COMMAND.TOOL_RESULT_DECISION, {
        sessionId: "s1",
        reviewId: "rev1",
        updatedToolOutput: "clean",
      })
    ).toEqual({
      type: "tool_result_decision",
      sessionId: "s1",
      reviewId: "rev1",
      updatedToolOutput: "clean",
    })
  })

  it("maps plugin_tool_response", () => {
    expect(
      commandToInbound(COMMAND.PLUGIN_TOOL_RESPONSE, {
        sessionId: "s1",
        toolUseId: "t1",
        result: { ok: true },
      })
    ).toMatchObject({ type: "plugin_tool_response", sessionId: "s1", toolUseId: "t1" })
  })

  it("returns null for sidecar_status (local read)", () => {
    expect(commandToInbound(COMMAND.SIDECAR_STATUS, {})).toBeNull()
  })

  it("throws on an unsupported command", () => {
    expect(() => commandToInbound("claude_restart_sidecar", {})).toThrow(/unsupported command/)
  })
})
