import { tracesToCases } from "./from-traces"
import type { TraceSummary } from "../trace-summary"

let counter = 0
const deps = { datasetId: "d", capability: "chat", now: () => 1, id: () => `evc_${counter++}` }
beforeEach(() => {
  counter = 0
})

function summary(over: Partial<TraceSummary>): TraceSummary {
  return {
    traceId: "t1",
    sessionId: "s1",
    startTime: 100,
    toolNames: [],
    preview: "hello",
    ...over,
  }
}

describe("tracesToCases", () => {
  it("maps a trace to a real-trace case carrying sourceTraceId + expectedTools", () => {
    const out = tracesToCases([summary({ toolNames: ["Read", "Edit"] })], deps)
    expect(out.cases[0].source).toBe("real-trace")
    expect(out.cases[0].sourceTraceId).toBe("t1")
    expect(out.cases[0].input).toBe("hello")
    expect(out.cases[0].reference?.expectedTools).toEqual(["Read", "Edit"])
  })

  it("falls back to traceId when preview is empty", () => {
    const out = tracesToCases([summary({ preview: "" })], deps)
    expect(out.cases[0].input).toBe("t1")
  })

  it("filters by toolNames / time window / explicit ids", () => {
    const list = [
      summary({ traceId: "a", startTime: 100, toolNames: ["Read"] }),
      summary({ traceId: "b", startTime: 200, toolNames: ["Bash"] }),
      summary({ traceId: "c", startTime: 300, toolNames: [] }),
    ]
    expect(
      tracesToCases(list, deps, { toolNames: ["Bash"] }).cases.map((c) => c.sourceTraceId)
    ).toEqual(["b"])
    expect(
      tracesToCases(list, deps, { since: 150, until: 250 }).cases.map((c) => c.sourceTraceId)
    ).toEqual(["b"])
    expect(
      tracesToCases(list, deps, { traceIds: ["a", "c"] }).cases.map((c) => c.sourceTraceId)
    ).toEqual(["a", "c"])
  })
})
