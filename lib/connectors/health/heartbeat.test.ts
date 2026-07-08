/** @jest-environment jsdom */
/**
 * Coverage for the heartbeat loop:
 *   - recordHeartbeatNow writes one connectorHeartbeats row (v51 dedicated table)
 *   - older heartbeat rows for the same adapter are pruned past `retentionMs`
 *     without touching the connectorAudit table
 *   - pendingOutboundCount reads the [adapterId+status] index
 *   - the loop is idempotent on dispose, and a thrown adapter.health() degrades
 *     the snapshot to {state: "degraded", reason: <message>}
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_RETENTION_MS, recordHeartbeatNow } from "./heartbeat"

const mockGetAdapterRuntimeStateSnapshot = jest.fn()

jest.mock("@/lib/connectors/outbound-runner", () => ({
  getAdapterRuntimeStateSnapshot: (...args: unknown[]) =>
    mockGetAdapterRuntimeStateSnapshot(...args),
}))

function makeAdapter(
  id: string,
  health: PlatformAdapter["health"] = () => ({
    state: "running",
    lastActivityAt: Date.now(),
  })
): PlatformAdapter {
  return {
    id,
    meta: {
      type: "lark",
      displayName: id,
      version: "0.1.0",
      capabilities: [],
      transportModes: ["webhook"] as const,
      configSchema: {},
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health,
    send: jest.fn(),
    a2uiCapability: () => ({}) as never,
  } as unknown as PlatformAdapter
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  mockGetAdapterRuntimeStateSnapshot.mockReset()
  mockGetAdapterRuntimeStateSnapshot.mockReturnValue(null)
})

describe("recordHeartbeatNow", () => {
  it("writes one adapter.heartbeat row with the health snapshot", async () => {
    const adapter = makeAdapter("lark-hb-1", () => ({
      state: "running",
      lastActivityAt: 9_000_000,
    }))
    const result = await recordHeartbeatNow(adapter, { now: () => 10_000_000 })
    expect(result.state).toBe("running")

    const rows = await getDb()
      .connectorHeartbeats.where("[adapterId+at]")
      .between(["lark-hb-1", 0], ["lark-hb-1", 11_000_000])
      .toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe("adapter.heartbeat")
    expect(rows[0].at).toBe(10_000_000)
    expect(rows[0].fields).toMatchObject({
      state: "running",
      lastActivityAt: 9_000_000,
      pendingOutboundCount: 0,
    })
  })

  it("captures pending outbound jobs into the heartbeat row", async () => {
    const now = 12_345_678
    await getDb().outboundQueue.bulkPut([
      {
        id: "ob-1",
        adapterId: "lark-pend",
        conversationKey: "lark:lark-pend:1",
        request: {
          conversationRef: { platform: "lark", adapterId: "lark-pend", chatId: "1" },
          segments: [{ type: "text", text: "x" }],
          metadata: { idempotencyKey: "k1" },
        },
        status: "pending",
        attempts: 0,
        createdAt: now,
        nextAttemptAt: now,
        idempotencyKey: "k1",
        source: "ai-run",
      },
      {
        id: "ob-2",
        adapterId: "lark-pend",
        conversationKey: "lark:lark-pend:1",
        request: {
          conversationRef: { platform: "lark", adapterId: "lark-pend", chatId: "1" },
          segments: [{ type: "text", text: "y" }],
          metadata: { idempotencyKey: "k2" },
        },
        status: "sending",
        attempts: 1,
        createdAt: now,
        nextAttemptAt: now,
        idempotencyKey: "k2",
        source: "ai-run",
      },
      {
        id: "ob-sent",
        adapterId: "lark-pend",
        conversationKey: "lark:lark-pend:1",
        request: {
          conversationRef: { platform: "lark", adapterId: "lark-pend", chatId: "1" },
          segments: [{ type: "text", text: "z" }],
          metadata: { idempotencyKey: "k3" },
        },
        status: "sent",
        attempts: 1,
        createdAt: now,
        nextAttemptAt: now,
        idempotencyKey: "k3",
        source: "ai-run",
      },
    ])

    const adapter = makeAdapter("lark-pend")
    await recordHeartbeatNow(adapter, { now: () => now })

    const row = await getDb().connectorHeartbeats.where("adapterId").equals("lark-pend").first()
    expect(row?.fields?.pendingOutboundCount).toBe(2)
  })

  it("degrades to {state: 'degraded', reason} when adapter.health() throws", async () => {
    const adapter = makeAdapter("lark-throw", () => {
      throw new Error("transport offline")
    })
    const result = await recordHeartbeatNow(adapter, { now: () => 1 })
    expect(result.state).toBe("degraded")
    expect(result.reason).toBe("transport offline")
    const row = await getDb().connectorHeartbeats.where("adapterId").equals("lark-throw").first()
    expect(row?.fields?.state).toBe("degraded")
    expect(row?.fields?.reason).toBe("transport offline")
  })

  it("captures outbound-runner runtime snapshot into the heartbeat row when available", async () => {
    mockGetAdapterRuntimeStateSnapshot.mockReturnValue({
      breaker: {
        state: "half_open",
        openedAt: 9_500_000,
        halfOpenSuccesses: 1,
        recentFailureRate: 75,
        eventCount: 4,
      },
      bucket: {
        available: 3.5,
        capacity: 20,
        refillPerSec: 5,
        nextRefillAt: 10_000_500,
      },
    })

    const adapter = makeAdapter("lark-runtime")
    await recordHeartbeatNow(adapter, { now: () => 10_000_000 })

    const row = await getDb().connectorHeartbeats.where("adapterId").equals("lark-runtime").first()
    expect(row?.fields).toMatchObject({
      breakerState: "half_open",
      breakerOpenedAt: 9_500_000,
      breakerFailureRate: 75,
      breakerEventCount: 4,
      rateAvailable: 3.5,
      rateCapacity: 20,
      rateRefillPerSec: 5,
      rateNextRefillAt: 10_000_500,
    })
  })

  it("writes null breaker/rate fields when the runner has no state for this adapter", async () => {
    mockGetAdapterRuntimeStateSnapshot.mockReturnValue(null)
    const adapter = makeAdapter("lark-no-runtime")
    await recordHeartbeatNow(adapter, { now: () => 1 })
    const row = await getDb()
      .connectorHeartbeats.where("adapterId")
      .equals("lark-no-runtime")
      .first()
    expect(row?.fields).toMatchObject({
      breakerState: null,
      breakerOpenedAt: null,
      rateAvailable: null,
      rateCapacity: null,
    })
  })

  it("prunes older heartbeats past retentionMs without touching connectorAudit", async () => {
    const now = 100_000_000
    // Ancient heartbeat lives in the dedicated table and should be pruned.
    await getDb().connectorHeartbeats.put({
      id: "hb-ancient",
      adapterId: "lark-prune",
      kind: "adapter.heartbeat",
      at: now - 200_000_000, // 200M ms ago
    })
    // A real audit event of the SAME adapter must be left completely alone —
    // the prune operates only on connectorHeartbeats now.
    await getDb().connectorAudit.put({
      id: "aud-ancient-err",
      adapterId: "lark-prune",
      kind: "adapter.error",
      at: now - 200_000_000,
      reason: "do-not-delete-me",
    })

    const adapter = makeAdapter("lark-prune")
    await recordHeartbeatNow(adapter, { now: () => now, retentionMs: 60_000 })

    const heartbeats = await getDb()
      .connectorHeartbeats.where("adapterId")
      .equals("lark-prune")
      .toArray()
    const hbIds = heartbeats.map((r) => r.id)
    expect(hbIds).not.toContain("hb-ancient")
    // The fresh heartbeat is present.
    expect(heartbeats.some((r) => r.at === now)).toBe(true)

    // The audit table is untouched by the heartbeat prune.
    const audit = await getDb().connectorAudit.where("adapterId").equals("lark-prune").toArray()
    expect(audit.map((r) => r.id)).toContain("aud-ancient-err")
  })
})

describe("heartbeat constants", () => {
  it("uses 30s default interval and 48h default retention", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000)
    expect(HEARTBEAT_RETENTION_MS).toBe(48 * 60 * 60 * 1000)
  })
})
