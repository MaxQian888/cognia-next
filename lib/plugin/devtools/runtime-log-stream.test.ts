/**
 * @jest-environment jsdom
 */

import { getPluginDebugger, resetPluginDebugger } from "./debugger"
import { __resetPythonLogBufferForTesting, appendPythonEvent } from "@/lib/plugin/python/log-buffer"
import {
  RUNTIMES_WITHOUT_LOG_CHANNEL,
  isPluginType,
  clearPluginRuntimeLogs,
  getPluginRuntimeLogs,
  logSourcesFor,
  normalizePythonEntry,
  subscribePluginRuntimeLogs,
} from "./runtime-log-stream"

beforeEach(() => {
  resetPluginDebugger()
  __resetPythonLogBufferForTesting()
})

describe("logSourcesFor", () => {
  it("gives hybrid both sources", () => {
    expect(logSourcesFor("hybrid").runtimes).toEqual(["frontend", "python"])
  })

  it.each(["frontend", "python"] as const)("gives %s exactly one source", (type) => {
    expect(logSourcesFor(type).runtimes).toHaveLength(1)
  })

  it("names why wasm produces nothing", () => {
    // Rule 7: an intentionally empty runtime has to be labelled, or an empty
    // list is indistinguishable from a broken reader.
    expect(logSourcesFor("wasm")).toEqual({
      runtimes: [],
      missingReason: RUNTIMES_WITHOUT_LOG_CHANNEL.wasm,
    })
  })

  it("names why a vscode extension produces nothing", () => {
    expect(logSourcesFor("vscode-extension")).toEqual({
      runtimes: [],
      missingReason: RUNTIMES_WITHOUT_LOG_CHANNEL["vscode-extension"],
    })
  })
})

describe("isPluginType", () => {
  it.each(["frontend", "python", "hybrid", "wasm", "vscode-extension"])("accepts %s", (value) => {
    expect(isPluginType(value)).toBe(true)
  })

  it("rejects a value the Dexie row could still hold", () => {
    // `PluginRow.type` is a loose string, and the Logs tab decides whether to
    // exist from it. An unrecognised runtime gets no tab.
    expect(isPluginType("something-new")).toBe(false)
  })
})

describe("normalizePythonEntry", () => {
  const base = { pluginId: "p", ts: 10 }

  it("reads a log line the way the detail page does", () => {
    const e = normalizePythonEntry({ ...base, kind: "log", data: { line: "hello" } }, 0)
    expect(e).toMatchObject({ level: "info", message: "hello", runtime: "python" })
  })

  it("honours a declared level", () => {
    const e = normalizePythonEntry({ ...base, kind: "log", data: { level: "warn", line: "x" } }, 0)
    expect(e.level).toBe("warn")
  })

  it("treats a non-zero exit as an error", () => {
    expect(normalizePythonEntry({ ...base, kind: "exit", data: { code: 3 } }, 0).level).toBe(
      "error"
    )
    expect(normalizePythonEntry({ ...base, kind: "exit", data: { code: 0 } }, 0).level).toBe("info")
  })

  it("renders progress with phase and percentage", () => {
    const e = normalizePythonEntry(
      { ...base, kind: "progress", data: { phase: "install", message: "deps", pct: 40 } },
      0
    )
    expect(e.message).toBe("[install] deps (40%)")
    expect(e.level).toBe("debug")
  })

  it("keeps ids unique for frames sharing a millisecond", () => {
    const a = normalizePythonEntry({ ...base, kind: "chunk", data: "a" }, 0)
    const b = normalizePythonEntry({ ...base, kind: "chunk", data: "b" }, 1)
    expect(a.id).not.toBe(b.id)
  })
})

describe("getPluginRuntimeLogs", () => {
  it("merges both runtimes into one time-ordered stream", () => {
    const dbg = getPluginDebugger()
    dbg.startSession("p", 2)
    // The frontend ring stamps with `Date.now()`, so the python frames have to
    // straddle real time for the ordering assertion to mean anything.
    const now = Date.now()
    appendPythonEvent({ pluginId: "p", kind: "log", data: { line: "from python" } }, now - 1000)
    dbg.log("p", "info", "from frontend")
    appendPythonEvent({ pluginId: "p", kind: "log", data: { line: "later python" } }, now + 1000)

    const entries = getPluginRuntimeLogs("p")
    expect(entries).toHaveLength(3)
    expect(entries.map((e) => e.runtime)).toEqual(["python", "frontend", "python"])
    expect(entries.map((e) => e.timestamp)).toEqual(
      [...entries.map((e) => e.timestamp)].sort((a, b) => a - b)
    )
  })

  it("filters by generation across both id shapes", () => {
    // The frontend ring counts generations, the python host sends a token.
    const dbg = getPluginDebugger()
    dbg.startSession("p", 7)
    dbg.log("p", "info", "gen 7")
    appendPythonEvent(
      { pluginId: "p", generation: "7", kind: "log", data: { line: "py gen 7" } },
      50
    )
    appendPythonEvent(
      { pluginId: "p", generation: "6", kind: "log", data: { line: "py gen 6" } },
      60
    )

    const entries = getPluginRuntimeLogs("p", { generation: 7 })
    expect(entries.map((e) => e.message)).toEqual(["py gen 7", "gen 7"])
  })

  it("keeps entries whose source reported no generation", () => {
    // Dropping them would hide the whole legacy python path rather than
    // filter it, which reads as "this runtime produces nothing".
    const dbg = getPluginDebugger()
    dbg.startSession("p", 3)
    appendPythonEvent({ pluginId: "p", kind: "log", data: { line: "no generation" } }, 5)
    expect(getPluginRuntimeLogs("p", { generation: 3 }).map((e) => e.message)).toEqual([
      "no generation",
    ])
  })

  it("returns everything when no generation is given", () => {
    const dbg = getPluginDebugger()
    dbg.startSession("p", 1)
    dbg.log("p", "info", "a")
    appendPythonEvent({ pluginId: "p", generation: "99", kind: "log", data: { line: "b" } }, 5)
    expect(getPluginRuntimeLogs("p")).toHaveLength(2)
  })

  it("applies the limit to the newest entries", () => {
    const dbg = getPluginDebugger()
    dbg.startSession("p", 1)
    for (let i = 0; i < 5; i++) dbg.log("p", "info", `m${i}`)
    expect(getPluginRuntimeLogs("p", { limit: 2 }).map((e) => e.message)).toEqual(["m3", "m4"])
  })

  it("does not leak another plugin's entries", () => {
    const dbg = getPluginDebugger()
    dbg.startSession("p", 1)
    dbg.startSession("other", 1)
    dbg.log("other", "info", "not mine")
    appendPythonEvent({ pluginId: "other", kind: "log", data: { line: "also not mine" } }, 5)
    expect(getPluginRuntimeLogs("p")).toEqual([])
  })
})

describe("subscribePluginRuntimeLogs", () => {
  it("fires for both sources and stops on unsubscribe", () => {
    const onChange = jest.fn()
    const off = subscribePluginRuntimeLogs("p", onChange)
    const dbg = getPluginDebugger()
    dbg.startSession("p", 1)
    dbg.log("p", "info", "a")
    expect(onChange).toHaveBeenCalledTimes(1)
    appendPythonEvent({ pluginId: "p", kind: "log", data: { line: "b" } }, 5)
    expect(onChange).toHaveBeenCalledTimes(2)
    off()
    dbg.log("p", "info", "c")
    appendPythonEvent({ pluginId: "p", kind: "log", data: { line: "d" } }, 6)
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it("ignores other plugins", () => {
    const onChange = jest.fn()
    subscribePluginRuntimeLogs("p", onChange)
    getPluginDebugger().startSession("other", 1)
    getPluginDebugger().log("other", "info", "x")
    appendPythonEvent({ pluginId: "other", kind: "log", data: { line: "y" } }, 5)
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe("clearPluginRuntimeLogs", () => {
  it("clears both sources", () => {
    const dbg = getPluginDebugger()
    dbg.startSession("p", 1)
    dbg.log("p", "info", "a")
    appendPythonEvent({ pluginId: "p", kind: "log", data: { line: "b" } }, 5)
    expect(getPluginRuntimeLogs("p")).toHaveLength(2)
    clearPluginRuntimeLogs("p")
    expect(getPluginRuntimeLogs("p")).toEqual([])
  })
})
