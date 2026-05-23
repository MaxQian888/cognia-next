/**
 * @jest-environment jsdom
 */

import type { StructuredLogEntry } from "@/types/logging"

// Build a stateful mock of @opentelemetry/api so we can drive what
// trace.getActiveSpan() / trace.getTracer() return for each test.
const mockSpan = {
  addEvent: jest.fn(),
  setAttributes: jest.fn(),
  setStatus: jest.fn(),
  recordException: jest.fn(),
  end: jest.fn(),
  spanContext: jest.fn(() => ({ traceId: "trace-123", spanId: "span-456" })),
}

const mockTracer = {
  startActiveSpan: jest.fn(
    async <T>(_name: string, fn: (span: typeof mockSpan) => Promise<T>): Promise<T> => {
      return fn(mockSpan)
    }
  ),
}

let activeSpan: typeof mockSpan | null = mockSpan
let shouldFailImport = false

jest.mock("@opentelemetry/api", () => ({
  __esModule: true,
  trace: {
    getActiveSpan: jest.fn(() => activeSpan),
    getTracer: jest.fn(() => mockTracer),
  },
  SpanStatusCode: {
    OK: 1,
    ERROR: 2,
  },
}))

beforeEach(() => {
  jest.clearAllMocks()
  jest.resetModules()
  activeSpan = mockSpan
  shouldFailImport = false
})

function makeEntry(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id: "log-1",
    timestamp: "2026-04-30T10:00:00.000Z",
    level: overrides.level ?? "info",
    message: "hello",
    module: "test",
    ...overrides,
  }
}

describe("OtelTransport.log", () => {
  it("adds span event with attributes for info level", async () => {
    const { OtelTransport } = await import("./otel-transport")
    const t = new OtelTransport()
    t.log(makeEntry({ traceId: "tid", sessionId: "sid", data: { foo: "bar" } }))
    // logAsync is fire-and-forget; flush a microtask + macrotask.
    await new Promise((r) => setTimeout(r, 0))
    expect(mockSpan.addEvent).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({
        "log.level": "info",
        "log.module": "test",
        "log.traceId": "tid",
        "log.sessionId": "sid",
        "log.data": JSON.stringify({ foo: "bar" }),
      })
    )
  })

  it("does nothing if no active span", async () => {
    activeSpan = null
    const { OtelTransport } = await import("./otel-transport")
    const t = new OtelTransport()
    t.log(makeEntry())
    await new Promise((r) => setTimeout(r, 0))
    expect(mockSpan.addEvent).not.toHaveBeenCalled()
  })

  it("filters logs below minLevelForSpanEvents", async () => {
    const { OtelTransport } = await import("./otel-transport")
    const t = new OtelTransport({ minLevelForSpanEvents: "warn" })
    t.log(makeEntry({ level: "debug" }))
    await new Promise((r) => setTimeout(r, 0))
    expect(mockSpan.addEvent).not.toHaveBeenCalled()
  })

  it("records exceptions for error level when stack is present", async () => {
    const { OtelTransport } = await import("./otel-transport")
    const t = new OtelTransport()
    t.log(makeEntry({ level: "error", stack: "Error: bad\n  at fn" }))
    await new Promise((r) => setTimeout(r, 0))
    expect(mockSpan.recordException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ERROR",
        message: "hello",
        stack: "Error: bad\n  at fn",
      })
    )
    expect(mockSpan.setStatus).toHaveBeenCalled()
  })

  it("records fatal level as ERROR span status", async () => {
    const { OtelTransport } = await import("./otel-transport")
    const t = new OtelTransport()
    t.log(makeEntry({ level: "fatal", stack: "boom" }))
    await new Promise((r) => setTimeout(r, 0))
    expect(mockSpan.recordException).toHaveBeenCalledWith(
      expect.objectContaining({ name: "FATAL" })
    )
  })

  it("skips span event creation when addAsSpanEvents=false", async () => {
    const { OtelTransport } = await import("./otel-transport")
    const t = new OtelTransport({ addAsSpanEvents: false })
    t.log(makeEntry({ level: "warn" }))
    await new Promise((r) => setTimeout(r, 0))
    expect(mockSpan.addEvent).not.toHaveBeenCalled()
  })

  it("omits log.data attribute when includeDataInEvents=false", async () => {
    const { OtelTransport } = await import("./otel-transport")
    const t = new OtelTransport({ includeDataInEvents: false })
    t.log(makeEntry({ data: { x: 1 } }))
    await new Promise((r) => setTimeout(r, 0))
    const call = mockSpan.addEvent.mock.calls[0]
    expect(call?.[1]).not.toHaveProperty("log.data")
  })

  it("survives JSON.stringify failures on data without throwing", async () => {
    const { OtelTransport } = await import("./otel-transport")
    const t = new OtelTransport()
    const circular: Record<string, unknown> = {}
    circular.self = circular
    t.log(makeEntry({ data: circular as Record<string, unknown> }))
    await new Promise((r) => setTimeout(r, 0))
    // addEvent still called; the log.data attribute is just absent due to
    // the swallowed serialization error.
    expect(mockSpan.addEvent).toHaveBeenCalled()
  })

  it("flush() and close() resolve without throwing", async () => {
    const { OtelTransport } = await import("./otel-transport")
    const t = new OtelTransport()
    await expect(t.flush()).resolves.toBeUndefined()
    await expect(t.close()).resolves.toBeUndefined()
  })
})

describe("getOtelContext", () => {
  it("returns the trace and span IDs of the active span", async () => {
    const { getOtelContext } = await import("./otel-transport")
    const ctx = await getOtelContext()
    expect(ctx).toEqual({ traceId: "trace-123", spanId: "span-456" })
  })

  it("returns null when no active span exists", async () => {
    activeSpan = null
    const { getOtelContext } = await import("./otel-transport")
    expect(await getOtelContext()).toBeNull()
  })
})

describe("withOtelSpan", () => {
  it("wraps a function in a span and returns its result on success", async () => {
    const { withOtelSpan } = await import("./otel-transport")
    const result = await withOtelSpan("test-span", async () => "result", { foo: "bar" })
    expect(result).toBe("result")
    expect(mockTracer.startActiveSpan).toHaveBeenCalledWith("test-span", expect.any(Function))
    expect(mockSpan.setAttributes).toHaveBeenCalledWith({ foo: "bar" })
    expect(mockSpan.setStatus).toHaveBeenCalled()
    expect(mockSpan.end).toHaveBeenCalled()
  })

  it("does not call setAttributes when none are provided", async () => {
    const { withOtelSpan } = await import("./otel-transport")
    await withOtelSpan("no-attrs", async () => 42)
    expect(mockSpan.setAttributes).not.toHaveBeenCalled()
  })

  it("records exception and sets ERROR status on thrown Error", async () => {
    const { withOtelSpan } = await import("./otel-transport")
    const err = new Error("boom")
    await expect(
      withOtelSpan("test", async () => {
        throw err
      })
    ).rejects.toThrow("boom")
    expect(mockSpan.recordException).toHaveBeenCalledWith(err)
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: "boom" })
    expect(mockSpan.end).toHaveBeenCalled()
  })

  it("handles non-Error throw values", async () => {
    const { withOtelSpan } = await import("./otel-transport")
    await expect(
      withOtelSpan("test", async () => {
        throw "string-error"
      })
    ).rejects.toBe("string-error")
    expect(mockSpan.setStatus).toHaveBeenCalledWith({ code: 2, message: "string-error" })
  })
})

describe("createOtelTransport factory", () => {
  it("creates a default OtelTransport", async () => {
    const { createOtelTransport, OtelTransport } = await import("./otel-transport")
    const t = createOtelTransport()
    expect(t).toBeInstanceOf(OtelTransport)
  })

  it("propagates option overrides", async () => {
    const { createOtelTransport } = await import("./otel-transport")
    const t = createOtelTransport({ addAsSpanEvents: false })
    expect(t.name).toBe("opentelemetry")
  })
})

// We need a separate describe block to test failed-import behavior. Reset
// modules and force the dynamic import to fail.
describe("OtelTransport when @opentelemetry/api fails to load", () => {
  beforeEach(() => {
    jest.resetModules()
    jest.doMock("@opentelemetry/api", () => {
      throw new Error("unavailable")
    })
  })

  it("withOtelSpan calls the function directly when api unavailable", async () => {
    const { withOtelSpan } = await import("./otel-transport")
    const result = await withOtelSpan("noop", async () => "still-runs")
    expect(result).toBe("still-runs")
  })

  it("getOtelContext returns null when api unavailable", async () => {
    const { getOtelContext } = await import("./otel-transport")
    const ctx = await getOtelContext()
    expect(ctx).toBeNull()
  })

  it("OtelTransport.log silently swallows when api unavailable", async () => {
    const { OtelTransport } = await import("./otel-transport")
    const t = new OtelTransport()
    expect(() => t.log(makeEntry())).not.toThrow()
    await new Promise((r) => setTimeout(r, 0))
    // No exceptions, no crash
  })
})

// Mark shouldFailImport as used to avoid dead code lint complaints.
void shouldFailImport
