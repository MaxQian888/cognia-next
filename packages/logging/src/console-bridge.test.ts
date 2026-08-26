import { addTransport, createLogger, initLogger } from "./core"
import { installConsoleBridge } from "./console-bridge"
import type { StructuredLogEntry } from "./types"

describe("console bridge", () => {
  beforeEach(() => {
    initLogger({ enableConsole: false, includeSource: false })
  })

  it("routes warn and error calls through the unified logger", () => {
    const entries: StructuredLogEntry[] = []
    addTransport({ name: "capture", log: (entry) => entries.push(entry) })
    const originalWarn = jest.fn()
    const originalError = jest.fn()
    const consoleTarget = { warn: originalWarn, error: originalError }
    const cleanup = installConsoleBridge({
      console: consoleTarget,
      logger: createLogger("legacy.console"),
    })

    consoleTarget.warn("window operation failed", new Error("permission denied"), { retry: 2 })
    consoleTarget.error("sync crashed", new Error("offline"), { queueDepth: 3 })

    expect(entries).toMatchObject([
      {
        level: "warn",
        module: "legacy.console",
        message: "window operation failed",
        data: {
          arguments: [
            { name: "Error", message: "permission denied", stack: expect.any(String) },
            { retry: 2 },
          ],
        },
      },
      {
        level: "error",
        module: "legacy.console",
        message: "sync crashed",
        data: {
          errorName: "Error",
          errorMessage: "offline",
          arguments: [{ queueDepth: 3 }],
        },
      },
    ])
    // The bridge ADDS a sink, it never replaces the console: the original is
    // called with the caller's own args every time, so an entry the logger
    // drops (no transport yet, console transport off, minLevel, sampling)
    // cannot swallow console output.
    expect(originalWarn).toHaveBeenCalledWith("window operation failed", expect.any(Error), {
      retry: 2,
    })
    expect(originalError).toHaveBeenCalledWith("sync crashed", expect.any(Error), {
      queueDepth: 3,
    })

    cleanup()
    expect(consoleTarget.warn).toBe(originalWarn)
    expect(consoleTarget.error).toBe(originalError)
  })

  it("falls back to the original console method when a transport re-enters the bridge", () => {
    const originalWarn = jest.fn()
    const consoleTarget = { warn: originalWarn, error: jest.fn() }
    addTransport({
      name: "reentrant",
      log: (entry) => consoleTarget.warn("transport output", entry.message),
    })
    installConsoleBridge({ console: consoleTarget, logger: createLogger("legacy.console") })

    consoleTarget.warn("outer warning")

    expect(originalWarn).toHaveBeenCalledWith("transport output", "outer warning")
  })

  it("normalizes console-shaped edge cases and installs idempotently", () => {
    const entries: StructuredLogEntry[] = []
    addTransport({ name: "capture-edge", log: (entry) => entries.push(entry) })
    const originalError = jest.fn()
    const consoleTarget = { warn: jest.fn(), error: originalError }
    const cleanup = installConsoleBridge({ console: consoleTarget })

    expect(installConsoleBridge({ console: consoleTarget })).toBe(cleanup)
    consoleTarget.warn({ retry: 2 })
    consoleTarget.error("plain failure")
    consoleTarget.error(new Error("first argument"))

    expect(entries.filter((entry) => entry.message !== "transport output")).toMatchObject([
      {
        level: "warn",
        message: "Console warn",
        data: { arguments: [{ retry: 2 }] },
      },
      { level: "error", message: "plain failure" },
      {
        level: "error",
        message: "Console error",
        data: { errorName: "Error", errorMessage: "first argument" },
      },
    ])

    const replacementWarn = jest.fn()
    consoleTarget.warn = replacementWarn
    cleanup()
    expect(consoleTarget.warn).toBe(replacementWarn)
    expect(consoleTarget.error).toBe(originalError)
  })

  it("is a no-op without a browser console target", () => {
    expect(() => installConsoleBridge()()).not.toThrow()
  })
})
