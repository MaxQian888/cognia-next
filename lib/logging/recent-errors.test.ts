/**
 * @jest-environment node
 */

import {
  clearRecentErrorLogs,
  getRecentErrorLogs,
  recordRecentErrorLog,
  resetRecentErrorLogsForTest,
  subscribeRecentErrorLogs,
} from "./recent-errors"
import type { StructuredLogEntry, LogLevel } from "@/types/logging"

function makeEntry(level: LogLevel, id: string): StructuredLogEntry {
  return {
    id,
    timestamp: new Date().toISOString(),
    level,
    message: `entry ${id}`,
    module: "test",
    runtime: "browser",
    origin: "frontend",
  }
}

beforeEach(() => {
  resetRecentErrorLogsForTest()
})

describe("recordRecentErrorLog", () => {
  it("records error- and fatal-level entries only", () => {
    recordRecentErrorLog(makeEntry("info", "i"))
    recordRecentErrorLog(makeEntry("warn", "w"))
    recordRecentErrorLog(makeEntry("error", "e"))
    recordRecentErrorLog(makeEntry("fatal", "f"))
    const ids = getRecentErrorLogs().map((e) => e.id)
    // Most recent first.
    expect(ids).toEqual(["f", "e"])
  })

  it("dedupes entries by id, keeping the latest position", () => {
    recordRecentErrorLog(makeEntry("error", "e1"))
    recordRecentErrorLog(makeEntry("error", "e2"))
    recordRecentErrorLog(makeEntry("error", "e1")) // re-record e1 — should move to head
    expect(getRecentErrorLogs().map((e) => e.id)).toEqual(["e1", "e2"])
    expect(getRecentErrorLogs().length).toBe(2)
  })

  it("caps the buffer at 100 entries", () => {
    for (let i = 0; i < 150; i++) {
      recordRecentErrorLog(makeEntry("error", `e${i}`))
    }
    const recent = getRecentErrorLogs()
    expect(recent.length).toBe(100)
    // Newest first — id e149 is the last recorded.
    expect(recent[0].id).toBe("e149")
    expect(recent[99].id).toBe("e50")
  })

  it("respects the limit argument on read", () => {
    for (let i = 0; i < 5; i++) recordRecentErrorLog(makeEntry("error", `e${i}`))
    expect(getRecentErrorLogs(2).map((e) => e.id)).toEqual(["e4", "e3"])
  })
})

describe("clearRecentErrorLogs", () => {
  it("empties the buffer and notifies subscribers", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeRecentErrorLogs(listener)
    recordRecentErrorLog(makeEntry("error", "e1"))
    expect(listener).toHaveBeenCalledTimes(1)
    clearRecentErrorLogs()
    expect(getRecentErrorLogs()).toHaveLength(0)
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })
})

describe("subscribeRecentErrorLogs", () => {
  it("notifies on record + clear, stops after unsubscribe", () => {
    const listener = jest.fn()
    const unsubscribe = subscribeRecentErrorLogs(listener)
    recordRecentErrorLog(makeEntry("error", "e1"))
    unsubscribe()
    recordRecentErrorLog(makeEntry("error", "e2"))
    clearRecentErrorLogs()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("supports multiple independent subscribers", () => {
    const a = jest.fn()
    const b = jest.fn()
    const unsubA = subscribeRecentErrorLogs(a)
    const unsubB = subscribeRecentErrorLogs(b)
    recordRecentErrorLog(makeEntry("error", "x"))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    unsubA()
    unsubB()
  })
})
