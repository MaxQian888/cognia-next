import { AGENT_TRACE_SPAN_KIND, type AgentTraceSpan, type StructuredLogEntry } from "./types"
import {
  AGENT_TRACE_MODULE,
  agentTraceEventToLogEntry,
  dbAgentTraceToLogEntry,
  getAgentTraceLogData,
} from "./log-adapter"

function makeSpan(over: Partial<AgentTraceSpan> = {}): AgentTraceSpan {
  return {
    id: "span-1",
    spanId: "span-1",
    traceId: "trace-1",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_000_250,
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
    costUsdEstimate: 0.005,
    ...over,
  }
}

describe("AGENT_TRACE_MODULE re-export", () => {
  it("exports the synthetic module name", () => {
    expect(AGENT_TRACE_MODULE).toBe("agent.trace")
  })
})

describe("agentTraceEventToLogEntry", () => {
  it("converts a span-shaped event", () => {
    const entry = agentTraceEventToLogEntry(makeSpan() as unknown as Record<string, unknown>)
    expect(entry).not.toBeNull()
    expect(entry?.module).toBe(AGENT_TRACE_MODULE)
    expect(entry?.traceId).toBe("trace-1")
  })

  it("returns null for non-span events", () => {
    expect(agentTraceEventToLogEntry({ id: "x" })).toBeNull()
    expect(agentTraceEventToLogEntry({})).toBeNull()
  })
})

describe("dbAgentTraceToLogEntry", () => {
  it("converts a span-shaped Dexie row", () => {
    const entry = dbAgentTraceToLogEntry(makeSpan() as unknown as Record<string, unknown>)
    expect(entry).not.toBeNull()
    expect(entry?.id).toBe("span-1")
  })

  it("returns null for legacy stub-shaped rows", () => {
    expect(dbAgentTraceToLogEntry({ id: "x", timestamp: "now" })).toBeNull()
  })
})

describe("getAgentTraceLogData", () => {
  it("returns null when entry is not agent-trace", () => {
    const entry: StructuredLogEntry = {
      id: "1",
      timestamp: new Date().toISOString(),
      level: "info",
      message: "hi",
      module: "app",
    }
    expect(getAgentTraceLogData(entry)).toBeNull()
  })

  it("projects a span entry into AgentTraceLogData", () => {
    const span = makeSpan()
    const entry: StructuredLogEntry = {
      id: span.id,
      timestamp: new Date(span.startTime).toISOString(),
      level: "info",
      message: "x",
      module: AGENT_TRACE_MODULE,
      data: { kind: AGENT_TRACE_SPAN_KIND, span },
    }
    const data = getAgentTraceLogData(entry)!
    expect(data.eventType).toBe("invoke_agent")
    expect(data.duration).toBe(250)
    expect(data.modelId).toBe("claude-opus-4-7")
    expect(data.tokenUsage).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    })
    expect(data.costEstimate).toEqual({
      inputCost: 0,
      outputCost: 0,
      totalCost: 0.005,
    })
    expect(data.success).toBe(true)
    expect(data.error).toBeUndefined()
  })

  it("flags failure spans as success=false and surfaces the message", () => {
    const span = makeSpan({ errorType: "tool_error", errorMessage: "boom" })
    const entry: StructuredLogEntry = {
      id: span.id,
      timestamp: new Date(span.startTime).toISOString(),
      level: "error",
      message: "err",
      module: AGENT_TRACE_MODULE,
      data: { kind: AGENT_TRACE_SPAN_KIND, span },
    }
    const data = getAgentTraceLogData(entry)!
    expect(data.success).toBe(false)
    expect(data.error).toBe("boom")
  })

  it("omits tokenUsage and costEstimate when missing", () => {
    const span = makeSpan({ usage: undefined, costUsdEstimate: undefined })
    const entry: StructuredLogEntry = {
      id: span.id,
      timestamp: new Date(span.startTime).toISOString(),
      level: "info",
      message: "x",
      module: AGENT_TRACE_MODULE,
      data: { kind: AGENT_TRACE_SPAN_KIND, span },
    }
    const data = getAgentTraceLogData(entry)!
    expect(data.tokenUsage).toBeUndefined()
    expect(data.costEstimate).toBeUndefined()
  })

  it("omits costEstimate when cost is 0", () => {
    const span = makeSpan({ costUsdEstimate: 0 })
    const entry: StructuredLogEntry = {
      id: span.id,
      timestamp: new Date(span.startTime).toISOString(),
      level: "info",
      message: "x",
      module: AGENT_TRACE_MODULE,
      data: { kind: AGENT_TRACE_SPAN_KIND, span },
    }
    const data = getAgentTraceLogData(entry)!
    expect(data.costEstimate).toBeUndefined()
  })

  it("falls back to requestModel when responseModel is missing", () => {
    const span = makeSpan({ responseModel: undefined })
    const entry: StructuredLogEntry = {
      id: span.id,
      timestamp: new Date(span.startTime).toISOString(),
      level: "info",
      message: "x",
      module: AGENT_TRACE_MODULE,
      data: { kind: AGENT_TRACE_SPAN_KIND, span },
    }
    expect(getAgentTraceLogData(entry)?.modelId).toBe("claude-opus-4-7")
  })

  it("preserves toolName / responsePreview on the projection", () => {
    const span = makeSpan({
      operationName: "execute_tool",
      toolName: "list_files",
      outputPreview: "first 4KB...",
    })
    const entry: StructuredLogEntry = {
      id: span.id,
      timestamp: new Date(span.startTime).toISOString(),
      level: "info",
      message: "x",
      module: AGENT_TRACE_MODULE,
      data: { kind: AGENT_TRACE_SPAN_KIND, span },
    }
    const data = getAgentTraceLogData(entry)!
    expect(data.toolName).toBe("list_files")
    expect(data.responsePreview).toBe("first 4KB...")
    expect(data.eventType).toBe("execute_tool")
  })
})
