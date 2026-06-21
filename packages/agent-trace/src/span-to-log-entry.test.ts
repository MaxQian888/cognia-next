import type { StructuredLogEntry } from "@/types/logging"
import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { AGENT_TRACE_SPAN_KIND } from "@/types/agent-trace/span"
import {
  AGENT_TRACE_MODULE,
  extractSpanFromLogEntry,
  isAgentTraceSpanShape,
  spanToLogEntry,
} from "./span-to-log-entry"

function makeSpan(over: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  return {
    id: "span-abc",
    spanId: "span-abc",
    traceId: "trace-001",
    startTime: Date.UTC(2026, 4, 28, 10, 0, 0),
    endTime: Date.UTC(2026, 4, 28, 10, 0, 0) + 250,
    durationMs: 250,
    operationName: "invoke_agent",
    providerName: "anthropic",
    sessionId: "session-1",
    surface: "chat",
    requestModel: "claude-opus-4-7",
    responseModel: "claude-opus-4-7",
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationTokens: 0,
      cacheReadTokens: 20,
    },
    costUsdEstimate: 0.0042,
    ...over,
  }
}

describe("AGENT_TRACE_MODULE", () => {
  it("matches the legacy synthetic module name", () => {
    expect(AGENT_TRACE_MODULE).toBe("agent.trace")
  })
})

describe("isAgentTraceSpanShape", () => {
  it("accepts a fully-formed span", () => {
    expect(isAgentTraceSpanShape(makeSpan())).toBe(true)
  })

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["number", 1],
    ["string", "x"],
  ])("rejects non-object inputs (%s)", (_label, value) => {
    expect(isAgentTraceSpanShape(value)).toBe(false)
  })

  it.each<keyof AgentTraceSpan>(["id", "spanId", "traceId", "operationName", "sessionId"])(
    "rejects when %s is missing",
    (field) => {
      const span = makeSpan()
      delete (span as unknown as Record<string, unknown>)[field]
      expect(isAgentTraceSpanShape(span)).toBe(false)
    }
  )

  it("rejects when startTime is not a number", () => {
    const span = makeSpan()
    ;(span as unknown as Record<string, unknown>).startTime = "now"
    expect(isAgentTraceSpanShape(span)).toBe(false)
  })
})

describe("spanToLogEntry", () => {
  it("maps core fields and embeds the full span under data.span", () => {
    const span = makeSpan()
    const entry = spanToLogEntry(span)
    expect(entry.id).toBe(span.id)
    expect(entry.module).toBe("agent.trace")
    expect(entry.level).toBe("info")
    expect(entry.traceId).toBe(span.traceId)
    expect(entry.sessionId).toBe(span.sessionId)
    expect(entry.timestamp).toBe(new Date(span.startTime).toISOString())
    expect(entry.data?.kind).toBe(AGENT_TRACE_SPAN_KIND)
    expect(entry.data?.span).toEqual(span)
  })

  it("marks error level when errorType or errorMessage is present", () => {
    const a = spanToLogEntry(makeSpan({ errorType: "tool_error" }))
    const b = spanToLogEntry(makeSpan({ errorMessage: "boom" }))
    expect(a.level).toBe("error")
    expect(b.level).toBe("error")
  })

  it("produces a human-readable message including cost, tokens, cache read", () => {
    const entry = spanToLogEntry(makeSpan())
    expect(entry.message).toContain("[invoke_agent]")
    expect(entry.message).toContain("model=claude-opus-4-7")
    expect(entry.message).toContain("250ms")
    expect(entry.message).toContain("$0.0042")
    expect(entry.message).toContain("tokens=100/50")
    expect(entry.message).toContain("cacheRead=20")
  })

  it("falls back to requestModel when responseModel is missing", () => {
    const entry = spanToLogEntry(makeSpan({ responseModel: undefined }))
    expect(entry.message).toContain("model=claude-opus-4-7")
  })

  it("includes tool / agent / plugin tags when those fields are set", () => {
    const entry = spanToLogEntry(
      makeSpan({
        operationName: "execute_tool",
        toolName: "list_files",
        pluginId: "fs-plugin",
        agentId: "researcher",
        agentName: "Researcher",
        errorType: "tool_error",
        errorMessage: "tool blew up",
      })
    )
    expect(entry.tags).toEqual(
      expect.arrayContaining([
        "surface:chat",
        "op:execute_tool",
        "provider:anthropic",
        "tool:list_files",
        "plugin:fs-plugin",
        "agent:researcher",
        "error:tool_error",
      ])
    )
    expect(entry.message).toContain("Researcher")
    expect(entry.message).toContain("list_files")
    expect(entry.message).toContain("error: tool blew up")
  })

  it("omits cost / cacheRead from message when zero or missing", () => {
    const entry = spanToLogEntry(
      makeSpan({
        costUsdEstimate: 0,
        usage: { inputTokens: 5, outputTokens: 3, cacheCreationTokens: 0, cacheReadTokens: 0 },
      })
    )
    expect(entry.message).not.toContain("$")
    expect(entry.message).not.toContain("cacheRead=")
  })

  it("omits token segment when usage is undefined", () => {
    const entry = spanToLogEntry(makeSpan({ usage: undefined }))
    expect(entry.message).not.toContain("tokens=")
  })
})

describe("extractSpanFromLogEntry", () => {
  it("round-trips spanToLogEntry", () => {
    const span = makeSpan()
    const entry = spanToLogEntry(span)
    expect(extractSpanFromLogEntry(entry)).toEqual(span)
  })

  it("returns null for an unrelated entry", () => {
    const entry: StructuredLogEntry = {
      id: "1",
      timestamp: new Date().toISOString(),
      level: "info",
      message: "hello",
      module: "app",
    }
    expect(extractSpanFromLogEntry(entry)).toBeNull()
  })

  it("returns null when data.kind is wrong", () => {
    const entry: StructuredLogEntry = {
      id: "1",
      timestamp: new Date().toISOString(),
      level: "info",
      message: "hello",
      module: "agent.trace",
      data: { kind: "other", span: makeSpan() },
    }
    expect(extractSpanFromLogEntry(entry)).toBeNull()
  })

  it("returns null when the embedded span is malformed", () => {
    const entry: StructuredLogEntry = {
      id: "1",
      timestamp: new Date().toISOString(),
      level: "info",
      message: "hello",
      module: "agent.trace",
      data: { kind: AGENT_TRACE_SPAN_KIND, span: { id: 1 } },
    }
    expect(extractSpanFromLogEntry(entry)).toBeNull()
  })
})
