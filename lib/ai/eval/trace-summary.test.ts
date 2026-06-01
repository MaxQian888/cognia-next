import type { AgentTraceSpan } from "@/types/agent-trace/span"
import { summarizeTraces } from "./trace-summary"

function span(o: Partial<AgentTraceSpan>): AgentTraceSpan {
  return {
    id: o.id ?? "sp",
    traceId: o.traceId ?? "t",
    spanId: o.id ?? "sp",
    startTime: o.startTime ?? 0,
    operationName: o.operationName ?? "chat",
    providerName: "anthropic",
    sessionId: o.sessionId ?? "s",
    surface: "chat",
    ...o,
  }
}

describe("summarizeTraces", () => {
  it("groups spans by trace and lists tools in order", () => {
    const summaries = summarizeTraces([
      span({ traceId: "A", startTime: 10, operationName: "execute_tool", toolName: "Read" }),
      span({ traceId: "A", startTime: 5, operationName: "chat", inputPreview: "do it" }),
      span({ traceId: "A", startTime: 20, operationName: "execute_tool", toolName: "Edit" }),
    ])
    expect(summaries).toHaveLength(1)
    expect(summaries[0].traceId).toBe("A")
    expect(summaries[0].toolNames).toEqual(["Read", "Edit"])
    expect(summaries[0].preview).toBe("do it")
    expect(summaries[0].startTime).toBe(5)
  })

  it("returns traces newest-first by start time", () => {
    const summaries = summarizeTraces([
      span({ traceId: "old", startTime: 1 }),
      span({ traceId: "new", startTime: 100 }),
    ])
    expect(summaries.map((s) => s.traceId)).toEqual(["new", "old"])
  })

  it("falls back to outputPreview when no inputPreview exists", () => {
    const summaries = summarizeTraces([span({ traceId: "A", outputPreview: "result text" })])
    expect(summaries[0].preview).toBe("result text")
  })

  it("yields an empty preview when no previews are captured", () => {
    const summaries = summarizeTraces([span({ traceId: "A" })])
    expect(summaries[0].preview).toBe("")
  })
})
