import { applyFilters, isFilterEmpty } from "./filters"
import { makeSpan } from "./fixtures"

describe("filters", () => {
  const spans = [
    makeSpan({ responseModel: "opus", surface: "chat", operationName: "chat", sessionId: "s1" }),
    makeSpan({
      responseModel: "sonnet",
      surface: "agent-team",
      operationName: "execute_tool",
      toolName: "Bash",
      sessionId: "s2",
    }),
    makeSpan({
      requestModel: "haiku",
      surface: "workflow",
      operationName: "invoke_workflow",
      sessionId: "s1",
    }),
    makeSpan({ surface: "connector", operationName: "retrieval", sessionId: "s3" }),
  ]

  describe("isFilterEmpty", () => {
    it("is true for an empty object", () => {
      expect(isFilterEmpty({})).toBe(true)
    })
    it("is true for empty arrays", () => {
      expect(isFilterEmpty({ model: [], surface: [] })).toBe(true)
    })
    it("is false when any dimension has a value", () => {
      expect(isFilterEmpty({ model: ["opus"] })).toBe(false)
    })
  })

  describe("applyFilters", () => {
    it("returns the same set when empty", () => {
      expect(applyFilters(spans, {})).toBe(spans)
    })

    it("filters by model (OR within dimension)", () => {
      const out = applyFilters(spans, { model: ["opus", "haiku"] })
      expect(out).toHaveLength(2)
    })

    it("filters by surface", () => {
      expect(applyFilters(spans, { surface: ["agent-team"] })).toHaveLength(1)
    })

    it("filters by operation", () => {
      expect(applyFilters(spans, { operation: ["retrieval"] })).toHaveLength(1)
    })

    it("filters by tool, excluding spans with no tool", () => {
      const out = applyFilters(spans, { tool: ["Bash"] })
      expect(out).toHaveLength(1)
      expect(out[0].toolName).toBe("Bash")
    })

    it("filters by session", () => {
      expect(applyFilters(spans, { session: ["s1"] })).toHaveLength(2)
    })

    it("ANDs across dimensions", () => {
      const out = applyFilters(spans, { surface: ["chat"], session: ["s1"] })
      expect(out).toHaveLength(1)
      expect(out[0].responseModel).toBe("opus")
    })

    it("excludes spans missing the filtered field", () => {
      // unknown-model span exists; filtering by a concrete model drops it
      const out = applyFilters(spans, { model: ["opus"] })
      expect(out.every((s) => s.responseModel === "opus")).toBe(true)
    })
  })
})
