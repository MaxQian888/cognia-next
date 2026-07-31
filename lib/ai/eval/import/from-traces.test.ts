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

  it("prefers the resolved original prompt over the truncated preview", () => {
    // `preview` is a PII-gated, truncated span field. Using it as the case
    // input meant every case built from real traffic was a clipped fragment of
    // what the user actually asked — and the agent was then graded on it.
    const summaries = [summary({ traceId: "t1", preview: "explain the diff bet…" })]
    const out = tracesToCases(summaries, deps, undefined, {
      prompts: { t1: "explain the difference between a mutex and a semaphore" },
    })
    expect(out.cases[0].input).toBe("explain the difference between a mutex and a semaphore")
  })

  it("falls back to the preview when no prompt could be recovered", () => {
    const summaries = [summary({ traceId: "t1", preview: "a preview" })]
    expect(tracesToCases(summaries, deps, undefined, { prompts: {} }).cases[0].input).toBe(
      "a preview"
    )
    expect(tracesToCases(summaries, deps).cases[0].input).toBe("a preview")
  })

  it("uses a recovered prompt even when the trace has no preview at all", () => {
    const summaries = [summary({ traceId: "t1", preview: "" })]
    const out = tracesToCases(summaries, deps, undefined, { prompts: { t1: "the real question" } })
    expect(out.cases).toHaveLength(1)
    expect(out.skipped).toEqual([])
    expect(out.cases[0].input).toBe("the real question")
  })
})
