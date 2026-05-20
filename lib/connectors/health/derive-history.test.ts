/**
 * Coverage for the pure bucket/classify helpers in `derive-history.ts`.
 */

import type { AuditEntry } from "@/types/connectors/audit"
import { deriveCurrentState, deriveHistory, deriveLastError, deriveLastOk } from "./derive-history"

function audit(partial: Partial<AuditEntry> & Pick<AuditEntry, "kind" | "at">): AuditEntry {
  return {
    id: `aud_${partial.kind}_${partial.at}`,
    adapterId: "lark-1",
    ...partial,
  }
}

const NOW = 1_700_000_000_000

describe("deriveHistory", () => {
  it("returns 48 buckets covering the last 24h at 30min resolution", () => {
    const buckets = deriveHistory([], { now: NOW })
    expect(buckets).toHaveLength(48)
    expect(buckets[0].bucketStart).toBe(NOW - 24 * 60 * 60 * 1000)
    expect(buckets[buckets.length - 1].bucketEnd).toBe(NOW)
  })

  it("an empty entry list yields unknown buckets", () => {
    const buckets = deriveHistory([], { now: NOW })
    expect(buckets.every((b) => b.state === "unknown")).toBe(true)
    expect(buckets.every((b) => b.eventCount === 0)).toBe(true)
  })

  it("classifies a heartbeat (running) bucket as running", () => {
    const buckets = deriveHistory(
      [
        audit({
          kind: "adapter.heartbeat",
          at: NOW - 60 * 60 * 1000,
          fields: { state: "running" },
        }),
      ],
      { now: NOW }
    )
    const hit = buckets.find((b) => b.eventCount > 0)!
    expect(hit.state).toBe("running")
    expect(hit.eventCount).toBe(1)
  })

  it("severity precedence: down beats degraded beats running in the same bucket", () => {
    const at = NOW - 5 * 60 * 1000
    const buckets = deriveHistory(
      [
        audit({ kind: "delivery.success", at }),
        audit({ kind: "circuit.opened", at: at + 1 }),
        audit({ kind: "adapter.error", at: at + 2 }),
      ],
      { now: NOW }
    )
    const hit = buckets[buckets.length - 1]
    expect(hit.state).toBe("down")
    expect(hit.eventCount).toBe(3)
  })

  it("classifies deferred_quiet_hours as degraded", () => {
    const buckets = deriveHistory(
      [audit({ kind: "inbound.deferred_quiet_hours", at: NOW - 30 * 60 * 1000 })],
      { now: NOW }
    )
    const hit = buckets.find((b) => b.eventCount > 0)!
    expect(hit.state).toBe("degraded")
  })

  it("heartbeat field state 'starting' classifies as starting", () => {
    const buckets = deriveHistory(
      [
        audit({
          kind: "adapter.heartbeat",
          at: NOW - 10 * 60 * 1000,
          fields: { state: "starting" },
        }),
      ],
      { now: NOW }
    )
    const hit = buckets.find((b) => b.eventCount > 0)!
    expect(hit.state).toBe("starting")
  })

  it("ignores entries outside the window", () => {
    const buckets = deriveHistory(
      [
        audit({ kind: "delivery.success", at: NOW - 48 * 60 * 60 * 1000 }), // old
        audit({ kind: "delivery.success", at: NOW + 60 * 1000 }), // future
      ],
      { now: NOW }
    )
    expect(buckets.every((b) => b.eventCount === 0)).toBe(true)
  })

  it("honours custom windowMs + bucketMs", () => {
    const buckets = deriveHistory([], {
      now: NOW,
      windowMs: 60 * 60 * 1000,
      bucketMs: 5 * 60 * 1000,
    })
    expect(buckets).toHaveLength(12) // 12 × 5min = 1h
  })
})

describe("deriveCurrentState", () => {
  it("returns unknown for an empty list", () => {
    expect(deriveCurrentState([])).toEqual({ state: "unknown" })
  })

  it("reads the latest adapter.heartbeat snapshot", () => {
    const result = deriveCurrentState([
      audit({
        kind: "adapter.heartbeat",
        at: NOW - 30_000,
        fields: { state: "degraded", reason: "rate limited", lastActivityAt: NOW - 60_000 },
      }),
      audit({ kind: "delivery.success", at: NOW - 60_000 }),
    ])
    expect(result.state).toBe("degraded")
    expect(result.reason).toBe("rate limited")
    expect(result.lastActivityAt).toBe(NOW - 60_000)
  })

  it("falls back to classify(latest non-heartbeat) when no heartbeat exists", () => {
    const result = deriveCurrentState([
      audit({ kind: "delivery.success", at: NOW - 120_000 }),
      audit({ kind: "adapter.error", at: NOW - 60_000, reason: "auth_failed" }),
    ])
    expect(result.state).toBe("down")
    expect(result.reason).toBe("auth_failed")
  })

  it("heartbeat state 'running' surfaces as running by default", () => {
    const result = deriveCurrentState([
      audit({ kind: "adapter.heartbeat", at: NOW - 30_000, fields: {} }),
    ])
    expect(result.state).toBe("running")
  })
})

describe("deriveLastError", () => {
  it("returns undefined when no error rows exist", () => {
    expect(deriveLastError([])).toBeUndefined()
    expect(deriveLastError([audit({ kind: "delivery.success", at: NOW })])).toBeUndefined()
  })

  it("returns the newest delivery.error / adapter.error / deadletter", () => {
    const newer = audit({
      kind: "delivery.deadlettered",
      at: NOW - 1000,
      reason: "rate limit hit",
    })
    const older = audit({ kind: "delivery.error", at: NOW - 10_000 })
    const result = deriveLastError([older, newer])
    expect(result).toBe(newer)
  })

  it("includes inbound.signature_failed", () => {
    const sig = audit({ kind: "inbound.signature_failed", at: NOW - 500 })
    expect(deriveLastError([sig])).toBe(sig)
  })
})

describe("deriveLastOk", () => {
  it("returns undefined when no success rows exist", () => {
    expect(deriveLastOk([])).toBeUndefined()
  })

  it("returns the newest delivery.success / inbound.received / heartbeat (running)", () => {
    const newer = audit({
      kind: "adapter.heartbeat",
      at: NOW - 100,
      fields: { state: "running" },
    })
    const older = audit({ kind: "delivery.success", at: NOW - 1000 })
    expect(deriveLastOk([older, newer])).toBe(newer)
  })

  it("ignores heartbeats whose state is not running", () => {
    const degraded = audit({
      kind: "adapter.heartbeat",
      at: NOW - 100,
      fields: { state: "degraded" },
    })
    const success = audit({ kind: "delivery.success", at: NOW - 1000 })
    expect(deriveLastOk([degraded, success])).toBe(success)
  })
})
