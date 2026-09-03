import { parseChartPayload } from "./chart-contract"

const codes = (payload: string, options?: Parameters<typeof parseChartPayload>[1]) =>
  parseChartPayload(payload, options).findings.map((finding) => finding.code)

describe("parseChartPayload", () => {
  describe("the pie key that used to render nothing", () => {
    it("slices by the only numeric key when it is not called `value`", () => {
      // The renderer hardcoded `dataKey="value"`, so this payload drew a
      // completely blank pie. Every fixture in the old suite used `value`,
      // which is why nothing caught it.
      const result = parseChartPayload(
        JSON.stringify({
          type: "pie",
          data: [
            { name: "Chrome", share: 62 },
            { name: "Safari", share: 21 },
          ],
        })
      )
      expect(result.valueKey).toBe("share")
      expect(result.drawable).toBe(true)
      expect(result.findings).toEqual([])
    })

    it("still prefers a literal `value` when the rows carry one", () => {
      // Back-compat pin. A naive `series[0]` would start drawing `errors` here
      // and silently change every existing artifact shaped like this.
      const result = parseChartPayload(
        JSON.stringify({
          type: "bar",
          data: [{ name: "Jan", errors: 3, value: 12 }],
        })
      )
      expect(result.series).toEqual(["errors", "value"])
      expect(result.valueKey).toBe("value")
    })

    it("names the series a pie could not draw", () => {
      const result = parseChartPayload(
        JSON.stringify({
          type: "pie",
          data: [{ name: "Jan", value: 12, cost: 4 }],
        })
      )
      expect(result.valueKey).toBe("value")
      expect(result.findings).toContainEqual({
        code: "extraSeriesDropped",
        severity: "degraded",
        params: { series: "cost", count: 1 },
      })
    })
  })

  describe("rules that used to fail in silence", () => {
    it("reports a late series without drawing it", () => {
      // Report-only on purpose: widening `series` to the all-rows union would
      // change how existing charts look and would contradict `chart-design`.
      const result = parseChartPayload(
        JSON.stringify({
          type: "line",
          data: [
            { name: "Jan", revenue: 10 },
            { name: "Feb", revenue: 12, cost: 4 },
          ],
        })
      )
      expect(result.series).toEqual(["revenue"])
      expect(result.findings).toContainEqual({
        code: "lateSeries",
        severity: "degraded",
        params: { series: "cost" },
      })
    })

    it("names an unsupported chart type instead of quietly drawing a line", () => {
      const result = parseChartPayload(
        JSON.stringify({ type: "histogram", data: [{ name: "a", value: 1 }] })
      )
      expect(result.chartType).toBe("line")
      expect(result.resolvedFrom).toBe("fallback")
      expect(result.findings).toContainEqual({
        code: "unknownType",
        severity: "degraded",
        params: { type: "histogram" },
      })
    })

    it("counts rows with no name and values that are not numbers", () => {
      const result = parseChartPayload(
        JSON.stringify({
          type: "bar",
          data: [{ name: "Jan", value: 1 }, { name: "", value: null }, { value: "12" }],
        })
      )
      expect(result.findings).toContainEqual({
        code: "missingName",
        severity: "degraded",
        params: { count: 2 },
      })
      expect(result.findings).toContainEqual({
        code: "nonNumericValue",
        severity: "degraded",
        params: { series: "value", count: 2 },
      })
    })
  })

  describe("scatter, which has its own row contract", () => {
    it("infers the shape from a bare x/y array", () => {
      const result = parseChartPayload(
        JSON.stringify([
          { x: 1, y: 2 },
          { x: 3, y: 4 },
        ])
      )
      expect(result.chartType).toBe("scatter")
      expect(result.resolvedFrom).toBe("inferred")
      expect(result.findings).toEqual([])
    })

    it("counts unplottable rows and never asks them for a name", () => {
      const result = parseChartPayload(
        JSON.stringify({ type: "scatter", data: [{ x: 1, y: 2 }, { x: 3 }] })
      )
      expect(result.drawable).toBe(true)
      expect(codes(JSON.stringify({ type: "scatter", data: [{ x: 1, y: 2 }, { x: 3 }] }))).toEqual([
        "scatterMissingXY",
      ])
      expect(result.findings).not.toContainEqual(expect.objectContaining({ code: "missingName" }))
    })
  })

  describe("payloads with nothing to draw", () => {
    it("reports invalid JSON as fatal", () => {
      const result = parseChartPayload("not json")
      expect(result.drawable).toBe(false)
      expect(result.findings).toEqual([{ code: "invalidJson", severity: "fatal" }])
    })

    it("reports a JSON object that is not a chart as fatal", () => {
      expect(codes(JSON.stringify({ foo: "bar" }))).toEqual(["unsupportedShape"])
    })

    it("treats an empty array as undrawable but not broken", () => {
      const result = parseChartPayload("[]")
      expect(result.drawable).toBe(false)
      expect(result.findings).toEqual([])
    })

    it("says so when no row carries a number", () => {
      expect(codes(JSON.stringify([{ name: "a" }]))).toEqual(["noNumericSeries"])
    })
  })

  describe("shape resolution feeds the detector", () => {
    it("marks a declared type so the detector can stamp it", () => {
      expect(
        parseChartPayload(JSON.stringify({ type: "bar", data: [{ name: "a", value: 1 }] }))
      ).toMatchObject({ chartType: "bar", resolvedFrom: "declared" })
    })

    it("leaves an undeclared cartesian payload as a fallback", () => {
      // `resolvedFrom: "fallback"` is what stops the detector pinning
      // `metadata.chartType` to a shape nobody chose.
      expect(parseChartPayload(JSON.stringify([{ name: "a", value: 1 }]))).toMatchObject({
        resolvedFrom: "fallback",
      })
    })

    it("lets pre-parsed rows win over the content string", () => {
      const result = parseChartPayload("not json", {
        chartData: [{ name: "a", value: 1 }],
        fallbackType: "bar",
      })
      expect(result.chartType).toBe("bar")
      expect(result.drawable).toBe(true)
    })
  })

  it("returns findings in a stable, deduplicated order", () => {
    const payload = JSON.stringify({
      type: "histogram",
      data: [
        { name: "Jan", value: 1 },
        { name: "", value: null, cost: 2 },
      ],
    })
    expect(codes(payload)).toEqual(codes(payload))
    expect(codes(payload)).toEqual(["unknownType", "lateSeries", "missingName", "nonNumericValue"])
  })
})
