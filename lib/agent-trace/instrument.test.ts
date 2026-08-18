import type { AgentTraceSpan } from "@/types/agent-trace/span"
import {
  __getActiveSpanForTesting,
  __resetAgentTraceEmitterForTesting,
  setAgentTraceWriter,
} from "@cognia/agent-trace/emitter"

import { errorMessageOf, errorTypeOf, instrumentSpan } from "./instrument"

function captureWriter(): AgentTraceSpan[] {
  const spans: AgentTraceSpan[] = []
  setAgentTraceWriter((span) => spans.push(span))
  return spans
}

const BASE = {
  operationName: "retrieval",
  providerName: "cognia.plugin",
  sessionId: "session-1",
  surface: "retrieval",
} as const

beforeEach(() => {
  __resetAgentTraceEmitterForTesting()
})

describe("instrumentSpan", () => {
  it("settles the span and returns the operation's value unchanged", async () => {
    const spans = captureWriter()
    const value = await instrumentSpan(BASE, async () => ({ rows: 3 }))
    expect(value).toEqual({ rows: 3 })
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      operationName: "retrieval",
      surface: "retrieval",
      status: "ok",
    })
  })

  it("settles the span and rethrows on failure", async () => {
    const spans = captureWriter()
    await expect(
      instrumentSpan(BASE, async () => {
        throw new TypeError("store unreachable")
      })
    ).rejects.toThrow("store unreachable")
    // The whole point: an early throw between start and end used to leak an
    // in-flight span that `reapStaleSpans` only settled half an hour later.
    expect(spans).toHaveLength(1)
    expect(spans[0]).toMatchObject({
      status: "error",
      errorType: "TypeError",
      errorMessage: "store unreachable",
    })
  })

  it("leaves no span in flight either way", async () => {
    captureWriter()
    let capturedId = ""
    await instrumentSpan(BASE, async (spanId) => {
      capturedId = spanId
      expect(__getActiveSpanForTesting(spanId)).toBeDefined()
    })
    expect(__getActiveSpanForTesting(capturedId)).toBeUndefined()

    await instrumentSpan(BASE, async (spanId) => {
      capturedId = spanId
      throw new Error("nope")
    }).catch(() => undefined)
    expect(__getActiveSpanForTesting(capturedId)).toBeUndefined()
  })

  it("merges the outcome the operation reports once its result is known", async () => {
    const spans = captureWriter()
    await instrumentSpan(
      { ...BASE, metadata: { collection: "notes" } },
      async () => [{ score: 0.9 }],
      (rows) => ({ metadata: { hitCount: rows.length, topScore: rows[0]?.score } })
    )
    expect(spans[0].metadata).toEqual({ collection: "notes", hitCount: 1, topScore: 0.9 })
  })

  it("hands the span id to the operation so it can nest children", async () => {
    captureWriter()
    const seen = await instrumentSpan(BASE, async (spanId) => spanId)
    expect(seen).toMatch(/^[0-9a-f]{16}$/)
  })
})

describe("errorTypeOf / errorMessageOf", () => {
  it("reports the constructor name, not the message", () => {
    // `error.type` in OTel means the class; messages are free-form and often
    // embed a path or an identifier.
    expect(errorTypeOf(new RangeError("out of range"))).toBe("RangeError")
    expect(errorTypeOf("plain string")).toBe("Error")
    expect(errorTypeOf({ weird: true })).toBe("UnknownError")
  })

  it("bounds the message", () => {
    // A provider error can embed an entire response body.
    expect(errorMessageOf(new Error("x".repeat(2000)))).toHaveLength(512)
    expect(errorMessageOf("short")).toBe("short")
    expect(errorMessageOf(42)).toBe("42")
  })
})
