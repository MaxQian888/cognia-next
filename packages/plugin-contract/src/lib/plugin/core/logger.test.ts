/**
 * Plugin System Logger Tests
 *
 * The source module calls createLogger('plugin') at the top level during import,
 * so we must define all mock functions inside the jest.mock factory (which runs
 * before any const/let bindings in this file are initialized).  We stash the
 * mock fns on a global key so test code can access them after import.
 */

interface MockFns {
  trace: jest.Mock
  debug: jest.Mock
  info: jest.Mock
  warn: jest.Mock
  error: jest.Mock
  fatal: jest.Mock
  child: jest.Mock
  withContext: jest.Mock
}

jest.mock("@cognia/logging", () => {
  const fns: MockFns = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn(),
    withContext: jest.fn(),
  }

  // Make the logger object self-referencing for child/withContext
  const loggerObj = { ...fns }
  fns.child.mockReturnValue(loggerObj)
  fns.withContext.mockReturnValue(loggerObj)

  // Stash on globalThis so tests can reach the mock fns
  ;(globalThis as Record<string, unknown>).__pluginLoggerMocks = fns

  return {
    createLogger: jest.fn(() => loggerObj),
  }
})

// Retrieve mock fns after jest.mock has run
const mocks = (globalThis as Record<string, unknown>).__pluginLoggerMocks as MockFns

import { createPluginSystemLogger, pluginLogger, loggers } from "./logger"

afterAll(() => {
  delete (globalThis as Record<string, unknown>).__pluginLoggerMocks
})

describe("createPluginSystemLogger", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Restore child/withContext return values after clearAllMocks
    const loggerObj = {
      trace: mocks.trace,
      debug: mocks.debug,
      info: mocks.info,
      warn: mocks.warn,
      error: mocks.error,
      fatal: mocks.fatal,
      child: mocks.child,
      withContext: mocks.withContext,
    }
    mocks.child.mockReturnValue(loggerObj)
    mocks.withContext.mockReturnValue(loggerObj)
  })

  it("returns an object with all log level methods", () => {
    const logger = createPluginSystemLogger("test")
    expect(typeof logger.trace).toBe("function")
    expect(typeof logger.debug).toBe("function")
    expect(typeof logger.info).toBe("function")
    expect(typeof logger.warn).toBe("function")
    expect(typeof logger.error).toBe("function")
    expect(typeof logger.fatal).toBe("function")
  })

  it("returns child and withContext methods", () => {
    const logger = createPluginSystemLogger("test")
    expect(typeof logger.child).toBe("function")
    expect(typeof logger.withContext).toBe("function")
  })

  it("delegates trace to underlying logger", () => {
    const logger = createPluginSystemLogger("test")
    logger.trace("trace message")
    expect(mocks.trace).toHaveBeenCalledWith("trace message", undefined)
  })

  it("delegates debug to underlying logger", () => {
    const logger = createPluginSystemLogger("test")
    logger.debug("debug message")
    expect(mocks.debug).toHaveBeenCalledWith("debug message", undefined)
  })

  it("delegates info to underlying logger", () => {
    const logger = createPluginSystemLogger("test")
    logger.info("info message")
    expect(mocks.info).toHaveBeenCalledWith("info message", undefined)
  })

  it("delegates warn to underlying logger", () => {
    const logger = createPluginSystemLogger("test")
    logger.warn("warn message")
    expect(mocks.warn).toHaveBeenCalledWith("warn message", undefined)
  })

  it("delegates error with Error objects", () => {
    const logger = createPluginSystemLogger("test")
    const err = new Error("boom")
    logger.error("error message", err)
    expect(mocks.error).toHaveBeenCalledWith("error message", err, undefined)
  })

  it("delegates fatal with Error objects", () => {
    const logger = createPluginSystemLogger("test")
    const err = new Error("fatal")
    logger.fatal("fatal message", err)
    expect(mocks.fatal).toHaveBeenCalledWith("fatal message", err, undefined)
  })

  it("passes plain object args as data", () => {
    const logger = createPluginSystemLogger("test")
    logger.info("msg", { key: "value" })
    expect(mocks.info).toHaveBeenCalledWith("msg", { key: "value" })
  })

  it("merges multiple plain objects", () => {
    const logger = createPluginSystemLogger("test")
    logger.info("msg", { a: 1 }, { b: 2 })
    expect(mocks.info).toHaveBeenCalledWith("msg", { a: 1, b: 2 })
  })

  it("wraps non-object, non-error args as arg", () => {
    const logger = createPluginSystemLogger("test")
    logger.info("msg", "extra")
    expect(mocks.info).toHaveBeenCalledWith("msg", { arg: "extra" })
  })

  it("wraps multiple non-object extras as args array", () => {
    const logger = createPluginSystemLogger("test")
    logger.info("msg", "a", "b")
    expect(mocks.info).toHaveBeenCalledWith("msg", { args: ["a", "b"] })
  })

  it("child returns a new logger wrapper", () => {
    const logger = createPluginSystemLogger("test")
    const child = logger.child("sub")
    expect(mocks.child).toHaveBeenCalledWith("sub")
    expect(typeof child.info).toBe("function")
    expect(typeof child.child).toBe("function")
  })

  it("withContext returns a new logger wrapper", () => {
    const logger = createPluginSystemLogger("test")
    const ctx = logger.withContext({ requestId: "123" })
    expect(mocks.withContext).toHaveBeenCalledWith({ requestId: "123" })
    expect(typeof ctx.info).toBe("function")
  })
})

describe("pluginLogger", () => {
  it("is defined and has log methods", () => {
    expect(pluginLogger).toBeDefined()
    expect(typeof pluginLogger.info).toBe("function")
    expect(typeof pluginLogger.error).toBe("function")
  })
})

describe("loggers map", () => {
  const expectedKeys = [
    "manager",
    "loader",
    "registry",
    "sandbox",
    "hooks",
    "marketplace",
    "hotReload",
    "devServer",
    "ipc",
    "backup",
    "updater",
    "validation",
    "a2ui",
    "debugger",
    "messageBus",
    "agent",
    "i18n",
    "rollback",
    "signature",
    "workflow",
    "devTools",
  ]

  it("has all expected logger keys", () => {
    for (const key of expectedKeys) {
      expect(loggers).toHaveProperty(key)
    }
  })

  it("each logger has standard log methods", () => {
    for (const key of expectedKeys) {
      const logger = loggers[key as keyof typeof loggers]
      expect(typeof logger.info).toBe("function")
      expect(typeof logger.error).toBe("function")
      expect(typeof logger.warn).toBe("function")
      expect(typeof logger.debug).toBe("function")
    }
  })

  it("has exactly the expected number of loggers", () => {
    expect(Object.keys(loggers)).toHaveLength(expectedKeys.length)
  })
})
