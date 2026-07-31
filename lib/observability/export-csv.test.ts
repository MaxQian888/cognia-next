import { breakdownToCsv, csvField, csvRows, tracesToCsv } from "./export-csv"
import type { TraceRollupRow } from "./trace-rollup"
import type { BreakdownRow } from "./breakdown"

describe("export-csv", () => {
  describe("csvField", () => {
    it("leaves plain values unquoted", () => {
      expect(csvField("opus")).toBe("opus")
      expect(csvField(42)).toBe("42")
    })
    it("quotes and escapes commas, quotes and newlines", () => {
      expect(csvField("a,b")).toBe('"a,b"')
      expect(csvField('he said "hi"')).toBe('"he said ""hi"""')
      expect(csvField("line1\nline2")).toBe('"line1\nline2"')
    })
  })

  describe("csvRows", () => {
    it("joins cells with commas and rows with CRLF", () => {
      expect(
        csvRows([
          ["a", "b"],
          ["c", "d"],
        ])
      ).toBe("a,b\r\nc,d")
    })
  })

  describe("tracesToCsv", () => {
    const rows: TraceRollupRow[] = [
      {
        traceId: "t1",
        rootName: "chat, main",
        startTime: 0,
        durationMs: 1200,
        spanCount: 3,
        errorCount: 1,
        totalCostUsd: 0.42,
        surface: "chat",
      },
    ]

    it("emits a header then one ISO-dated row per trace", () => {
      const csv = tracesToCsv(rows)
      const lines = csv.split("\r\n")
      expect(lines[0]).toBe(
        "traceId,rootName,startTime,durationMs,spanCount,errorCount,totalCostUsd,surface"
      )
      // rootName has a comma → quoted; startTime → ISO.
      expect(lines[1]).toBe('t1,"chat, main",1970-01-01T00:00:00.000Z,1200,3,1,0.42,chat')
    })

    it("returns just the header for no rows", () => {
      expect(tracesToCsv([])).toBe(
        "traceId,rootName,startTime,durationMs,spanCount,errorCount,totalCostUsd,surface"
      )
    })
  })

  describe("breakdownToCsv", () => {
    it("serializes breakdown rows", () => {
      const rows: BreakdownRow[] = [
        {
          key: "opus",
          spans: 2,
          costUsd: 0.3,
          inputTokens: 10,
          outputTokens: 5,
          errors: 1,
          avgLatencyMs: 200,
        },
      ]
      const lines = breakdownToCsv(rows).split("\r\n")
      expect(lines[0]).toBe("key,spans,costUsd,inputTokens,outputTokens,errors,avgLatencyMs")
      expect(lines[1]).toBe("opus,2,0.3,10,5,1,200")
    })
  })
})
