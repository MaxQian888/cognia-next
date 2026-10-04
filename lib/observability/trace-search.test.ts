import { matchesTraceQuery, normalizeTraceQuery } from "./trace-search"

const fields = { name: "invoke_agent · Planner", traceId: "abc123DEF", surface: "agent-team" }

describe("trace search matcher", () => {
  it("normalizes case and whitespace once", () => {
    expect(normalizeTraceQuery("  PlAnNeR ")).toBe("planner")
  })

  it("matches everything on an empty needle", () => {
    expect(matchesTraceQuery(fields, "")).toBe(true)
  })

  it("matches the name, the trace id and the surface", () => {
    expect(matchesTraceQuery(fields, "planner")).toBe(true)
    expect(matchesTraceQuery(fields, "123def")).toBe(true)
    expect(matchesTraceQuery(fields, "agent-team")).toBe(true)
  })

  it("rejects text none of the three fields carry", () => {
    expect(matchesTraceQuery(fields, "bash")).toBe(false)
  })
})
