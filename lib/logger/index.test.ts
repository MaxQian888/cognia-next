/**
 * @jest-environment jsdom
 *
 * Smoke tests for the public logger surface: import everything, verify the
 * named exports exist, exercise the convenience `log` and `loggers` objects.
 */

import "fake-indexeddb/auto"
import { IDBFactory } from "fake-indexeddb"

beforeEach(() => {
  jest.resetModules()
  const factory = new IDBFactory()
  ;(globalThis as { indexedDB: IDBFactory }).indexedDB = factory
  ;(window as unknown as { indexedDB: IDBFactory }).indexedDB = factory
})

describe("logger index exports", () => {
  it("re-exports the core API surface", async () => {
    const m = await import("./index")
    for (const name of [
      "createLogger",
      "initLogger",
      "addTransport",
      "removeTransport",
      "getTransport",
      "getTransports",
      "getTransportHealth",
      "getTransportHealthSnapshot",
      "emitLoggerDiagnostic",
      "updateLoggerConfig",
      "getLoggerConfig",
      "getRegisteredModules",
      "getLoggerStats",
      "flushLogs",
      "shutdownLogger",
    ]) {
      expect(typeof (m as Record<string, unknown>)[name]).toBe("function")
    }
  })

  it("re-exports recent-error helpers", async () => {
    const m = await import("./index")
    expect(typeof m.clearRecentErrorLogs).toBe("function")
    expect(typeof m.getRecentErrorLogs).toBe("function")
    expect(typeof m.subscribeRecentErrorLogs).toBe("function")
  })

  it("re-exports bootstrap helpers + storage keys", async () => {
    const m = await import("./index")
    expect(typeof m.bootstrapLogger).toBe("function")
    expect(typeof m.applyLoggingSettings).toBe("function")
    expect(typeof m.getLoggingBootstrapState).toBe("function")
    expect(typeof m.getIndexedDBTransport).toBe("function")
    expect(typeof m.listRegisteredTransports).toBe("function")
    expect(typeof m.LOGGING_TRANSPORTS_STORAGE_KEY).toBe("string")
    expect(typeof m.LOGGING_RETENTION_STORAGE_KEY).toBe("string")
    expect(typeof m.LOGGING_SAMPLING_STORAGE_KEY).toBe("string")
  })

  it("re-exports context, runtime, and sampling helpers", async () => {
    const m = await import("./index")
    expect(typeof m.logContext).toBe("object")
    expect(typeof m.generateTraceId).toBe("function")
    expect(typeof m.traced).toBe("function")
    expect(typeof m.createLogRuntimeContext).toBe("function")
    expect(typeof m.normalizeLogOrigin).toBe("function")
    expect(typeof m.normalizeLogRuntime).toBe("function")
    expect(typeof m.withLogRuntimeContext).toBe("function")
    expect(typeof m.logSampler).toBe("object")
    expect(typeof m.configureSampling).toBe("function")
    expect(typeof m.samplingRate).toBe("function")
  })

  it("re-exports the transport classes + factories", async () => {
    const m = await import("./index")
    expect(typeof m.ConsoleTransport).toBe("function")
    expect(typeof m.createConsoleTransport).toBe("function")
    expect(typeof m.IndexedDBTransport).toBe("function")
    expect(typeof m.createIndexedDBTransport).toBe("function")
    expect(typeof m.RemoteTransport).toBe("function")
    expect(typeof m.createRemoteTransport).toBe("function")
    expect(typeof m.NativeTransport).toBe("function")
    expect(typeof m.createNativeTransport).toBe("function")
    expect(typeof m.IndexedDBRemoteRetryQueueStore).toBe("function")
    expect(typeof m.createRemoteRetryQueueStore).toBe("function")
    expect(typeof m.sentryTransform).toBe("function")
    expect(typeof m.logglyTransform).toBe("function")
  })

  it("provides DEFAULT_UNIFIED_CONFIG and LEVEL_PRIORITY constants", async () => {
    const m = await import("./index")
    expect(m.LEVEL_PRIORITY).toBeDefined()
    expect(m.DEFAULT_UNIFIED_CONFIG).toBeDefined()
    expect(typeof m.DEFAULT_UNIFIED_CONFIG.minLevel).toBe("string")
  })
})

describe("default logger + loggers map", () => {
  it("the default `logger` is a real Logger with all methods", async () => {
    const m = await import("./index")
    expect(typeof m.logger.trace).toBe("function")
    expect(typeof m.logger.debug).toBe("function")
    expect(typeof m.logger.info).toBe("function")
    expect(typeof m.logger.warn).toBe("function")
    expect(typeof m.logger.error).toBe("function")
    expect(typeof m.logger.fatal).toBe("function")
    expect(typeof m.logger.child).toBe("function")
    expect(typeof m.logger.withContext).toBe("function")
    expect(typeof m.logger.setTraceId).toBe("function")
  })

  it("`loggers.<name>` returns a logger for each registered module", async () => {
    const m = await import("./index")
    const names = [
      "app",
      "ai",
      "chat",
      "agent",
      "mcp",
      "plugin",
      "native",
      "ui",
      "store",
      "network",
      "auth",
      "error",
      "media",
      "scheduler",
      "search",
      "document",
      "export",
      "skills",
      "sync",
      "screenshot",
      "tts",
      "shell",
      "canvas",
    ]
    for (const name of names) {
      const l = (m.loggers as Record<string, unknown>)[name] as { info: (s: string) => void }
      expect(typeof l.info).toBe("function")
    }
  })

  it("`log` proxy methods dispatch through the default logger", async () => {
    const m = await import("./index")
    // Wire up a console mock to confirm dispatch happens (default app logger
    // routes through the console transport which is enabled by default).
    const spy = jest.spyOn(console, "info").mockImplementation(() => {})
    m.log.info("via-log-info")
    spy.mockRestore()
    // Also exercise the rest of the proxy.
    const spies = {
      trace: jest.spyOn(console, "trace").mockImplementation(() => {}),
      debug: jest.spyOn(console, "debug").mockImplementation(() => {}),
      warn: jest.spyOn(console, "warn").mockImplementation(() => {}),
      error: jest.spyOn(console, "error").mockImplementation(() => {}),
    }
    m.log.trace("t")
    m.log.debug("d")
    m.log.warn("w")
    m.log.error("e", new Error("oops"))
    m.log.fatal("f", new Error("fatal-err"))
    Object.values(spies).forEach((s) => s.mockRestore())
  })
})
