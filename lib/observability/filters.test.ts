import {
  FILTER_DIMENSIONS,
  applyFilters,
  ensureFilterValue,
  isFilterEmpty,
  isValueSelected,
  sanitizeFilters,
  toggleFilterValue,
  type TraceFilters,
} from "./filters"
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
    it("counts the provider and project dimensions", () => {
      expect(isFilterEmpty({ provider: ["anthropic"] })).toBe(false)
      expect(isFilterEmpty({ project: ["p1"] })).toBe(false)
      expect(isFilterEmpty({ provider: [], project: [] })).toBe(true)
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

  describe("toggleFilterValue", () => {
    it("adds a value to an empty dimension", () => {
      expect(toggleFilterValue({}, "model", "opus")).toEqual({ model: ["opus"] })
    })
    it("removes a value, dropping the now-empty dimension", () => {
      expect(toggleFilterValue({ model: ["opus"] }, "model", "opus")).toEqual({})
    })
    it("appends without disturbing other dimensions", () => {
      const out = toggleFilterValue({ surface: ["chat"], model: ["opus"] }, "model", "sonnet")
      expect(out).toEqual({ surface: ["chat"], model: ["opus", "sonnet"] })
    })
  })

  describe("isValueSelected", () => {
    it("is true only when the value is present under the dimension", () => {
      expect(isValueSelected({ model: ["opus"] }, "model", "opus")).toBe(true)
      expect(isValueSelected({ model: ["opus"] }, "model", "sonnet")).toBe(false)
      expect(isValueSelected({}, "model", "opus")).toBe(false)
    })
  })

  describe("FILTER_DIMENSIONS", () => {
    it("lists every filterable dimension once, in filter-bar order", () => {
      expect([...FILTER_DIMENSIONS]).toEqual([
        "model",
        "surface",
        "operation",
        "tool",
        "provider",
        "project",
        "session",
      ])
      expect(new Set(FILTER_DIMENSIONS).size).toBe(FILTER_DIMENSIONS.length)
    })

    it("covers every key of TraceFilters", () => {
      const every: Required<TraceFilters> = {
        model: ["a"],
        surface: ["chat"],
        operation: ["chat"],
        tool: ["a"],
        session: ["a"],
        provider: ["a"],
        project: ["a"],
      }
      expect([...FILTER_DIMENSIONS].sort()).toEqual(Object.keys(every).sort())
    })
  })

  describe("sanitizeFilters", () => {
    it("returns {} for anything that is not a plain object", () => {
      expect(sanitizeFilters(null)).toEqual({})
      expect(sanitizeFilters(undefined)).toEqual({})
      expect(sanitizeFilters("model")).toEqual({})
      expect(sanitizeFilters(42)).toEqual({})
      expect(sanitizeFilters(["opus"])).toEqual({})
    })

    it("keeps known dimensions, including provider and project", () => {
      const raw = {
        model: ["opus"],
        surface: ["chat"],
        operation: ["chat"],
        tool: ["Bash"],
        session: ["s1"],
        provider: ["anthropic"],
        project: ["p1"],
      }
      expect(sanitizeFilters(raw)).toEqual(raw)
    })

    it("drops unknown dimensions and non-array values", () => {
      expect(sanitizeFilters({ bogus: ["x"], model: "opus", provider: ["anthropic"] })).toEqual({
        provider: ["anthropic"],
      })
    })

    it("drops non-string and empty-string values, and dimensions left empty", () => {
      expect(sanitizeFilters({ model: ["opus", 3, null, ""], project: ["", 7] })).toEqual({
        model: ["opus"],
      })
    })

    it("de-duplicates values, keeping first-seen order", () => {
      expect(sanitizeFilters({ provider: ["b", "a", "b"] })).toEqual({ provider: ["b", "a"] })
    })

    it("does not hand back the caller's arrays", () => {
      const model = ["opus"]
      const out = sanitizeFilters({ model })
      expect(out.model).toEqual(model)
      expect(out.model).not.toBe(model)
    })
  })

  describe("ensureFilterValue", () => {
    it("adds a value to an empty dimension", () => {
      expect(ensureFilterValue({}, "provider", "anthropic")).toEqual({ provider: ["anthropic"] })
    })

    it("appends without disturbing other dimensions", () => {
      expect(ensureFilterValue({ model: ["opus"], project: ["p1"] }, "project", "p2")).toEqual({
        model: ["opus"],
        project: ["p1", "p2"],
      })
    })

    it("never deselects a value that is already selected", () => {
      const filters: TraceFilters = { model: ["opus"] }
      const out = ensureFilterValue(filters, "model", "opus")
      expect(out).toBe(filters)
      expect(out).toEqual({ model: ["opus"] })
    })

    it("does not mutate its input", () => {
      const filters: TraceFilters = { tool: ["Bash"] }
      ensureFilterValue(filters, "tool", "Read")
      expect(filters).toEqual({ tool: ["Bash"] })
    })
  })

  describe("applyFilters over provider / project", () => {
    const attributed = [
      makeSpan({ id: "a", providerName: "anthropic", projectId: "p1" }),
      makeSpan({ id: "b", providerName: "openai", projectId: "p2" }),
      makeSpan({
        id: "c",
        providerName: "openai",
        projectId: "p1",
        metadata: { providerId: "azure-openai" },
      }),
    ]

    it("filters by provider, preferring the raw provider id", () => {
      expect(applyFilters(attributed, { provider: ["openai"] }).map((s) => s.id)).toEqual(["b"])
      expect(applyFilters(attributed, { provider: ["azure-openai"] }).map((s) => s.id)).toEqual([
        "c",
      ])
    })

    it("filters by project", () => {
      expect(applyFilters(attributed, { project: ["p1"] }).map((s) => s.id)).toEqual(["a", "c"])
    })
  })
})
