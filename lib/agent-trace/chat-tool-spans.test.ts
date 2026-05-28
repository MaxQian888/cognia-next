import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { __resetAgentTraceEmitterForTesting, setAgentTraceWriter } from "./emitter"
import {
  __pendingToolSpanCountForTesting,
  __resetToolSpansForTesting,
  clearToolSpansForSession,
  handleSdkEventForToolSpans,
} from "./chat-tool-spans"

function captureWriter(): AgentTraceSpan[] {
  const spans: AgentTraceSpan[] = []
  setAgentTraceWriter((s) => spans.push(s))
  return spans
}

beforeEach(() => {
  __resetAgentTraceEmitterForTesting()
  __resetToolSpansForTesting()
})

describe("handleSdkEventForToolSpans — tool_use", () => {
  it("opens an execute_tool span per tool_use block on an assistant event", () => {
    const spans = captureWriter()
    const mutated = handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "ok" },
            { type: "tool_use", id: "toolu_a", name: "Read", input: { path: "/x" } },
            { type: "tool_use", id: "toolu_b", name: "mcp__lark__send" },
          ],
        },
      },
    })
    expect(mutated).toBe(2)
    expect(__pendingToolSpanCountForTesting("s1")).toBe(2)
    // No span emitted yet (only opened); flush by ending each one.
    expect(spans).toHaveLength(0)
  })

  it("uses anthropic provider for native tools and cognia.plugin for mcp__ tools", () => {
    const spans = captureWriter()
    handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_native", name: "Read" },
            { type: "tool_use", id: "toolu_plugin", name: "mcp__lark__send" },
          ],
        },
      },
    })
    handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "toolu_native", content: "ok" },
            { type: "tool_result", tool_use_id: "toolu_plugin", content: "ok" },
          ],
        },
      },
    })
    expect(spans.map((s) => s.providerName).sort()).toEqual(["anthropic", "cognia.plugin"])
    expect(spans.find((s) => s.toolName === "Read")?.providerName).toBe("anthropic")
    expect(spans.find((s) => s.toolName === "mcp__lark__send")?.providerName).toBe("cognia.plugin")
  })

  it("ignores duplicate tool_use blocks (same tool_use_id reuses the existing spanId)", () => {
    handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_a", name: "Read" }],
        },
      },
    })
    const mutated = handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "toolu_a", name: "Read" }],
        },
      },
    })
    expect(mutated).toBe(0)
    expect(__pendingToolSpanCountForTesting("s1")).toBe(1)
  })
})

describe("handleSdkEventForToolSpans — tool_result", () => {
  it("closes the span and records outputPreview when content is text", () => {
    const spans = captureWriter()
    handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_a", name: "Read" }] },
      },
    })
    const mutated = handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "file contents" }],
        },
      },
    })
    expect(mutated).toBe(1)
    expect(spans).toHaveLength(1)
    expect(spans[0].operationName).toBe("execute_tool")
    expect(spans[0].toolName).toBe("Read")
    expect(spans[0].parentSpanId).toBe("1111222233334444")
    expect(spans[0].traceId).toBe("trace-1")
    expect(spans[0].errorType).toBeUndefined()
    expect(spans[0].outputPreview).toBe("file contents")
    expect(__pendingToolSpanCountForTesting("s1")).toBe(0)
  })

  it("records errorType + errorMessage when is_error is true", () => {
    const spans = captureWriter()
    handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_a", name: "Bash" }] },
      },
    })
    handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_a",
              content: "permission denied",
              is_error: true,
            },
          ],
        },
      },
    })
    expect(spans[0].errorType).toBe("tool_error")
    expect(spans[0].errorMessage).toBe("permission denied")
    expect(spans[0].outputPreview).toBeUndefined()
  })

  it("joins multi-block text array content", () => {
    const spans = captureWriter()
    handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_a", name: "Read" }] },
      },
    })
    handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_a",
              content: [
                { type: "text", text: "line 1" },
                { type: "text", text: "line 2" },
                "line 3",
                { type: "image", source: { data: "..." } },
              ],
            },
          ],
        },
      },
    })
    expect(spans[0].outputPreview).toBe("line 1\nline 2\nline 3")
  })

  it("returns 0 mutations for tool_result with unknown tool_use_id", () => {
    const mutated = handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "trace-1",
      parentSpanId: "1111222233334444",
      event: {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "toolu_missing" }],
        },
      },
    })
    expect(mutated).toBe(0)
  })

  it("scopes tool spans by sessionId — concurrent sessions don't cross-pollute", () => {
    const spans = captureWriter()
    handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "t1",
      parentSpanId: "1111111111111111",
      event: {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_same", name: "Read" }] },
      },
    })
    handleSdkEventForToolSpans({
      sessionId: "s2",
      traceId: "t2",
      parentSpanId: "2222222222222222",
      event: {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_same", name: "Edit" }] },
      },
    })
    expect(__pendingToolSpanCountForTesting("s1")).toBe(1)
    expect(__pendingToolSpanCountForTesting("s2")).toBe(1)
    handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "t1",
      parentSpanId: "1111111111111111",
      event: {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_same" }] },
      },
    })
    expect(spans).toHaveLength(1)
    expect(spans[0].toolName).toBe("Read")
    expect(spans[0].traceId).toBe("t1")
    expect(__pendingToolSpanCountForTesting("s2")).toBe(1)
  })
})

describe("handleSdkEventForToolSpans — guards", () => {
  it("no-ops on events without content arrays", () => {
    const spans = captureWriter()
    expect(
      handleSdkEventForToolSpans({
        sessionId: "s1",
        traceId: "t",
        parentSpanId: "p",
        event: { type: "assistant", message: { content: "plain text" } },
      })
    ).toBe(0)
    expect(
      handleSdkEventForToolSpans({
        sessionId: "s1",
        traceId: "t",
        parentSpanId: "p",
        event: { type: "result" },
      })
    ).toBe(0)
    expect(spans).toHaveLength(0)
  })

  it("no-ops when args are missing", () => {
    expect(
      handleSdkEventForToolSpans({
        sessionId: "",
        traceId: "t",
        parentSpanId: "p",
        event: { type: "assistant", message: { content: [] } },
      })
    ).toBe(0)
    expect(
      handleSdkEventForToolSpans({
        sessionId: "s1",
        traceId: "t",
        parentSpanId: "",
        event: { type: "assistant", message: { content: [] } },
      })
    ).toBe(0)
  })
})

describe("clearToolSpansForSession", () => {
  it("drops all in-flight tool spans for the session", () => {
    handleSdkEventForToolSpans({
      sessionId: "s1",
      traceId: "t",
      parentSpanId: "p",
      event: {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "toolu_a", name: "Read" }] },
      },
    })
    expect(__pendingToolSpanCountForTesting("s1")).toBe(1)
    clearToolSpansForSession("s1")
    expect(__pendingToolSpanCountForTesting("s1")).toBe(0)
  })

  it("is a no-op when nothing is pending", () => {
    expect(() => clearToolSpansForSession("nope")).not.toThrow()
  })
})
