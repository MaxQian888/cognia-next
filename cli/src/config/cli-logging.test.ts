/**
 * @jest-environment node
 */
import {
  createLogger,
  getLoggerConfig,
  getTransports,
  initLogger,
  type StructuredLogEntry,
} from "@cognia/logging"

import {
  CLI_LOG_TRANSPORT,
  configureCliLogging,
  createCliLogTransport,
  defaultSink,
  formatCliLogLine,
  isLogLevel,
  resolveCliConsoleLevel,
} from "./cli-logging"

function entry(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id: "e1",
    timestamp: "2026-09-09T12:00:00.000Z",
    level: "info",
    message: "hello",
    module: "plugin:manager",
    ...overrides,
  }
}

describe("resolveCliConsoleLevel", () => {
  it("is quiet by default, verbose on request, and lets COGNIA_LOG_LEVEL decide", () => {
    expect(resolveCliConsoleLevel({ env: {} })).toBe("warn")
    expect(resolveCliConsoleLevel({ env: {}, verbose: true })).toBe("debug")
    expect(resolveCliConsoleLevel({ env: { COGNIA_LOG_LEVEL: "TRACE " }, verbose: false })).toBe(
      "trace"
    )
    expect(resolveCliConsoleLevel({ env: { COGNIA_LOG_LEVEL: "loud" }, verbose: true })).toBe(
      "debug"
    )
  })

  it("recognises only the logging package's level names", () => {
    expect(isLogLevel("fatal")).toBe(true)
    expect(isLogLevel("verbose")).toBe(false)
    expect(isLogLevel(3)).toBe(false)
  })
})

describe("formatCliLogLine", () => {
  it("renders level, module, message and compact data on one line", () => {
    expect(formatCliLogLine(entry({ level: "warn", data: { arg: "x" } }))).toBe(
      '[WARN] [plugin:manager] hello {"arg":"x"}'
    )
    expect(formatCliLogLine(entry({ module: "", data: {} }))).toBe("[INFO] hello")
  })

  it("survives unserialisable data", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(formatCliLogLine(entry({ data: cyclic }))).toContain("[unserializable data]")
  })
})

describe("createCliLogTransport", () => {
  it("drops entries below the threshold and never throws out of the sink", () => {
    const lines: string[] = []
    const transport = createCliLogTransport({ minLevel: "warn", sink: (l) => lines.push(l) })
    transport.log(entry({ level: "debug" }))
    transport.log(entry({ level: "info" }))
    transport.log(entry({ level: "warn", message: "careful" }))
    transport.log(entry({ level: "error", message: "broke" }))
    expect(lines).toEqual(["[WARN] [plugin:manager] careful", "[ERROR] [plugin:manager] broke"])
    const throwing = createCliLogTransport({
      minLevel: "trace",
      sink: () => {
        throw new Error("EPIPE")
      },
    })
    expect(() => throwing.log(entry())).not.toThrow()
  })
})

describe("defaultSink", () => {
  it("writes headless and repl lines to stderr, tui lines through the console", () => {
    const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true)
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      defaultSink("headless")("a")
      defaultSink("repl")("b")
      expect(stderr).toHaveBeenNthCalledWith(1, "a\n")
      expect(stderr).toHaveBeenNthCalledWith(2, "b\n")
      defaultSink("tui")("c")
      expect(consoleError).toHaveBeenCalledWith("c")
      expect(stderr).toHaveBeenCalledTimes(2)
    } finally {
      stderr.mockRestore()
      consoleError.mockRestore()
    }
  })
})

describe("configureCliLogging", () => {
  beforeEach(() => {
    initLogger({ minLevel: "trace", enableConsole: true })
  })

  it("replaces the console transport with the CLI sink and restores it afterwards", () => {
    expect(getTransports().map((t) => t.name)).toContain("console")
    const lines: string[] = []
    const restore = configureCliLogging({
      surface: "headless",
      env: {},
      sink: (l) => lines.push(l),
    })
    const names = getTransports().map((t) => t.name)
    expect(names).toContain(CLI_LOG_TRANSPORT)
    expect(names).not.toContain("console")
    expect(getLoggerConfig().enableConsole).toBe(false)

    const log = createLogger("plugin").child("manager")
    log.info("activated")
    log.warn("sync failed", { arg: "no backend" })
    expect(lines).toEqual(['[WARN] [plugin:manager] sync failed {"arg":"no backend"}'])

    restore()
    const after = getTransports().map((t) => t.name)
    expect(after).toContain("console")
    expect(after).not.toContain(CLI_LOG_TRANSPORT)
    expect(getLoggerConfig().enableConsole).toBe(true)
  })

  it("shows info and debug lines under --verbose", () => {
    const lines: string[] = []
    const restore = configureCliLogging({
      surface: "repl",
      verbose: true,
      env: {},
      sink: (l) => lines.push(l),
    })
    try {
      createLogger("plugin").debug("quiet detail")
      expect(lines).toEqual(["[DEBUG] [plugin] quiet detail"])
    } finally {
      restore()
    }
  })

  it("is idempotent: a second configure replaces the first sink", () => {
    const first: string[] = []
    const second: string[] = []
    const restoreFirst = configureCliLogging({
      surface: "tui",
      env: {},
      sink: (l) => first.push(l),
    })
    const restoreSecond = configureCliLogging({
      surface: "tui",
      env: {},
      sink: (l) => second.push(l),
    })
    try {
      createLogger("plugin").error("boom")
      expect(first).toEqual([])
      expect(second).toEqual(["[ERROR] [plugin] boom"])
      expect(getTransports().filter((t) => t.name === CLI_LOG_TRANSPORT)).toHaveLength(1)
    } finally {
      restoreSecond()
      restoreFirst()
    }
  })
})
