import { buildWaterfall, flattenWaterfall, rollupTraces } from "./trace-rollup"
import { makeSpan } from "./fixtures"

describe("trace-rollup", () => {
  describe("rollupTraces", () => {
    it("groups spans by trace, newest-first", () => {
      const spans = [
        makeSpan({
          traceId: "a",
          spanId: "a1",
          startTime: 1000,
          operationName: "chat",
          costUsdEstimate: 0.1,
        }),
        makeSpan({
          traceId: "a",
          spanId: "a2",
          startTime: 1100,
          durationMs: 200,
          errorMessage: "x",
        }),
        makeSpan({ traceId: "b", spanId: "b1", startTime: 5000, operationName: "invoke_workflow" }),
      ]
      const rows = rollupTraces(spans)
      expect(rows.map((r) => r.traceId)).toEqual(["b", "a"]) // newest first
      const a = rows.find((r) => r.traceId === "a")!
      expect(a.spanCount).toBe(2)
      expect(a.errorCount).toBe(1)
      expect(a.startTime).toBe(1000)
      expect(a.rootName).toBe("chat")
      expect(a.totalCostUsd).toBeCloseTo(0.1, 5)
      expect(a.durationMs).toBe(1300 - 1000) // a2 end 1300 − a1 start 1000
    })

    it("labels tool spans by tool name", () => {
      const rows = rollupTraces([
        makeSpan({ traceId: "t", operationName: "execute_tool", toolName: "Bash" }),
      ])
      expect(rows[0].rootName).toBe("Bash")
    })

    it("returns empty for no spans", () => {
      expect(rollupTraces([])).toEqual([])
    })
  })

  describe("buildWaterfall", () => {
    it("returns an empty waterfall for no spans", () => {
      expect(buildWaterfall([])).toEqual({ roots: [], traceStart: 0, traceEnd: 0, totalMs: 0 })
    })

    it("builds a parent/child tree with offsets and widths", () => {
      const spans = [
        makeSpan({ spanId: "root", startTime: 1000, durationMs: 500 }),
        makeSpan({ spanId: "child", parentSpanId: "root", startTime: 1100, durationMs: 200 }),
      ]
      const wf = buildWaterfall(spans)
      expect(wf.traceStart).toBe(1000)
      expect(wf.totalMs).toBe(500)
      expect(wf.roots).toHaveLength(1)
      const root = wf.roots[0]
      expect(root.offsetMs).toBe(0)
      expect(root.widthMs).toBe(500)
      expect(root.children).toHaveLength(1)
      expect(root.children[0].offsetMs).toBe(100)
      expect(root.children[0].depth).toBe(1)
    })

    it("treats orphan spans (missing parent) as roots", () => {
      const spans = [makeSpan({ spanId: "x", parentSpanId: "ghost", startTime: 1000 })]
      const wf = buildWaterfall(spans)
      expect(wf.roots).toHaveLength(1)
      expect(wf.roots[0].span.spanId).toBe("x")
    })

    it("guards against a self-referential parent", () => {
      const spans = [makeSpan({ spanId: "self", parentSpanId: "self", startTime: 1000 })]
      const wf = buildWaterfall(spans)
      expect(wf.roots).toHaveLength(1)
    })

    it("does not infinite-loop on a cycle", () => {
      const spans = [
        makeSpan({ spanId: "a", parentSpanId: "b", startTime: 1000 }),
        makeSpan({ spanId: "b", parentSpanId: "a", startTime: 1010 }),
      ]
      const wf = buildWaterfall(spans)
      // Both reference each other → both treated as having an in-set parent,
      // so neither is a top-level root; the visited guard prevents recursion.
      const flat = flattenWaterfall(wf)
      expect(flat.length).toBeLessThanOrEqual(2)
    })

    it("marks error spans", () => {
      const wf = buildWaterfall([makeSpan({ spanId: "e", startTime: 1, errorType: "Timeout" })])
      expect(wf.roots[0].isError).toBe(true)
    })
  })

  describe("flattenWaterfall", () => {
    it("flattens in pre-order", () => {
      const spans = [
        makeSpan({ spanId: "r", startTime: 0 }),
        makeSpan({ spanId: "c1", parentSpanId: "r", startTime: 10 }),
        makeSpan({ spanId: "c2", parentSpanId: "r", startTime: 20 }),
      ]
      const flat = flattenWaterfall(buildWaterfall(spans))
      expect(flat.map((n) => n.span.spanId)).toEqual(["r", "c1", "c2"])
    })
  })
})
