import {
  __resetWasmRequestRegistryForTesting,
  abortAll,
  abortAllForPlugin,
  abortReasonFor,
  beginRequest,
  cancelRequest,
  DuplicateRequestError,
  pendingCount,
  settleRequest,
} from "./request-registry"
import type { WasmRendererRequest } from "./protocol"

const req = (overrides: Partial<WasmRendererRequest> = {}): WasmRendererRequest => ({
  requestId: "req-1",
  pluginId: "p",
  operation: "ai.generate-text",
  timeoutMs: 30_000,
  payload: {},
  ...overrides,
})

beforeEach(() => {
  __resetWasmRequestRegistryForTesting()
})

afterEach(() => {
  __resetWasmRequestRegistryForTesting()
})

describe("beginRequest", () => {
  it("registers a request and returns a live signal", () => {
    const signal = beginRequest(req(), () => {})
    expect(signal.aborted).toBe(false)
    expect(pendingCount()).toBe(1)
  })

  it("rejects a duplicate requestId rather than clobbering the live entry", () => {
    beginRequest(req(), () => {})
    expect(() => beginRequest(req(), () => {})).toThrow(DuplicateRequestError)
    expect(pendingCount()).toBe(1)
  })

  it("arms a local timer that aborts with reason `timeout`", () => {
    jest.useFakeTimers()
    try {
      const onTimeout = jest.fn()
      const signal = beginRequest(req({ timeoutMs: 50 }), onTimeout)
      expect(signal.aborted).toBe(false)

      jest.advanceTimersByTime(50)

      expect(signal.aborted).toBe(true)
      expect(abortReasonFor("req-1")).toBe("timeout")
      expect(onTimeout).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  it("does not fire the local timer once the request has settled", () => {
    // Rust owns the authoritative timeout; the local timer is only a backstop
    // for a lost cancel frame and must not resurrect a finished request.
    jest.useFakeTimers()
    try {
      const signal = beginRequest(req({ timeoutMs: 50 }), () => {})
      expect(settleRequest("req-1")).toBe(true)
      jest.advanceTimersByTime(500)
      expect(signal.aborted).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })
})

describe("settleRequest", () => {
  it("returns true exactly once — this is the single-response gate", () => {
    beginRequest(req(), () => {})
    expect(settleRequest("req-1")).toBe(true)
    expect(settleRequest("req-1")).toBe(false)
    expect(settleRequest("req-1")).toBe(false)
  })

  it("returns false for an unknown requestId", () => {
    expect(settleRequest("never-existed")).toBe(false)
  })

  it("removes the entry so nothing leaks", () => {
    beginRequest(req(), () => {})
    settleRequest("req-1")
    expect(pendingCount()).toBe(0)
  })

  it("makes a late result undeliverable after a cancel", () => {
    // The core "discard late results" property: cancel, respond, then the
    // handler's own slow resolution arrives and finds the gate already closed.
    beginRequest(req(), () => {})
    cancelRequest("req-1", "deactivate")
    expect(settleRequest("req-1")).toBe(true) // the cancel path answers
    expect(settleRequest("req-1")).toBe(false) // the late handler is dropped
  })
})

describe("cancelRequest", () => {
  it("aborts the signal and records the reason", () => {
    const signal = beginRequest(req(), () => {})
    cancelRequest("req-1", "unload")
    expect(signal.aborted).toBe(true)
    expect(abortReasonFor("req-1")).toBe("unload")
  })

  it("keeps the entry so the handler can still read the abort reason", () => {
    // Removing here would lose the reason before the handler's promise rejects,
    // and every cancellation would degrade to a bare CANCELLED.
    beginRequest(req(), () => {})
    cancelRequest("req-1", "timeout")
    expect(pendingCount()).toBe(1)
    expect(abortReasonFor("req-1")).toBe("timeout")
  })

  it("is a no-op for unknown ids", () => {
    expect(() => cancelRequest("ghost", "caller")).not.toThrow()
  })

  it("does not overwrite the reason of an already-settled request", () => {
    beginRequest(req(), () => {})
    settleRequest("req-1")
    cancelRequest("req-1", "unload")
    expect(abortReasonFor("req-1")).toBeUndefined()
  })
})

describe("bulk aborts", () => {
  it("abortAllForPlugin touches only the named plugin", () => {
    const a = beginRequest(req({ requestId: "a", pluginId: "alpha" }), () => {})
    const b = beginRequest(req({ requestId: "b", pluginId: "beta" }), () => {})

    expect(abortAllForPlugin("alpha", "deactivate")).toBe(1)
    expect(a.aborted).toBe(true)
    expect(b.aborted).toBe(false)
    expect(abortReasonFor("a")).toBe("deactivate")
  })

  it("abortAll ends everything in flight", () => {
    const a = beginRequest(req({ requestId: "a" }), () => {})
    const b = beginRequest(req({ requestId: "b" }), () => {})
    expect(abortAll("unload")).toBe(2)
    expect(a.aborted).toBe(true)
    expect(b.aborted).toBe(true)
  })

  it("skips already-settled requests when counting", () => {
    beginRequest(req({ requestId: "a" }), () => {})
    beginRequest(req({ requestId: "b" }), () => {})
    settleRequest("a")
    expect(abortAll("unload")).toBe(1)
  })

  it("abortAll leaves the response gate open by default", () => {
    // The cancel path still owes the guest exactly one response — the
    // handler's abort rejection — so aborting must not consume the gate.
    beginRequest(req(), () => {})
    abortAll("caller")
    expect(settleRequest("req-1")).toBe(true)
  })

  it("abortAll({ settle: true }) closes the gate for teardown", () => {
    // The teardown case: listeners are gone, so a handler that ignores its
    // abort signal must not be able to respond through a dead bridge.
    beginRequest(req(), () => {})
    abortAll("unload", { settle: true })
    expect(settleRequest("req-1")).toBe(false)
    expect(pendingCount()).toBe(0)
  })
})

describe("__resetWasmRequestRegistryForTesting", () => {
  it("clears entries and their timers", () => {
    jest.useFakeTimers()
    try {
      const signal = beginRequest(req({ timeoutMs: 10 }), () => {})
      __resetWasmRequestRegistryForTesting()
      expect(pendingCount()).toBe(0)
      // The timer must be cleared, not merely orphaned.
      jest.advanceTimersByTime(1000)
      expect(signal.aborted).toBe(false)
    } finally {
      jest.useRealTimers()
    }
  })
})
