/**
 * @jest-environment node
 */
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

import { captureEventToActions, toolCallKey } from "./event-mapper"

describe("toolCallKey", () => {
  it("combines tool name and serialized input", () => {
    expect(toolCallKey("bash", { command: "ls" })).toBe('bash:{"command":"ls"}')
  })

  it("tolerates non-serializable input", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(toolCallKey("x", circular)).toBe("x:")
  })
})

describe("captureEventToActions", () => {
  it("maps text-delta", () => {
    expect(captureEventToActions({ type: "text-delta", delta: "hi" })).toEqual([
      { type: "INFLIGHT_TEXT", delta: "hi" },
    ])
  })

  it("drops empty text-delta", () => {
    expect(captureEventToActions({ type: "text-delta", delta: "" })).toEqual([])
  })

  it("maps thinking-delta", () => {
    expect(captureEventToActions({ type: "thinking-delta", delta: "hmm" })).toEqual([
      { type: "INFLIGHT_THINKING", delta: "hmm" },
    ])
  })

  it("drops empty thinking-delta", () => {
    expect(captureEventToActions({ type: "thinking-delta", delta: "" })).toEqual([])
  })

  it("maps tool-call with a correlation key", () => {
    const actions = captureEventToActions({
      type: "tool-call",
      toolName: "bash",
      input: { command: "ls" },
    })
    expect(actions).toEqual([
      {
        type: "TOOL_CALL",
        callKey: 'bash:{"command":"ls"}',
        toolName: "bash",
        input: { command: "ls" },
      },
    ])
  })

  it("maps tool-result with input and error flag", () => {
    expect(
      captureEventToActions({
        type: "tool-result",
        toolName: "bash",
        input: { command: "ls" },
        result: "ok",
        isError: true,
      })
    ).toEqual([
      {
        type: "TOOL_RESULT",
        toolName: "bash",
        input: { command: "ls" },
        callKey: 'bash:{"command":"ls"}',
        result: "ok",
        isError: true,
      },
    ])
  })

  it("maps tool-result omitting absent input, error, and callKey", () => {
    expect(captureEventToActions({ type: "tool-result", toolName: "bash", result: "ok" })).toEqual([
      { type: "TOOL_RESULT", toolName: "bash", result: "ok" },
    ])
  })

  it("maps a usage event to SET_USAGE", () => {
    expect(
      captureEventToActions({ type: "usage", usage: { inputTokens: 5, totalCostUsd: 0.01 } })
    ).toEqual([{ type: "SET_USAGE", usage: { inputTokens: 5, totalCostUsd: 0.01 } }])
  })

  it("ignores unknown event types", () => {
    expect(captureEventToActions({ type: "mystery" } as unknown as CaptureStreamEvent)).toEqual([])
  })
})
