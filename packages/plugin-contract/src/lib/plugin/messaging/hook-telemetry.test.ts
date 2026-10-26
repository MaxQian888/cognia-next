/**
 * Plugin-hook failure telemetry — the bounded ring and the span emitter both
 * surfaces (the legacy hook dispatchers and the interceptor dispatcher) share.
 */

import {
  extractSessionIdFromPayload,
  getRecentPluginHookErrors,
  recordPluginHookError,
  recordPluginHookEvent,
  __resetPluginHookErrorsForTesting,
} from "./hook-telemetry"

const emitFinishedSpan = jest.fn()
jest.mock("@cognia/agent-trace/emitter", () => ({
  emitFinishedSpan: (...args: unknown[]) => emitFinishedSpan(...args),
}))

beforeEach(() => {
  __resetPluginHookErrorsForTesting()
  emitFinishedSpan.mockReset()
})

describe("recordPluginHookError", () => {
  it("captures the message and the hook it came from", () => {
    recordPluginHookError("p1", "onEnable", new Error("boom"))
    expect(getRecentPluginHookErrors()).toMatchObject([
      { pluginId: "p1", hookName: "onEnable", message: "boom" },
    ])
  })

  it("stringifies a non-Error throw rather than dropping it", () => {
    recordPluginHookError("p1", "onEnable", "just a string")
    expect(getRecentPluginHookErrors()[0]?.message).toBe("just a string")
  })

  it("keeps the ring bounded, dropping the oldest entries", () => {
    for (let index = 0; index < 300; index++) {
      recordPluginHookError("p1", "onEnable", new Error(`e${index}`))
    }
    const errors = getRecentPluginHookErrors()
    // Cap is 256 and the newest entry survives — an unbounded buffer on a
    // per-chunk dispatcher is a memory leak with a stack trace in it.
    expect(errors).toHaveLength(256)
    expect(errors.at(-1)?.message).toBe("e299")
  })

  it("hands back a copy, so a caller cannot mutate the buffer", () => {
    recordPluginHookError("p1", "onEnable", new Error("boom"))
    getRecentPluginHookErrors().slice().length = 0
    expect(getRecentPluginHookErrors()).toHaveLength(1)
  })
})

describe("recordPluginHookEvent", () => {
  it("emits a finished span with the handler's own duration", () => {
    recordPluginHookEvent({
      pluginId: "p1",
      hookName: "tool.execute:around",
      startTime: 1_000,
      durationMs: 12,
      sessionId: "s1",
    })
    expect(emitFinishedSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "p1",
        toolName: "tool.execute:around",
        sessionId: "s1",
        durationMs: 12,
        errorType: undefined,
      })
    )
  })

  it("falls back to a runtime-scoped session for hooks with no chat scope", () => {
    recordPluginHookEvent({ pluginId: "p1", hookName: "onEnable", startTime: 0, durationMs: 1 })
    expect(emitFinishedSpan).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "plugin-runtime" })
    )
  })

  it("clamps a negative duration rather than emitting it", () => {
    recordPluginHookEvent({ pluginId: "p1", hookName: "onEnable", startTime: 0, durationMs: -5 })
    expect(emitFinishedSpan).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 0 }))
  })

  it("also lands the failure in the ring when the event carries an error", () => {
    recordPluginHookEvent({
      pluginId: "p1",
      hookName: "onEnable",
      startTime: 0,
      durationMs: 1,
      error: new Error("boom"),
    })
    expect(getRecentPluginHookErrors()).toHaveLength(1)
    expect(emitFinishedSpan).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: "plugin_hook_error", errorMessage: "boom" })
    )
  })

  it("never lets a failing emitter break the host loop", () => {
    emitFinishedSpan.mockImplementation(() => {
      throw new Error("trace backend down")
    })
    expect(() =>
      recordPluginHookEvent({ pluginId: "p1", hookName: "onEnable", startTime: 0, durationMs: 1 })
    ).not.toThrow()
  })
})

describe("extractSessionIdFromPayload", () => {
  it("reads either spelling a payload might carry", () => {
    expect(extractSessionIdFromPayload({ sessionId: "s1" })).toBe("s1")
    expect(extractSessionIdFromPayload({ chatSessionId: "s2" })).toBe("s2")
  })

  it("returns undefined for a payload with no chat scope", () => {
    expect(extractSessionIdFromPayload({ teamId: "t1" })).toBeUndefined()
    expect(extractSessionIdFromPayload(null)).toBeUndefined()
    expect(extractSessionIdFromPayload("nope")).toBeUndefined()
    expect(extractSessionIdFromPayload({ sessionId: "" })).toBeUndefined()
  })
})
