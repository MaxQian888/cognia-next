/** @jest-environment node */
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

import { classifyEvent } from "./classify"

describe("classifyEvent", () => {
  it("maps tool-result to PostToolUse carrying the tool name", () => {
    const ev: CaptureStreamEvent = {
      type: "tool-result",
      toolName: "Bash",
      input: { cmd: "ls" },
      result: "ok",
      isError: false,
    }
    const out = classifyEvent(ev)
    expect(out?.event).toBe("PostToolUse")
    expect(out?.fields.tool_name).toBe("Bash")
    expect(out?.fields.tool_input).toEqual({ cmd: "ls" })
    expect(out?.fields.tool_result).toBe("ok")
    expect(out?.fields.is_error).toBe(false)
  })

  it("omits tool_input when the result carries no input, and flags errors", () => {
    const ev: CaptureStreamEvent = {
      type: "tool-result",
      toolName: "Write",
      result: "boom",
      isError: true,
    }
    const out = classifyEvent(ev)
    expect(out?.event).toBe("PostToolUse")
    expect(out?.fields).not.toHaveProperty("tool_input")
    expect(out?.fields.is_error).toBe(true)
  })

  it("maps compact to PostCompact with token deltas", () => {
    const ev: CaptureStreamEvent = {
      type: "compact",
      trigger: "auto",
      preTokens: 100,
      postTokens: 20,
    }
    const out = classifyEvent(ev)
    expect(out?.event).toBe("PostCompact")
    expect(out?.fields).toEqual({ trigger: "auto", pre_tokens: 100, post_tokens: 20 })
  })

  it("returns null for text-delta", () => {
    expect(classifyEvent({ type: "text-delta", delta: "hi" })).toBeNull()
  })

  it("returns null for thinking-delta", () => {
    expect(classifyEvent({ type: "thinking-delta", delta: "hmm" })).toBeNull()
  })

  it("returns null for tool-call (PreToolUse is fired by the turn engine)", () => {
    expect(classifyEvent({ type: "tool-call", toolName: "Bash", input: { cmd: "ls" } })).toBeNull()
  })

  it("returns null for usage", () => {
    const ev = {
      type: "usage",
      usage: { inputTokens: 1, outputTokens: 2 },
    } as unknown as CaptureStreamEvent
    expect(classifyEvent(ev)).toBeNull()
  })

  it("returns null for an unknown event type", () => {
    expect(classifyEvent({ type: "mystery" } as unknown as CaptureStreamEvent)).toBeNull()
  })
})
