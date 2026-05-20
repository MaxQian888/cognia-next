/**
 * @jest-environment jsdom
 */

import "fake-indexeddb/auto"
import { renderHook, waitFor } from "@testing-library/react"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { useAdapterHealth } from "./use-adapter-health"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
})

const NOW = 1_700_000_000_000

describe("useAdapterHealth", () => {
  it("returns unknown state when no audit entries exist", async () => {
    const { result } = renderHook(() => useAdapterHealth("lark-empty", { now: () => NOW }))
    await waitFor(() => {
      expect(result.current.current.state).toBe("unknown")
      expect(result.current.buckets).toHaveLength(48)
      expect(result.current.buckets.every((b) => b.state === "unknown")).toBe(true)
      expect(result.current.lastOk).toBeUndefined()
      expect(result.current.lastError).toBeUndefined()
      expect(result.current.pendingOutboundCount).toBe(0)
    })
  })

  it("derives running state from the latest heartbeat snapshot", async () => {
    await getDb().connectorAudit.put({
      id: "hb-running",
      adapterId: "lark-ok",
      kind: "adapter.heartbeat",
      at: NOW - 60_000,
      fields: { state: "running", lastActivityAt: NOW - 90_000, pendingOutboundCount: 3 },
    })
    const { result } = renderHook(() => useAdapterHealth("lark-ok", { now: () => NOW }))
    await waitFor(() => {
      expect(result.current.current.state).toBe("running")
      expect(result.current.pendingOutboundCount).toBe(3)
    })
  })

  it("surfaces lastError when an adapter.error row exists", async () => {
    const errorEntry = {
      id: "err-1",
      adapterId: "lark-err",
      kind: "adapter.error" as const,
      at: NOW - 30_000,
      reason: "auth_failed",
      message: "invalid creds",
    }
    const okEntry = {
      id: "ok-1",
      adapterId: "lark-err",
      kind: "delivery.success" as const,
      at: NOW - 120_000,
    }
    await getDb().connectorAudit.bulkPut([okEntry, errorEntry])
    const { result } = renderHook(() => useAdapterHealth("lark-err", { now: () => NOW }))
    await waitFor(() => {
      expect(result.current.lastError?.id).toBe("err-1")
      expect(result.current.lastOk?.id).toBe("ok-1")
    })
  })

  it("bucketises events into the 24h grid", async () => {
    const inWindow = {
      id: "w-1",
      adapterId: "lark-grid",
      kind: "delivery.success" as const,
      at: NOW - 60 * 60 * 1000, // 1h ago
    }
    const outsideWindow = {
      id: "w-2",
      adapterId: "lark-grid",
      kind: "delivery.success" as const,
      at: NOW - 48 * 60 * 60 * 1000,
    }
    await getDb().connectorAudit.bulkPut([inWindow, outsideWindow])
    const { result } = renderHook(() => useAdapterHealth("lark-grid", { now: () => NOW }))
    await waitFor(() => {
      const hits = result.current.buckets.filter((b) => b.eventCount > 0)
      expect(hits).toHaveLength(1)
      expect(hits[0].state).toBe("running")
    })
  })

  it("returns empty results when adapterId is null", async () => {
    const { result } = renderHook(() => useAdapterHealth(null, { now: () => NOW }))
    await waitFor(() => {
      expect(result.current.current.state).toBe("unknown")
    })
  })

  it("honours custom windowMs + bucketMs", async () => {
    const { result } = renderHook(() =>
      useAdapterHealth("lark-tiny", {
        now: () => NOW,
        windowMs: 60 * 60 * 1000,
        bucketMs: 5 * 60 * 1000,
      })
    )
    await waitFor(() => {
      expect(result.current.buckets).toHaveLength(12)
    })
  })

  it("surfaces breaker + rateBucket snapshots from the latest heartbeat", async () => {
    await getDb().connectorAudit.put({
      id: "aud-runtime-1",
      adapterId: "lark-runtime",
      kind: "adapter.heartbeat",
      at: NOW - 1000,
      fields: {
        state: "running",
        pendingOutboundCount: 0,
        breakerState: "half_open",
        breakerOpenedAt: NOW - 5000,
        breakerFailureRate: 60,
        breakerEventCount: 5,
        rateAvailable: 4.5,
        rateCapacity: 20,
        rateRefillPerSec: 5,
        rateNextRefillAt: NOW + 1000,
      },
    })

    const { result } = renderHook(() => useAdapterHealth("lark-runtime", { now: () => NOW }))
    await waitFor(() => {
      expect(result.current.breaker).toEqual({
        state: "half_open",
        openedAt: NOW - 5000,
        failureRate: 60,
        eventCount: 5,
      })
      expect(result.current.rateBucket).toEqual({
        available: 4.5,
        capacity: 20,
        refillPerSec: 5,
        nextRefillAt: NOW + 1000,
      })
    })
  })

  it("returns null breaker + rateBucket when the heartbeat lacks runtime fields", async () => {
    await getDb().connectorAudit.put({
      id: "aud-legacy",
      adapterId: "lark-legacy",
      kind: "adapter.heartbeat",
      at: NOW - 100,
      fields: { state: "running", pendingOutboundCount: 0 },
    })
    const { result } = renderHook(() => useAdapterHealth("lark-legacy", { now: () => NOW }))
    await waitFor(() => {
      expect(result.current.breaker).toBeNull()
      expect(result.current.rateBucket).toBeNull()
    })
  })
})
