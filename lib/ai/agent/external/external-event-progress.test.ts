import {
  externalEventToCaptureEvents,
  pipeExternalEventsToCapture,
} from "./external-event-progress"
import type { ExternalAgentEvent } from "@/types/agent/external-agent"
import type { CaptureStreamEvent } from "@/lib/claude/run-and-capture"

const now = new Date()

describe("externalEventToCaptureEvents", () => {
  it("maps a text message_delta to a text-delta", () => {
    const ev: ExternalAgentEvent = {
      type: "message_delta",
      timestamp: now,
      delta: { type: "text", text: "hello" },
    }
    expect(externalEventToCaptureEvents(ev)).toEqual([{ type: "text-delta", delta: "hello" }])
  })

  it("maps a thinking message_delta to a thinking-delta", () => {
    const ev: ExternalAgentEvent = {
      type: "message_delta",
      timestamp: now,
      delta: { type: "thinking", text: "reasoning" },
    }
    expect(externalEventToCaptureEvents(ev)).toEqual([
      { type: "thinking-delta", delta: "reasoning" },
    ])
  })

  it("drops an empty message_delta", () => {
    const ev: ExternalAgentEvent = {
      type: "message_delta",
      timestamp: now,
      delta: { type: "text", text: "" },
    }
    expect(externalEventToCaptureEvents(ev)).toEqual([])
  })

  it("maps a standalone thinking event", () => {
    const ev: ExternalAgentEvent = { type: "thinking", timestamp: now, thinking: "hmm" }
    expect(externalEventToCaptureEvents(ev)).toEqual([{ type: "thinking-delta", delta: "hmm" }])
  })

  it("maps tool_use_start to a tool-call with id + input", () => {
    const ev: ExternalAgentEvent = {
      type: "tool_use_start",
      timestamp: now,
      toolUseId: "t1",
      toolName: "Bash",
      rawInput: { command: "ls" },
    }
    expect(externalEventToCaptureEvents(ev)).toEqual([
      { type: "tool-call", toolName: "Bash", input: { command: "ls" }, id: "t1" },
    ])
  })

  it("defaults tool-call input to an empty object when rawInput is absent", () => {
    const ev: ExternalAgentEvent = {
      type: "tool_use_start",
      timestamp: now,
      toolUseId: "t2",
      toolName: "Read",
    }
    expect(externalEventToCaptureEvents(ev)).toEqual([
      { type: "tool-call", toolName: "Read", input: {}, id: "t2" },
    ])
  })

  it("maps tool_result to a tool-result carrying error + input", () => {
    const ev: ExternalAgentEvent = {
      type: "tool_result",
      timestamp: now,
      toolUseId: "t1",
      toolName: "Bash",
      rawInput: { command: "ls" },
      result: "file.txt",
      isError: false,
    }
    expect(externalEventToCaptureEvents(ev)).toEqual([
      {
        type: "tool-result",
        toolName: "Bash",
        id: "t1",
        input: { command: "ls" },
        result: "file.txt",
        isError: false,
      },
    ])
  })

  it("falls back to a generic tool name on a nameless tool_result", () => {
    const ev: ExternalAgentEvent = {
      type: "tool_result",
      timestamp: now,
      toolUseId: "t3",
      result: { ok: true },
    }
    const out = externalEventToCaptureEvents(ev)
    expect(out).toEqual([{ type: "tool-result", toolName: "tool", id: "t3", result: { ok: true } }])
  })

  it.each(["session_start", "session_end", "done", "error", "plan_update", "mode_update"] as const)(
    "ignores the non-progress event %s",
    (type) => {
      const ev = { type, timestamp: now } as unknown as ExternalAgentEvent
      expect(externalEventToCaptureEvents(ev)).toEqual([])
    }
  )
})

describe("pipeExternalEventsToCapture", () => {
  it("forwards each translated capture event to the sink", () => {
    const seen: CaptureStreamEvent[] = []
    const pipe = pipeExternalEventsToCapture((e) => seen.push(e))
    pipe({ type: "message_delta", timestamp: now, delta: { type: "text", text: "a" } })
    pipe({ type: "tool_use_start", timestamp: now, toolUseId: "t1", toolName: "Read" })
    pipe({ type: "done", timestamp: now, success: true } as ExternalAgentEvent)
    expect(seen).toEqual([
      { type: "text-delta", delta: "a" },
      { type: "tool-call", toolName: "Read", input: {}, id: "t1" },
    ])
  })

  it("swallows a throwing sink without propagating", () => {
    const pipe = pipeExternalEventsToCapture(() => {
      throw new Error("boom")
    })
    expect(() =>
      pipe({ type: "message_delta", timestamp: now, delta: { type: "text", text: "x" } })
    ).not.toThrow()
  })
})
