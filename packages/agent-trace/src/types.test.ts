import { AGENT_TRACE_SPAN_KIND, type AgentTraceSpan, type StructuredLogEntry } from "./types"

describe("agent-trace public types", () => {
  it("exports the stable span discriminator used in structured log payloads", () => {
    expect(AGENT_TRACE_SPAN_KIND).toBe("agent-trace-span")
  })

  it("accepts the span payload shape embedded in a structured log entry", () => {
    const span: AgentTraceSpan = {
      id: "span-1",
      traceId: "trace-1",
      spanId: "span-1",
      startTime: 1,
      operationName: "invoke_agent",
      providerName: "anthropic",
      sessionId: "session-1",
      surface: "chat",
    }
    const entry: StructuredLogEntry = {
      id: "entry-1",
      timestamp: "2026-06-22T00:00:00.000Z",
      level: "info",
      message: "trace",
      module: "agent.trace",
      data: { kind: AGENT_TRACE_SPAN_KIND, span },
    }

    expect(entry.data).toEqual({ kind: AGENT_TRACE_SPAN_KIND, span })
  })
})
