/**
 * @jest-environment jsdom
 */

import { generateTraceId, logContext, traced } from "./context"

beforeEach(() => {
  logContext.clearTraceId()
  logContext.clearContext()
})

describe("generateTraceId", () => {
  it("produces a 32-char lowercase hex string", () => {
    const id = generateTraceId()
    expect(id).toMatch(/^[a-f0-9]{32}$/)
  })

  it("generates unique values across calls", () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateTraceId()))
    expect(ids.size).toBe(50)
  })
})

describe("logContext singleton", () => {
  it("exposes a stable session id (persisted in sessionStorage)", () => {
    const a = logContext.sessionId
    const b = logContext.sessionId
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{32}$/)
    // Stored under the documented key — guards against accidental rename.
    expect(sessionStorage.getItem("cognia-log-session-id")).toBe(a)
  })

  it("setTraceId / clearTraceId round-trip", () => {
    expect(logContext.traceId).toBeUndefined()
    logContext.setTraceId("custom-trace")
    expect(logContext.traceId).toBe("custom-trace")
    logContext.clearTraceId()
    expect(logContext.traceId).toBeUndefined()
  })

  it("newTraceId returns a fresh id and stores it", () => {
    const id = logContext.newTraceId()
    expect(id).toMatch(/^[a-f0-9]{32}$/)
    expect(logContext.traceId).toBe(id)
  })

  it("setContext merges values; clearContext resets", () => {
    logContext.setContext({ user: "alice" })
    logContext.setContext({ role: "admin" })
    expect(logContext.context).toEqual({ user: "alice", role: "admin" })
    logContext.clearContext()
    expect(logContext.context).toEqual({})
  })

  it("withTrace establishes a fresh trace id for the duration of fn() then restores", () => {
    logContext.setTraceId("outer")
    let observed: string | undefined
    const result = logContext.withTrace(() => {
      observed = logContext.traceId
      return 42
    })
    expect(result).toBe(42)
    expect(observed).toMatch(/^[a-f0-9]{32}$/)
    expect(observed).not.toBe("outer")
    expect(logContext.traceId).toBe("outer")
  })

  it("withTraceAsync awaits and then restores the previous trace id", async () => {
    logContext.setTraceId("outer")
    let observed: string | undefined
    const result = await logContext.withTraceAsync(async () => {
      observed = logContext.traceId
      return "done"
    })
    expect(result).toBe("done")
    expect(observed).not.toBe("outer")
    expect(logContext.traceId).toBe("outer")
  })

  it("withTrace restores the previous id even when fn throws", () => {
    logContext.setTraceId("outer")
    expect(() =>
      logContext.withTrace(() => {
        throw new Error("boom")
      })
    ).toThrow("boom")
    expect(logContext.traceId).toBe("outer")
  })

  it("withTraceAsync restores the previous id even when fn rejects", async () => {
    logContext.setTraceId("outer")
    await expect(
      logContext.withTraceAsync(async () => {
        throw new Error("boom-async")
      })
    ).rejects.toThrow("boom-async")
    expect(logContext.traceId).toBe("outer")
  })
})

describe("traced()", () => {
  it("wraps an async fn so each call runs with a fresh trace id", async () => {
    const seen: Array<string | undefined> = []
    const fn = traced(async (n: number) => {
      seen.push(logContext.traceId)
      return n * 2
    })
    expect(await fn(2)).toBe(4)
    expect(await fn(3)).toBe(6)
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatch(/^[a-f0-9]{32}$/)
    expect(seen[1]).toMatch(/^[a-f0-9]{32}$/)
    expect(seen[0]).not.toBe(seen[1])
  })
})

describe("span context", () => {
  it("has no active span outside of withSpan", () => {
    expect(logContext.spanId).toBeUndefined()
    expect(logContext.parentSpanId).toBeUndefined()
  })

  it("sets and restores spanId around withSpan", () => {
    let inside: string | undefined
    logContext.withSpan(() => {
      inside = logContext.spanId
    })
    expect(inside).toMatch(/^[a-f0-9]{16}$/)
    expect(logContext.spanId).toBeUndefined()
  })

  it("links nested spans via parentSpanId", () => {
    let outerId: string | undefined
    let innerId: string | undefined
    let innerParent: string | undefined
    logContext.withSpan(() => {
      outerId = logContext.spanId
      logContext.withSpan(() => {
        innerId = logContext.spanId
        innerParent = logContext.parentSpanId
      })
      // After the inner span pops, the active span is the outer one again.
      expect(logContext.spanId).toBe(outerId)
    })
    expect(innerId).not.toBe(outerId)
    expect(innerParent).toBe(outerId)
  })

  it("restores the span stack even when the callback throws", () => {
    expect(() =>
      logContext.withSpan(() => {
        throw new Error("boom")
      })
    ).toThrow("boom")
    expect(logContext.spanId).toBeUndefined()
  })

  it("supports async spans and restores on rejection", async () => {
    let inside: string | undefined
    await logContext.withSpanAsync(async () => {
      inside = logContext.spanId
    })
    expect(inside).toMatch(/^[a-f0-9]{16}$/)
    expect(logContext.spanId).toBeUndefined()

    await expect(
      logContext.withSpanAsync(async () => {
        throw new Error("async-boom")
      })
    ).rejects.toThrow("async-boom")
    expect(logContext.spanId).toBeUndefined()
  })
})
