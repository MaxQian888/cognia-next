import * as agentTrace from "./index"

describe("@cognia/agent-trace barrel", () => {
  it("re-exports the span emitter surface", () => {
    expect(typeof agentTrace.startSpan).toBe("function")
    expect(typeof agentTrace.endSpan).toBe("function")
    expect(typeof agentTrace.recordEvent).toBe("function")
    expect(typeof agentTrace.getAgentTraceWriter).toBe("function")
    expect(typeof agentTrace.setAgentTraceWriter).toBe("function")
  })

  it("re-exports the serialization + bridge helpers", () => {
    expect(typeof agentTrace.spanToOtlp).toBe("function")
    expect(typeof agentTrace.spansToOtlp).toBe("function")
    expect(typeof agentTrace.spanToLogEntry).toBe("function")
    expect(typeof agentTrace.agentTraceEventToLogEntry).toBe("function")
  })

  it("re-exports cost estimation and tool-span helpers", () => {
    expect(typeof agentTrace.formatCost).toBe("function")
    expect(typeof agentTrace.handleSdkEventForToolSpans).toBe("function")
    expect(typeof agentTrace.clearToolSpansForSession).toBe("function")
  })
})
