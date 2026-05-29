import { breakdownBy, distinctValues } from "./breakdown"
import { makeSpan } from "./fixtures"

describe("breakdown", () => {
  const spans = [
    makeSpan({
      responseModel: "opus",
      surface: "chat",
      operationName: "chat",
      costUsdEstimate: 0.1,
      durationMs: 100,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
    }),
    makeSpan({
      responseModel: "opus",
      surface: "chat",
      operationName: "execute_tool",
      toolName: "Bash",
      costUsdEstimate: 0.2,
      durationMs: 300,
      errorMessage: "boom",
    }),
    makeSpan({ responseModel: "sonnet", surface: "workflow", operationName: "invoke_workflow" }),
  ]

  describe("breakdownBy", () => {
    it("groups by model and sorts by span count desc", () => {
      const rows = breakdownBy(spans, "model")
      expect(rows[0].key).toBe("opus")
      expect(rows[0].spans).toBe(2)
      expect(rows[0].costUsd).toBeCloseTo(0.3, 5)
      expect(rows[0].inputTokens).toBe(10)
      expect(rows[0].errors).toBe(1)
      expect(rows[0].avgLatencyMs).toBe(200) // (100 + 300) / 2
      expect(rows[1].key).toBe("sonnet")
    })

    it("skips spans with no value for the dimension (tool)", () => {
      const rows = breakdownBy(spans, "tool")
      expect(rows).toHaveLength(1)
      expect(rows[0].key).toBe("Bash")
    })

    it("reports zero avg latency when no durations", () => {
      const noDuration = makeSpan({ surface: "chat" })
      delete (noDuration as { durationMs?: number }).durationMs
      const rows = breakdownBy([noDuration], "surface")
      expect(rows[0].avgLatencyMs).toBe(0)
    })

    it("breaks ties by key alpha", () => {
      const tied = [makeSpan({ surface: "connector" }), makeSpan({ surface: "chat" })]
      const rows = breakdownBy(tied, "surface")
      expect(rows.map((r) => r.key)).toEqual(["chat", "connector"])
    })
  })

  describe("distinctValues", () => {
    it("returns sorted distinct values", () => {
      expect(distinctValues(spans, "surface")).toEqual(["chat", "workflow"])
    })
    it("omits null dimension values", () => {
      expect(distinctValues(spans, "tool")).toEqual(["Bash"])
    })
    it("handles empty input", () => {
      expect(distinctValues([], "model")).toEqual([])
    })
  })
})
