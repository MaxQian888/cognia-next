import {
  CIRCUIT_OPEN_MS,
  CIRCUIT_OPEN_THRESHOLD,
  isCapabilityProtocolFailure,
  isCircuitOpen,
  recordCapabilityFailure,
  recordCapabilitySuccess,
} from "./capability-health"
import type { CapabilityHealthEntry } from "./certification-store"

const now = new Date("2026-07-23T00:00:00.000Z")

function fail(entries: CapabilityHealthEntry[], times: number): CapabilityHealthEntry[] {
  let next = entries
  for (let i = 0; i < times; i += 1) {
    next = recordCapabilityFailure(next, "key-1", "mcp", now)
  }
  return next
}

describe("capability circuit breaking", () => {
  it("stays closed below the consecutive-failure threshold", () => {
    const entries = fail([], CIRCUIT_OPEN_THRESHOLD - 1)
    expect(entries).toHaveLength(1)
    expect(entries[0].consecutiveFailures).toBe(CIRCUIT_OPEN_THRESHOLD - 1)
    expect(entries[0].openUntil).toBeUndefined()
    expect(isCircuitOpen(entries, "key-1", "mcp", now)).toBe(false)
  })

  it("opens for the bounded window at the threshold, then expires on its own", () => {
    const entries = fail([], CIRCUIT_OPEN_THRESHOLD)
    expect(entries[0].openUntil).toBe(new Date(now.getTime() + CIRCUIT_OPEN_MS).toISOString())
    expect(isCircuitOpen(entries, "key-1", "mcp", now)).toBe(true)
    expect(isCircuitOpen(entries, "key-1", "mcp", new Date(now.getTime() + CIRCUIT_OPEN_MS))).toBe(
      false
    )
  })

  it("scopes the circuit to (keyId, capability) — other pairs stay closed", () => {
    const entries = fail([], CIRCUIT_OPEN_THRESHOLD)
    expect(isCircuitOpen(entries, "key-1", "streaming", now)).toBe(false)
    expect(isCircuitOpen(entries, "key-2", "mcp", now)).toBe(false)
  })

  it("a success closes the circuit and resets the failure count", () => {
    const opened = fail([], CIRCUIT_OPEN_THRESHOLD)
    const closed = recordCapabilitySuccess(opened, "key-1", "mcp")
    expect(closed).toHaveLength(0)
    expect(isCircuitOpen(closed, "key-1", "mcp", now)).toBe(false)
    // The count restarts from 1 after a close (no memory of the old streak).
    const reFailed = recordCapabilityFailure(closed, "key-1", "mcp", now)
    expect(reFailed[0].consecutiveFailures).toBe(1)
  })

  it("preserves unrelated entries when recording", () => {
    const other: CapabilityHealthEntry = {
      keyId: "key-2",
      capability: "mcp",
      consecutiveFailures: 1,
    }
    const entries = recordCapabilityFailure([other], "key-1", "mcp", now)
    expect(entries).toHaveLength(2)
    expect(recordCapabilitySuccess(entries, "key-1", "mcp")).toEqual([other])
  })

  it("counts only explicit capability or protocol failures", () => {
    expect(isCapabilityProtocolFailure(new Error("RPC method not found: reloadPlugins"))).toBe(true)
    expect(isCapabilityProtocolFailure({ code: "CAPABILITY_UNAVAILABLE" })).toBe(true)
    expect(isCapabilityProtocolFailure({ code: "NOT_IMPLEMENTED" })).toBe(true)
    expect(isCapabilityProtocolFailure({ status: 501 })).toBe(true)
    expect(isCapabilityProtocolFailure(new Error("unsupported endpoint"))).toBe(true)
    expect(isCapabilityProtocolFailure(new Error("unsupported capability: checkpoint"))).toBe(true)

    expect(isCapabilityProtocolFailure(new DOMException("cancelled", "AbortError"))).toBe(false)
    expect(isCapabilityProtocolFailure(new Error("permission denied by user"))).toBe(false)
    expect(isCapabilityProtocolFailure(new Error("authentication failed"))).toBe(false)
    expect(isCapabilityProtocolFailure(new Error("quota exceeded"))).toBe(false)
    expect(isCapabilityProtocolFailure(new Error("model overloaded"))).toBe(false)
  })
})
