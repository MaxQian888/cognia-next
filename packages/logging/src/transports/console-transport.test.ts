/**
 * @jest-environment jsdom
 */

import { ConsoleTransport, createConsoleTransport } from "./console-transport"
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
