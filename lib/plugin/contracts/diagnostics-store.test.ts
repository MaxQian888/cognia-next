import { loggers } from "../core/logger"
import {
  __resetDiagnosticsStoreForTesting,
  clearAllPluginPointDiagnostics,
  clearPluginPointDiagnostics,
  getAllPluginPointDiagnostics,
  getPluginPointDiagnostics,
  getPluginPointDiagnosticsRevision,
  recordPluginPointDiagnostic,
  recordSilentFailure,
  subscribePluginPointDiagnostics,
} from "./diagnostics-store"
import type { PluginPointDiagnostic } from "./plugin-points"

const sample = (overrides: Partial<PluginPointDiagnostic> = {}): PluginPointDiagnostic => ({
  code: "plugin.point.unknown",
  severity: "warning",
  message: "sample diagnostic",
  pointKind: "hook",
  pointId: "onLoad",
  ...overrides,
})

describe("diagnostics-store", () => {
  beforeEach(() => {
    clearAllPluginPointDiagnostics()
    jest.restoreAllMocks()
  })

  it("records a diagnostic and reads it back per plugin", () => {
    recordPluginPointDiagnostic("plugin-a", sample({ message: "first" }))
    expect(getPluginPointDiagnostics("plugin-a")).toEqual([
      expect.objectContaining({ message: "first" }),
    ])
    expect(getPluginPointDiagnostics("plugin-b")).toEqual([])
  })

  it("preserves insertion order for multiple records under the same plugin", () => {
    recordPluginPointDiagnostic("plugin-a", sample({ message: "1" }))
    recordPluginPointDiagnostic("plugin-a", sample({ message: "2" }))
    recordPluginPointDiagnostic("plugin-a", sample({ message: "3" }))
    const messages = getPluginPointDiagnostics("plugin-a").map((d) => d.message)
    expect(messages).toEqual(["1", "2", "3"])
  })

  it("array-level isolation: mutating the returned array does not affect the store", () => {
    recordPluginPointDiagnostic("plugin-a", sample({ message: "hello" }))
    const snapshot = getAllPluginPointDiagnostics()
    snapshot["plugin-a"].push(sample({ message: "mutated" }))
    delete snapshot["plugin-a"]
    expect(getPluginPointDiagnostics("plugin-a")).toEqual([
      expect.objectContaining({ message: "hello" }),
    ])
    expect(getPluginPointDiagnostics("plugin-a")).toHaveLength(1)
  })

  it("getAllPluginPointDiagnostics returns a stable reference until the next notify (useSyncExternalStore contract)", () => {
    recordPluginPointDiagnostic("plugin-a", sample({ message: "first" }))
    const first = getAllPluginPointDiagnostics()
    // Same revision → same object reference, so React's getSnapshot won't loop.
    expect(getAllPluginPointDiagnostics()).toBe(first)
    // A new record bumps the revision → a fresh snapshot reference.
    recordPluginPointDiagnostic("plugin-a", sample({ message: "second" }))
    const second = getAllPluginPointDiagnostics()
    expect(second).not.toBe(first)
    expect(second["plugin-a"]).toHaveLength(2)
    expect(getAllPluginPointDiagnostics()).toBe(second)
  })

  it("clearPluginPointDiagnostics removes the plugin entry and notifies subscribers", () => {
    recordPluginPointDiagnostic("plugin-a", sample())
    const listener = jest.fn()
    const unsubscribe = subscribePluginPointDiagnostics(listener)
    clearPluginPointDiagnostics("plugin-a")
    expect(getPluginPointDiagnostics("plugin-a")).toEqual([])
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("clearAllPluginPointDiagnostics is a no-op when already empty", () => {
    const listener = jest.fn()
    const unsubscribe = subscribePluginPointDiagnostics(listener)
    clearAllPluginPointDiagnostics()
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })

  it("subscribePluginPointDiagnostics returns an unsubscribe that stops notifications", () => {
    const listener = jest.fn()
    const unsubscribe = subscribePluginPointDiagnostics(listener)
    recordPluginPointDiagnostic("plugin-a", sample())
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    recordPluginPointDiagnostic("plugin-a", sample())
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it("getPluginPointDiagnosticsRevision increments monotonically per notify", () => {
    const before = getPluginPointDiagnosticsRevision()
    recordPluginPointDiagnostic("plugin-a", sample())
    recordPluginPointDiagnostic("plugin-b", sample())
    clearPluginPointDiagnostics("plugin-a")
    const after = getPluginPointDiagnosticsRevision()
    expect(after).toBe(before + 3)
  })

  it("recordSilentFailure: expected=true logs debug and does not write a diagnostic", () => {
    const debugSpy = jest.spyOn(loggers.manager, "debug").mockImplementation(() => undefined)
    const warnSpy = jest.spyOn(loggers.manager, "warn").mockImplementation(() => undefined)
    recordSilentFailure(
      "plugin-a",
      { site: "manager.test", message: "expected web-mode skip", expected: true },
      new Error("backend missing")
    )
    expect(debugSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
    expect(getPluginPointDiagnostics("plugin-a")).toEqual([])
  })

  it("recordSilentFailure: expected=false logs warn and writes a runtime diagnostic", () => {
    const debugSpy = jest.spyOn(loggers.manager, "debug").mockImplementation(() => undefined)
    const warnSpy = jest.spyOn(loggers.manager, "warn").mockImplementation(() => undefined)
    recordSilentFailure(
      "plugin-a",
      { site: "manager.test", message: "real failure", expected: false },
      new Error("disk full")
    )
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(debugSpy).not.toHaveBeenCalled()
    const diagnostics = getPluginPointDiagnostics("plugin-a")
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        code: "plugin.silent-failure",
        severity: "warning",
        pointKind: "runtime",
        pointId: "manager.test",
        message: "real failure",
        hint: "disk full",
      })
    )
  })

  it("recordSilentFailure tolerates non-Error values via String() coercion", () => {
    const warnSpy = jest.spyOn(loggers.manager, "warn").mockImplementation(() => undefined)
    recordSilentFailure(
      "plugin-a",
      { site: "manager.test", message: "string failure", expected: false },
      "raw string error"
    )
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [diagnostic] = getPluginPointDiagnostics("plugin-a")
    expect(diagnostic.hint).toBe("raw string error")
  })

  describe("__resetDiagnosticsStoreForTesting (PR-E)", () => {
    it("clears every recorded diagnostic, subscription, and revision counter", () => {
      jest.spyOn(loggers.manager, "warn").mockImplementation(() => undefined)
      recordPluginPointDiagnostic("plugin-a", sample({ message: "before" }))
      const listener = jest.fn()
      subscribePluginPointDiagnostics(listener)
      // Confirm listener fires before reset
      recordPluginPointDiagnostic("plugin-b", sample({ message: "trigger" }))
      const revBefore = getPluginPointDiagnosticsRevision()
      expect(revBefore).toBeGreaterThan(0)
      expect(listener).toHaveBeenCalled()
      listener.mockClear()

      __resetDiagnosticsStoreForTesting()

      expect(getAllPluginPointDiagnostics()).toEqual({})
      expect(getPluginPointDiagnosticsRevision()).toBe(0)
      // Listener should no longer fire — it was dropped.
      recordPluginPointDiagnostic("plugin-c", sample({ message: "after" }))
      expect(listener).not.toHaveBeenCalled()
    })

    it("throws outside NODE_ENV=test", () => {
      const original = process.env.NODE_ENV
      ;(process.env as Record<string, string | undefined>).NODE_ENV = "production"
      try {
        expect(() => __resetDiagnosticsStoreForTesting()).toThrow(/NODE_ENV=test/)
      } finally {
        ;(process.env as Record<string, string | undefined>).NODE_ENV = original
      }
    })
  })
})
