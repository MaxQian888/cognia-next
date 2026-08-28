/**
 * @jest-environment jsdom
 */

import {
  ConsoleTransport,
  createConsoleTransport,
  detectConsoleEnvironment,
  resolveColorMode,
  resolveConsoleTransportOptions,
} from "./console-transport"
import type { ConsoleEnvironment } from "./console-transport"
import { installConsoleBridge } from "../console-bridge"
import { CONSOLE_BRIDGE_MODULE } from "../console-bridge-state"
import type { StructuredLogEntry } from "../types"

function makeEntry(overrides: Partial<StructuredLogEntry> = {}): StructuredLogEntry {
  return {
    id: overrides.id ?? "log-1",
    timestamp: overrides.timestamp ?? "2026-04-30T10:00:00.000Z",
    level: overrides.level ?? "info",
    message: overrides.message ?? "hello",
    module: overrides.module ?? "test",
    ...overrides,
  }
}

interface ConsoleSpies {
  trace: jest.SpyInstance
  debug: jest.SpyInstance
  info: jest.SpyInstance
  warn: jest.SpyInstance
  error: jest.SpyInstance
  log: jest.SpyInstance
}

let spies: ConsoleSpies

beforeEach(() => {
  // Stub console methods so we can assert on calls without polluting the
  // jest output. `mockImplementation(() => {})` keeps them silent.
  spies = {
    trace: jest.spyOn(console, "trace").mockImplementation(() => {}),
    debug: jest.spyOn(console, "debug").mockImplementation(() => {}),
    info: jest.spyOn(console, "info").mockImplementation(() => {}),
    warn: jest.spyOn(console, "warn").mockImplementation(() => {}),
    error: jest.spyOn(console, "error").mockImplementation(() => {}),
    log: jest.spyOn(console, "log").mockImplementation(() => {}),
  }
})

afterEach(() => {
  Object.values(spies).forEach((spy) => spy.mockRestore())
})

describe("ConsoleTransport routing per level", () => {
  it("writes through the original console method when the legacy bridge is installed", () => {
    const bridgedLogger = { warn: jest.fn(), error: jest.fn() }
    const cleanup = installConsoleBridge({
      console,
      logger: bridgedLogger as never,
    })

    try {
      new ConsoleTransport({ useColors: false }).log(makeEntry({ level: "warn" }))
      expect(spies.warn).toHaveBeenCalledTimes(1)
      expect(bridgedLogger.warn).not.toHaveBeenCalled()
    } finally {
      cleanup()
    }
  })

  it("routes trace -> console.trace", () => {
    const t = new ConsoleTransport()
    t.log(makeEntry({ level: "trace" }))
    expect(spies.trace).toHaveBeenCalled()
  })

  it("routes debug -> console.debug", () => {
    const t = new ConsoleTransport()
    t.log(makeEntry({ level: "debug" }))
    expect(spies.debug).toHaveBeenCalled()
  })

  it("routes info -> console.info", () => {
    const t = new ConsoleTransport()
    t.log(makeEntry({ level: "info" }))
    expect(spies.info).toHaveBeenCalled()
  })

  it("routes warn -> console.warn", () => {
    const t = new ConsoleTransport()
    t.log(makeEntry({ level: "warn" }))
    expect(spies.warn).toHaveBeenCalled()
  })

  it("routes error + fatal -> console.error", () => {
    const t = new ConsoleTransport()
    t.log(makeEntry({ level: "error" }))
    t.log(makeEntry({ level: "fatal" }))
    expect(spies.error).toHaveBeenCalledTimes(2)
  })
})

describe("ConsoleTransport formatting", () => {
  it("includes timestamp + module + level + truncated traceId by default", () => {
    const t = new ConsoleTransport()
    t.log(
      makeEntry({
        traceId: "abcdef0123456789",
        module: "auth",
        level: "info",
        message: "ok",
      })
    )
    // Window present in jsdom -> uses %c color formatting; first arg is the
    // composed string, second is the color CSS.
    const call = spies.info.mock.calls[0]
    const composed = String(call[0])
    expect(composed).toContain("[INFO]")
    expect(composed).toContain("[auth]")
    expect(composed).toContain("[abcdef01]") // first 8 chars of traceId
    expect(composed).toMatch(/\[\d+:\d+/) // timestamp prefix
  })

  it("omits timestamp/icons/module/traceId when configured to do so", () => {
    const t = new ConsoleTransport({
      includeTimestamp: false,
      useIcons: false,
      includeModule: false,
      includeTraceId: false,
      useColors: false,
    })
    t.log(makeEntry({ traceId: "abcdef", module: "auth", message: "msg" }))
    const composed = String(spies.info.mock.calls[0][0])
    // Bare format: just `[LEVEL] message`.
    expect(composed).toBe("[INFO] msg")
  })

  it("uses color formatting in browser-like environments with data appended", () => {
    const t = new ConsoleTransport({ useColors: true })
    t.log(makeEntry({ data: { foo: "bar" } }))
    const args = spies.info.mock.calls[0]
    expect(String(args[0])).toContain("%c")
    expect(args[2]).toEqual({ foo: "bar" })
  })

  it("uses plain (no %c) formatting when colors are disabled", () => {
    const t = new ConsoleTransport({ useColors: false })
    t.log(makeEntry({ data: { x: 1 } }))
    const args = spies.info.mock.calls[0]
    expect(String(args[0])).not.toContain("%c")
    expect(args[1]).toEqual({ x: 1 })
  })

  it("emits compact single-line output even when data is present (compact: true)", () => {
    const t = new ConsoleTransport({ compact: true, useColors: false })
    t.log(makeEntry({ data: { a: 1 } }))
    const call = spies.info.mock.calls[0]
    // Compact path passes only the prefix+message; data is dropped.
    expect(call.length).toBe(1)
  })

  it("logs the stack trace separately via console.debug when present", () => {
    const t = new ConsoleTransport()
    t.log(makeEntry({ stack: "Error: boom\n  at ..." }))
    // The first debug call is the stack trace dump.
    expect(spies.debug).toHaveBeenCalledWith("Error: boom\n  at ...")
  })

  it("passes data argument with %c color format to error level", () => {
    const t = new ConsoleTransport({ useColors: true })
    t.log(makeEntry({ level: "error", data: { code: 500 } }))
    const args = spies.error.mock.calls[0]
    expect(String(args[0])).toContain("%c")
    expect(args[2]).toEqual({ code: 500 })
  })
})

function env(overrides: Partial<ConsoleEnvironment> = {}): ConsoleEnvironment {
  return { browser: false, tty: false, noColor: false, forceColor: false, ...overrides }
}

describe("colour mode resolution", () => {
  it("keeps %c CSS for a DOM console", () => {
    expect(resolveColorMode(undefined, env({ browser: true }))).toBe("css")
  })

  it("uses ANSI for a Node terminal — %c would render as literal noise there", () => {
    expect(resolveColorMode(undefined, env({ tty: true }))).toBe("ansi")
  })

  it("keeps ANSI on a pipe only when FORCE_COLOR asks for it", () => {
    expect(resolveColorMode(undefined, env())).toBe("none")
    expect(resolveColorMode(undefined, env({ forceColor: true }))).toBe("ansi")
  })

  it("lets NO_COLOR and an explicit useColors:false win over the ambient guess", () => {
    expect(resolveColorMode(undefined, env({ tty: true, noColor: true }))).toBe("none")
    expect(resolveColorMode(false, env({ browser: true }))).toBe("none")
    expect(resolveColorMode(false, env({ tty: true }))).toBe("none")
  })

  // The option has to answer in both directions: a caller that asks for colour
  // on a pipe is doing by hand what FORCE_COLOR does, and discarding that ask
  // made `useColors: true` a no-op nobody could tell from an ignored setting.
  it("honours an explicit useColors:true on a sink that would not choose it", () => {
    expect(resolveColorMode(true, env())).toBe("ansi")
    expect(resolveColorMode(true, env({ noColor: true }))).toBe("ansi")
    // Still CSS in a DOM console — `true` picks colour, not the encoding.
    expect(resolveColorMode(true, env({ browser: true }))).toBe("css")
  })

  it("resolves the ambient environment when none is injected", () => {
    // jsdom defines `window`, so the default path must report a browser.
    expect(detectConsoleEnvironment()).toEqual({
      browser: true,
      tty: false,
      noColor: false,
      forceColor: false,
    })
    expect(new ConsoleTransport({ useColors: true })).toBeInstanceOf(ConsoleTransport)
  })
})

describe("supervised Node output", () => {
  it("drops the clock and the icon when stdout is a pipe", () => {
    // cognia-server stamps its own clock and level tag around every line it
    // reads from the brain; repeating them here is the double prefix.
    const opts = resolveConsoleTransportOptions(undefined, env())
    expect(opts.includeTimestamp).toBe(false)
    expect(opts.useIcons).toBe(false)
  })

  it("keeps the clock and the icon on a terminal and in a browser", () => {
    expect(resolveConsoleTransportOptions(undefined, env({ tty: true }))).toMatchObject({
      includeTimestamp: true,
      useIcons: true,
    })
    expect(resolveConsoleTransportOptions(undefined, env({ browser: true }))).toMatchObject({
      includeTimestamp: true,
      useIcons: true,
    })
  })

  it("still honours an explicit option over the environment default", () => {
    expect(resolveConsoleTransportOptions({ includeTimestamp: true }, env()).includeTimestamp).toBe(
      true
    )
  })

  it("emits a bare [LEVEL] [module] line a supervisor can classify", () => {
    const t = new ConsoleTransport(undefined, env())
    t.log(makeEntry({ level: "warn", module: "scheduler", message: "queue backed up" }))
    expect(String(spies.warn.mock.calls[0][0])).toBe("[WARN] [scheduler] queue backed up")
  })

  // `DEFAULT_OPTIONS.useColors` is `true` as a permission, not a demand: the
  // supervised pipe must stay bare unless the CALLER asked for colour.
  it("paints a supervised pipe only when the caller explicitly asks", () => {
    const bare = new ConsoleTransport({ useColors: true }, env())
    bare.log(makeEntry({ level: "warn", module: "scheduler", message: "queue backed up" }))
    expect(String(spies.warn.mock.calls[0][0])).toContain("\u001b[33m")
  })

  it("wraps the prefix in SGR on a terminal and leaves the message unpainted", () => {
    const t = new ConsoleTransport(undefined, env({ tty: true }))
    t.log(makeEntry({ level: "error", module: "brain", message: "spawn failed" }))
    const line = String(spies.error.mock.calls[0][0])
    expect(line).not.toContain("%c")
    expect(line.startsWith("\u001b[31m")).toBe(true)
    expect(line.endsWith("\u001b[0m spawn failed")).toBe(true)
  })

  it("appends data as a console argument on the ANSI path", () => {
    const t = new ConsoleTransport(undefined, env({ tty: true }))
    t.log(makeEntry({ data: { attempt: 2 } }))
    expect(spies.info.mock.calls[0][1]).toEqual({ attempt: 2 })
  })
})

describe("createConsoleTransport factory", () => {
  it("returns a fresh transport instance", () => {
    const t = createConsoleTransport({ useIcons: false })
    expect(t).toBeInstanceOf(ConsoleTransport)
    expect(t.name).toBe("console")
  })

  it("returns an instance even with no options", () => {
    const t = createConsoleTransport()
    expect(t).toBeInstanceOf(ConsoleTransport)
  })
})

describe("ConsoleTransport server-like fallback (compact + no data)", () => {
  it("logs without %c color formatting when compact + no data is provided in the entry", () => {
    const t = new ConsoleTransport({ compact: true, useColors: false })
    t.log(makeEntry())
    const composed = String(spies.info.mock.calls[0][0])
    expect(composed).not.toContain("%c")
  })
})

describe("console bridge entries", () => {
  it("skips entries the console bridge already printed", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const transport = new ConsoleTransport()
      transport.log(makeEntry({ level: "warn", module: CONSOLE_BRIDGE_MODULE }))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})
