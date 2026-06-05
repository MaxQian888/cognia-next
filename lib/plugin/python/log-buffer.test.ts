import {
  appendPythonEvent,
  clearPythonLogs,
  getPythonLogs,
  subscribePythonLogs,
  PYTHON_LOG_BUFFER_CAP,
  __resetPythonLogBufferForTesting,
} from "./log-buffer"

describe("python log-buffer", () => {
  beforeEach(() => {
    __resetPythonLogBufferForTesting()
  })

  it("appends entries per plugin with timestamps, oldest first", () => {
    appendPythonEvent({ pluginId: "a", kind: "log", data: { line: "one" } }, 100)
    appendPythonEvent({ pluginId: "a", kind: "progress", data: { pct: 50 } }, 200)
    appendPythonEvent({ pluginId: "b", kind: "log", data: { line: "other" } }, 300)

    const logsA = getPythonLogs("a")
    expect(logsA).toHaveLength(2)
    expect(logsA[0]).toMatchObject({ kind: "log", ts: 100 })
    expect(logsA[1]).toMatchObject({ kind: "progress", ts: 200 })
    expect(getPythonLogs("b")).toHaveLength(1)
    expect(getPythonLogs("ghost")).toHaveLength(0)
  })

  it("caps the ring at PYTHON_LOG_BUFFER_CAP dropping oldest", () => {
    for (let i = 0; i < PYTHON_LOG_BUFFER_CAP + 25; i++) {
      appendPythonEvent({ pluginId: "a", kind: "log", data: i }, i)
    }
    const logs = getPythonLogs("a")
    expect(logs).toHaveLength(PYTHON_LOG_BUFFER_CAP)
    expect(logs[0].data).toBe(25)
    expect(logs[logs.length - 1].data).toBe(PYTHON_LOG_BUFFER_CAP + 24)
  })

  it("returns a referentially stable snapshot until the buffer changes", () => {
    appendPythonEvent({ pluginId: "a", kind: "log", data: 1 }, 1)
    const first = getPythonLogs("a")
    expect(getPythonLogs("a")).toBe(first)
    appendPythonEvent({ pluginId: "a", kind: "log", data: 2 }, 2)
    expect(getPythonLogs("a")).not.toBe(first)
  })

  it("notifies subscribers with the changed plugin id and supports unsubscribe", () => {
    const seen: string[] = []
    const unsubscribe = subscribePythonLogs((pluginId) => seen.push(pluginId))
    appendPythonEvent({ pluginId: "a", kind: "log", data: null }, 1)
    clearPythonLogs("a")
    unsubscribe()
    appendPythonEvent({ pluginId: "a", kind: "log", data: null }, 2)
    expect(seen).toEqual(["a", "a"])
  })

  it("clear drops a plugin's entries without touching others", () => {
    appendPythonEvent({ pluginId: "a", kind: "log", data: 1 }, 1)
    appendPythonEvent({ pluginId: "b", kind: "log", data: 2 }, 2)
    clearPythonLogs("a")
    expect(getPythonLogs("a")).toHaveLength(0)
    expect(getPythonLogs("b")).toHaveLength(1)
  })

  it("ignores malformed events and survives throwing subscribers", () => {
    const unsubscribe = subscribePythonLogs(() => {
      throw new Error("broken subscriber")
    })
    appendPythonEvent({ pluginId: "", kind: "log", data: null }, 1)
    appendPythonEvent(null as unknown as Parameters<typeof appendPythonEvent>[0], 1)
    expect(getPythonLogs("")).toHaveLength(0)
    // Throwing subscriber must not prevent ingestion.
    appendPythonEvent({ pluginId: "a", kind: "log", data: 1 }, 1)
    expect(getPythonLogs("a")).toHaveLength(1)
    unsubscribe()
  })
})
