import { makeSpan } from "./fixtures"
import {
  TRACE_EXPORT_FORMATS,
  serializeTrace,
  traceExportFilename,
  traceExportMimeType,
} from "./trace-export"

const AT = Date.UTC(2026, 7, 19, 15, 4, 5)

function spans() {
  return [
    makeSpan({
      traceId: "t",
      spanId: "b",
      startTime: 2_000,
      inputPreview: "prompt",
      outputPreview: "answer",
    }),
    makeSpan({ traceId: "t", spanId: "a", startTime: 1_000 }),
  ]
}

describe("serializeTrace", () => {
  it("emits raw spans as JSON, chronologically", () => {
    const parsed = JSON.parse(serializeTrace(spans(), "json")) as Array<{ spanId: string }>
    expect(parsed.map((s) => s.spanId)).toEqual(["a", "b"])
  })

  it("is stable regardless of the caller's ordering", () => {
    const forward = serializeTrace(spans(), "json")
    const reversed = serializeTrace([...spans()].reverse(), "json")
    expect(forward).toBe(reversed)
  })

  it("does not mutate the caller's array", () => {
    const input = spans()
    const before = input.map((s) => s.spanId)
    serializeTrace(input, "json")
    expect(input.map((s) => s.spanId)).toEqual(before)
  })

  it("emits an OTLP resourceSpans envelope", () => {
    const parsed = JSON.parse(serializeTrace(spans(), "otlp")) as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>
    }
    expect(parsed.resourceSpans).toHaveLength(1)
    expect(parsed.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2)
  })

  it("keeps content previews by default — the UI already showed them", () => {
    expect(serializeTrace(spans(), "json")).toContain("prompt")
  })

  it("strips previews on request, in both formats", () => {
    const json = serializeTrace(spans(), "json", { redactPreviews: true })
    expect(json).not.toContain("prompt")
    expect(json).not.toContain("answer")
    expect(JSON.parse(json)).toHaveLength(2)
    expect(serializeTrace(spans(), "otlp", { redactPreviews: true })).not.toContain("prompt")
  })

  it("handles an empty trace", () => {
    expect(JSON.parse(serializeTrace([], "json"))).toEqual([])
    expect(() => JSON.parse(serializeTrace([], "otlp"))).not.toThrow()
  })
})

describe("traceExportFilename", () => {
  it("stamps the trace id and time, truncating a long id", () => {
    expect(traceExportFilename("0123456789abcdef0123456789abcdef", "json", AT)).toBe(
      "cognia-trace-0123456789ab-2026-08-19-15-04-05.json"
    )
  })

  it("marks OTLP payloads distinctly", () => {
    expect(traceExportFilename("abc", "otlp", AT)).toContain(".otlp.json")
  })

  it("drops filesystem-hostile characters and survives an empty id", () => {
    expect(traceExportFilename("../../etc/passwd", "json", AT)).not.toContain("/")
    expect(traceExportFilename("", "json", AT)).toContain("cognia-trace-trace-")
  })
})

describe("traceExportMimeType", () => {
  it("covers every rendered format", () => {
    for (const format of TRACE_EXPORT_FORMATS) {
      expect(traceExportMimeType(format)).toBe("application/json")
    }
  })
})
