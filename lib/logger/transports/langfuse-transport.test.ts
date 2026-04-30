/**
 * @jest-environment jsdom
 */

import type { StructuredLogEntry } from "../types"

// We mock the langfuse-client module that the transport lazy-imports.
const mockSpan = {
  end: jest.fn(),
}

const mockTrace = {
  end: jest.fn(),
}

const mockLangfuse = {
  flush: jest.fn(async () => undefined),
}

const mockGetLangfuse = jest.fn(async () => mockLangfuse)
const mockCreateChatTrace = jest.fn(async () => mockTrace)
const mockCreateSpan = jest.fn(() => mockSpan)

let langfuseModuleAvailable = true

jest.mock("@/lib/ai/observability/langfuse-client", () => ({
  __esModule: true,
  getLangfuse: (...args: unknown[]) => mockGetLangfuse(...args),
  createChatTrace: (...args: unknown[]) => mockCreateChatTrace(...args),
  createSpan: (...args: unknown[]) => mockCreateSpan(...args),
}))

beforeEach(() => {
  jest.clearAllMocks()
  langfuseModuleAvailable = true
  mockGetLangfuse.mockResolvedValue(mockLangfuse)
})

function makeEntry(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id: "log-1",
    timestamp: "2026-04-30T10:00:00.000Z",
    level: overrides.level ?? "warn",
    message: "hello",
    module: "test",
    ...overrides,
  }
}

describe("LangfuseTransport buffering + level filter", () => {
  it("buffers entries below batch size", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 5, flushInterval: 60_000 })
    t.log(makeEntry({ level: "warn" }))
    t.log(makeEntry({ level: "error" }))
    // No auto flush yet — count below batchSize.
    expect(mockGetLangfuse).not.toHaveBeenCalled()
    await t.close()
  })

  it("filters out entries below minLevel", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 1, minLevel: "error" })
    t.log(makeEntry({ level: "info" }))
    t.log(makeEntry({ level: "warn" }))
    // None should hit the buffer because both are below min level error.
    await t.close()
    expect(mockCreateChatTrace).not.toHaveBeenCalled()
  })

  it("auto-flushes when batch size is hit", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 1, flushInterval: 60_000, includeData: false })
    t.log(makeEntry({ level: "warn", traceId: "trace-A" }))
    // Drain the microtasks scheduled by the auto-flush.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(mockGetLangfuse).toHaveBeenCalled()
    await t.close()
  })
})

describe("LangfuseTransport.flush behavior", () => {
  it("groups entries by traceId and creates one trace per group", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 99, flushInterval: 60_000 })
    t.log(makeEntry({ level: "error", traceId: "t1", message: "m1" }))
    t.log(makeEntry({ level: "warn", traceId: "t1", message: "m2" }))
    t.log(makeEntry({ level: "error", traceId: "t2", message: "m3" }))
    await t.flush()
    expect(mockCreateChatTrace).toHaveBeenCalledTimes(2)
    // 3 spans were created across 2 traces.
    expect(mockCreateSpan).toHaveBeenCalledTimes(3)
    expect(mockTrace.end).toHaveBeenCalledTimes(2)
    expect(mockSpan.end).toHaveBeenCalledTimes(3)
    expect(mockLangfuse.flush).toHaveBeenCalled()
    await t.close()
  })

  it("uses sessionId as fallback when traceId is missing", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 99, flushInterval: 60_000 })
    t.log(makeEntry({ level: "error", sessionId: "session-A" }))
    await t.flush()
    expect(mockCreateChatTrace).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session-A" })
    )
    await t.close()
  })

  it("uses 'default' when both traceId and sessionId are missing", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 99, flushInterval: 60_000 })
    t.log(makeEntry({ level: "error" }))
    await t.flush()
    expect(mockCreateChatTrace).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "default" })
    )
    await t.close()
  })

  it("includes data, stack, and source in metadata when present", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 99, flushInterval: 60_000 })
    t.log(
      makeEntry({
        level: "error",
        data: { hello: "world" },
        stack: "Error: x",
        source: { file: "a.ts", line: 1 },
      })
    )
    await t.flush()
    const metadata = mockCreateSpan.mock.calls[0][1].metadata
    expect(metadata).toMatchObject({
      module: "test",
      level: "error",
      data: { hello: "world" },
      stack: "Error: x",
      source: { file: "a.ts", line: 1 },
    })
    await t.close()
  })

  it("omits data + stack from metadata when options disable them", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({
      batchSize: 99,
      flushInterval: 60_000,
      includeData: false,
      includeStack: false,
    })
    t.log(makeEntry({ level: "error", data: { x: 1 }, stack: "boom" }))
    await t.flush()
    const metadata = mockCreateSpan.mock.calls[0][1].metadata
    expect(metadata).not.toHaveProperty("data")
    expect(metadata).not.toHaveProperty("stack")
    await t.close()
  })

  it("flush() is a no-op when buffer is empty", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 99, flushInterval: 60_000 })
    await t.flush()
    expect(mockGetLangfuse).not.toHaveBeenCalled()
    await t.close()
  })

  it("returns silently when getLangfuse() returns null", async () => {
    mockGetLangfuse.mockResolvedValueOnce(null as unknown as typeof mockLangfuse)
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 99, flushInterval: 60_000 })
    t.log(makeEntry({ level: "error" }))
    await t.flush()
    expect(mockCreateChatTrace).not.toHaveBeenCalled()
    await t.close()
  })

  it("re-buffers entries when flush throws (under 100 buffer size)", async () => {
    mockGetLangfuse.mockRejectedValueOnce(new Error("network down"))
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 99, flushInterval: 60_000 })
    t.log(makeEntry({ level: "error" }))
    await t.flush()
    // The next successful flush should still drain the re-queued entries.
    mockGetLangfuse.mockResolvedValueOnce(mockLangfuse)
    await t.flush()
    expect(mockCreateChatTrace).toHaveBeenCalled()
    await t.close()
  })

  it("level mapping covers all levels", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 99, flushInterval: 60_000, minLevel: "trace" })
    t.log(makeEntry({ level: "trace" }))
    t.log(makeEntry({ level: "debug" }))
    t.log(makeEntry({ level: "info" }))
    t.log(makeEntry({ level: "warn" }))
    t.log(makeEntry({ level: "error" }))
    t.log(makeEntry({ level: "fatal" }))
    await t.flush()
    const levels = mockCreateSpan.mock.calls.map((c) => c[1].level)
    expect(levels).toEqual(expect.arrayContaining(["DEBUG", "DEFAULT", "WARNING", "ERROR"]))
    await t.close()
  })
})

describe("LangfuseTransport flush timer and close", () => {
  it("close() clears the flush timer and runs a final flush", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 99, flushInterval: 1000 })
    t.log(makeEntry({ level: "error" }))
    await t.close()
    expect(mockCreateChatTrace).toHaveBeenCalled()
  })

  it("flush timer auto-fires periodically", async () => {
    jest.useFakeTimers()
    try {
      const { LangfuseTransport } = await import("./langfuse-transport")
      const t = new LangfuseTransport({ batchSize: 99, flushInterval: 1000 })
      t.log(makeEntry({ level: "error" }))
      // Trigger the setInterval tick.
      jest.advanceTimersByTime(1100)
      jest.useRealTimers()
      // Drain the promise chain triggered by setInterval.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(mockGetLangfuse).toHaveBeenCalled()
      await t.close()
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("LangfuseTransport when langfuse-client is unavailable", () => {
  beforeEach(() => {
    jest.resetModules()
    jest.doMock("@/lib/ai/observability/langfuse-client", () => {
      throw new Error("no langfuse")
    })
  })

  it("flush silently no-ops when the client module fails to load", async () => {
    const { LangfuseTransport } = await import("./langfuse-transport")
    const t = new LangfuseTransport({ batchSize: 99, flushInterval: 60_000 })
    t.log(makeEntry({ level: "error" }))
    await t.flush()
    // No exception thrown; second flush returns immediately without re-import.
    await t.flush()
    await t.close()
  })
})

describe("createLangfuseTransport factory", () => {
  it("returns an instance with the right name", async () => {
    const { createLangfuseTransport } = await import("./langfuse-transport")
    const t = createLangfuseTransport({ batchSize: 5 })
    expect(t.name).toBe("langfuse")
    await t.close()
  })

  it("supports default options", async () => {
    const { createLangfuseTransport } = await import("./langfuse-transport")
    const t = createLangfuseTransport()
    expect(t.name).toBe("langfuse")
    await t.close()
  })
})

void langfuseModuleAvailable
