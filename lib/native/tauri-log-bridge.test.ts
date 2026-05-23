/**
 * @jest-environment jsdom
 *
 * Tests for native/tauri-log-bridge.
 */

let isTauriValue = false
jest.mock("@/lib/tauri", () => ({
  isTauri: () => isTauriValue,
}))

const setTraceIdMock = jest.fn()
const clearTraceIdMock = jest.fn()
const createLogRuntimeContextMock = jest.fn((ctx: Record<string, unknown>) => ({ ...ctx }))
const nativeLoggerStub = {
  trace: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
}
const nativeChildLoggerStub = {
  trace: jest.fn(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
}
nativeLoggerStub.info = jest.fn()
const childMock = jest.fn((..._args: unknown[]) => nativeChildLoggerStub)

jest.mock("@/lib/logging", () => {
  const stub = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: (...args: unknown[]) => childMock(...args),
  }
  return {
    loggers: {
      app: stub,
      native: stub,
      scheduler: stub,
    },
    createLogRuntimeContext: (ctx: Record<string, unknown>) => createLogRuntimeContextMock(ctx),
    logContext: {
      setTraceId: (id: string) => setTraceIdMock(id),
      clearTraceId: () => clearTraceIdMock(),
    },
  }
})

const listenMock = jest.fn()
jest.mock(
  "@tauri-apps/api/event",
  () => ({
    listen: (event: string, cb: unknown) => listenMock(event, cb),
  }),
  { virtual: true }
)

import {
  initTauriLogBridge,
  cleanupTauriLogBridge,
  isTauriLogBridgeActive,
  getTauriLogBridgeStatus,
  forwardTauriLog,
} from "./tauri-log-bridge"

beforeEach(async () => {
  // Always cleanup so the singleton state resets between tests.
  await cleanupTauriLogBridge()
  isTauriValue = false
  listenMock.mockReset()
  setTraceIdMock.mockReset()
  clearTraceIdMock.mockReset()
  createLogRuntimeContextMock.mockClear()
  childMock.mockClear()
  Object.values(nativeChildLoggerStub).forEach((fn) => (fn as jest.Mock).mockReset?.())
})

describe("initTauriLogBridge", () => {
  it("marks the bridge inactive on web mode", async () => {
    await initTauriLogBridge()
    expect(isTauriLogBridgeActive()).toBe(false)
    const status = getTauriLogBridgeStatus()
    expect(status.state).toBe("inactive")
  })

  it("initializes a listener and routes incoming logs", async () => {
    isTauriValue = true
    let captured: ((event: { payload: unknown }) => void) | null = null
    const unlisten = jest.fn()
    listenMock.mockImplementationOnce(async (_evt, cb) => {
      captured = cb as (event: { payload: unknown }) => void
      return unlisten
    })

    await initTauriLogBridge()
    expect(isTauriLogBridgeActive()).toBe(true)
    expect(getTauriLogBridgeStatus().state).toBe("active")
    expect(listenMock).toHaveBeenCalledWith("log://log", expect.any(Function))

    // Simulate Rust emitting a log event with a trace id and data object.
    captured!({
      payload: {
        level: "INFO",
        target: "app_lib::module::sub",
        message: "hello",
        timestamp: "2025-01-01T00:00:00Z",
        traceId: "trace-1",
        data: { key: "val" },
      },
    })

    expect(setTraceIdMock).toHaveBeenCalledWith("trace-1")
    expect(clearTraceIdMock).toHaveBeenCalled()
    expect(childMock).toHaveBeenCalledWith("module:sub")
    expect(nativeChildLoggerStub.info).toHaveBeenCalledWith("hello", expect.any(Object))
  })

  it("is idempotent — does not re-register on repeat calls", async () => {
    isTauriValue = true
    listenMock.mockImplementation(async () => () => undefined)
    await initTauriLogBridge()
    await initTauriLogBridge()
    expect(listenMock).toHaveBeenCalledTimes(1)
  })

  it("captures degraded status when listen() throws", async () => {
    isTauriValue = true
    listenMock.mockRejectedValueOnce(new Error("listen failed"))
    await initTauriLogBridge()
    expect(isTauriLogBridgeActive()).toBe(false)
    const status = getTauriLogBridgeStatus()
    expect(status.state).toBe("degraded")
    expect(status.lastError).toBe("listen failed")
  })

  it("coerces non-Error rejections to a string", async () => {
    isTauriValue = true
    listenMock.mockRejectedValueOnce("boom-string")
    await initTauriLogBridge()
    expect(getTauriLogBridgeStatus().lastError).toBe("boom-string")
  })
})

describe("cleanupTauriLogBridge", () => {
  it("runs the unlisten function and resets state", async () => {
    isTauriValue = true
    const unlisten = jest.fn()
    listenMock.mockImplementationOnce(async () => unlisten)
    await initTauriLogBridge()
    await cleanupTauriLogBridge()
    expect(unlisten).toHaveBeenCalled()
    expect(isTauriLogBridgeActive()).toBe(false)
    expect(getTauriLogBridgeStatus().state).toBe("inactive")
  })

  it("handles async unlisten functions", async () => {
    isTauriValue = true
    const unlisten = jest.fn(async () => undefined)
    listenMock.mockImplementationOnce(async () => unlisten)
    await initTauriLogBridge()
    await cleanupTauriLogBridge()
    expect(unlisten).toHaveBeenCalled()
  })

  it("is safe to call when the bridge was never initialized", async () => {
    await expect(cleanupTauriLogBridge()).resolves.toBeUndefined()
  })
})

describe("forwardTauriLog", () => {
  it("does nothing for falsy payloads", () => {
    forwardTauriLog(null as unknown as Record<string, unknown>)
    forwardTauriLog(undefined as unknown as Record<string, unknown>)
    expect(nativeChildLoggerStub.info).not.toHaveBeenCalled()
  })

  it("routes a normalised payload to the matching log level", () => {
    forwardTauriLog({
      level: "WARN",
      target: "mod",
      message: "careful",
    })
    expect(nativeChildLoggerStub.warn).toHaveBeenCalledWith("careful", expect.any(Object))
  })

  it("falls back to default level when the level string is unknown", () => {
    forwardTauriLog({
      level: "WHATEVER",
      target: "app_lib::other",
      message: "m",
    })
    expect(nativeChildLoggerStub.info).toHaveBeenCalled()
  })

  it("handles all canonical levels", () => {
    const cases: Array<{ level: string; method: keyof typeof nativeChildLoggerStub }> = [
      { level: "TRACE", method: "trace" },
      { level: "DEBUG", method: "debug" },
      { level: "INFO", method: "info" },
      { level: "WARN", method: "warn" },
      { level: "WARNING", method: "warn" },
      { level: "ERROR", method: "error" },
      { level: "FATAL", method: "fatal" },
    ]
    for (const { level, method } of cases) {
      ;(nativeChildLoggerStub[method] as jest.Mock).mockClear?.()
      forwardTauriLog({ level, target: "t", message: "m" })
      expect(nativeChildLoggerStub[method]).toHaveBeenCalled()
    }
  })

  it("reads JSON-encoded data fields when present", () => {
    forwardTauriLog({
      level: "INFO",
      target: "mod",
      message: "m",
      meta: JSON.stringify({ a: 1 }),
    })
    expect(createLogRuntimeContextMock).toHaveBeenCalled()
    const ctx = createLogRuntimeContextMock.mock.calls.at(-1)?.[0] as Record<string, unknown>
    expect(ctx.a).toBe(1)
  })

  it("ignores non-object/non-array fields and bad JSON", () => {
    forwardTauriLog({
      level: "INFO",
      target: "mod",
      message: "m",
      data: "not-json",
      metadata: ["a", "b"],
      context: 42,
    })
    expect(nativeChildLoggerStub.info).toHaveBeenCalled()
  })

  it('falls back to "[tauri log]" when no message-like field exists', () => {
    forwardTauriLog({
      level: "INFO",
      target: "mod",
    })
    expect(nativeChildLoggerStub.info).toHaveBeenCalledWith("[tauri log]", expect.any(Object))
  })

  it("reads error/reason when message is missing", () => {
    forwardTauriLog({
      level: "ERROR",
      target: "mod",
      error: "boom",
    })
    expect(nativeChildLoggerStub.error).toHaveBeenCalledWith("boom", undefined, expect.any(Object))
  })

  it("skips trace id handling when not provided", () => {
    setTraceIdMock.mockClear()
    clearTraceIdMock.mockClear()
    forwardTauriLog({
      level: "INFO",
      target: "mod",
      message: "m",
    })
    expect(setTraceIdMock).not.toHaveBeenCalled()
    expect(clearTraceIdMock).not.toHaveBeenCalled()
  })

  it('falls back to "tauri" target when none provided', () => {
    forwardTauriLog({ level: "INFO", message: "m" })
    expect(childMock).toHaveBeenCalledWith("tauri")
  })
})

describe("normalizeEvent edge cases via forwardTauriLog", () => {
  it("returns null for non-object payloads", () => {
    forwardTauriLog(123 as unknown as Record<string, unknown>)
    forwardTauriLog("a-string" as unknown as Record<string, unknown>)
    expect(nativeChildLoggerStub.info).not.toHaveBeenCalled()
  })

  it("reads ts/createdAt as timestamp aliases", () => {
    forwardTauriLog({
      level: "INFO",
      target: "mod",
      message: "m",
      ts: "2025-02-02T00:00:00Z",
    })
    expect(nativeChildLoggerStub.info).toHaveBeenCalled()
  })
})
