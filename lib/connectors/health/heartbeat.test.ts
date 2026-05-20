/**
 * Coverage for the heartbeat loop:
 *   - recordHeartbeatNow writes one connectorAudit row with kind=adapter.heartbeat
 *   - older heartbeat rows for the same adapter are pruned past `retentionMs`
 *   - pendingOutboundCount reads the [adapterId+status] index
 *   - the loop is idempotent on dispose, and a thrown adapter.health() degrades
 *     the snapshot to {state: "degraded", reason: <message>}
 */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import type { PlatformAdapter } from "@/types/connectors/adapter"
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_RETENTION_MS,
  recordHeartbeatNow,
  startAdapterHeartbeat,
} from "./heartbeat"

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
      .connectorAudit.where("[adapterId+at]")
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

    const row = await getDb().connectorAudit.where("adapterId").equals("lark-pend").first()
    expect(row?.fields?.pendingOutboundCount).toBe(2)
  })

  it("degrades to {state: 'degraded', reason} when adapter.health() throws", async () => {
    const adapter = makeAdapter("lark-throw", () => {
      throw new Error("transport offline")
    })
    const result = await recordHeartbeatNow(adapter, { now: () => 1 })
    expect(result.state).toBe("degraded")
    expect(result.reason).toBe("transport offline")
    const row = await getDb().connectorAudit.where("adapterId").equals("lark-throw").first()
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

    const row = await getDb().connectorAudit.where("adapterId").equals("lark-runtime").first()
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
    const row = await getDb().connectorAudit.where("adapterId").equals("lark-no-runtime").first()
    expect(row?.fields).toMatchObject({
      breakerState: null,
      breakerOpenedAt: null,
      rateAvailable: null,
      rateCapacity: null,
    })
  })

  it("prunes older heartbeats past retentionMs but keeps other audit kinds", async () => {
    const now = 100_000_000
    const ancientHeartbeat = {
      id: "aud-ancient-hb",
      adapterId: "lark-prune",
      kind: "adapter.heartbeat" as const,
      at: now - 200_000_000, // 200M ms ago
    }
    const ancientError = {
      id: "aud-ancient-err",
      adapterId: "lark-prune",
      kind: "adapter.error" as const,
      at: now - 200_000_000,
      reason: "do-not-delete-me",
    }
    await getDb().connectorAudit.bulkPut([ancientHeartbeat, ancientError])

    const adapter = makeAdapter("lark-prune")
    await recordHeartbeatNow(adapter, { now: () => now, retentionMs: 60_000 })

    const remaining = await getDb().connectorAudit.where("adapterId").equals("lark-prune").toArray()
    const ids = remaining.map((r) => r.id)
    expect(ids).toContain("aud-ancient-err")
    expect(ids).not.toContain("aud-ancient-hb")
    // And the fresh heartbeat is there too.
    expect(remaining.some((r) => r.kind === "adapter.heartbeat" && r.at === now)).toBe(true)
  })
})

describe("startAdapterHeartbeat", () => {
  it("fires the first heartbeat immediately and then on every interval", async () => {
    const adapter = makeAdapter("lark-loop")
    const handles: Array<() => void> = []
    const scheduler = {
      setInterval: jest.fn((cb: () => void, _ms: number) => {
        handles.push(cb)
        return handles.length
      }),
      clearInterval: jest.fn(),
    }
    const handle = startAdapterHeartbeat({
      adapter,
      intervalMs: 50,
      scheduler,
    })
    // The immediate fire is a fire-and-forget Promise — wait for the Dexie
    // put + audit append to settle. Polling lets fake-indexeddb flush.
    const waitFor = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 50; i++) {
        if (await predicate()) return
        await new Promise((r) => setTimeout(r, 20))
      }
      throw new Error("waitFor predicate never resolved")
    }
    await waitFor(async () => {
      const rows = await getDb().connectorAudit.where("adapterId").equals("lark-loop").toArray()
      return rows.length >= 1
    })
    // simulate scheduler ticks
    handles[0]()
    handles[0]()
    await waitFor(async () => {
      const rows = await getDb().connectorAudit.where("adapterId").equals("lark-loop").toArray()
      return rows.length >= 3
    })
    handle.dispose()
    expect(scheduler.clearInterval).toHaveBeenCalledTimes(1)
  })

  it("dispose() is idempotent", () => {
    const adapter = makeAdapter("lark-dispose")
    const scheduler = {
      setInterval: jest.fn(() => 42),
      clearInterval: jest.fn(),
    }
    const handle = startAdapterHeartbeat({ adapter, intervalMs: 100, scheduler })
    handle.dispose()
    handle.dispose()
    expect(scheduler.clearInterval).toHaveBeenCalledTimes(1)
  })

  it("uses 30s default interval and 48h default retention", () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000)
    expect(HEARTBEAT_RETENTION_MS).toBe(48 * 60 * 60 * 1000)
  })

  it("post-dispose scheduler callbacks are no-ops", async () => {
    const adapter = makeAdapter("lark-post-dispose")
    // Use a ref-style holder so TS narrowing doesn't collapse the type to
    // `never` after assignment inside the mock body.
    const cbRef: { current: (() => void) | null } = { current: null }
    const scheduler = {
      setInterval: jest.fn((cb: () => void) => {
        cbRef.current = cb
        return 1
      }),
      clearInterval: jest.fn(),
    }
    const handle = startAdapterHeartbeat({ adapter, intervalMs: 1000, scheduler })
    // Wait for the immediate fire to settle before measuring the baseline,
    // otherwise the immediate write races with the post-dispose check.
    const waitFor = async (predicate: () => Promise<boolean>) => {
      for (let i = 0; i < 50; i++) {
        if (await predicate()) return
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    await waitFor(async () => {
      const rows = await getDb()
        .connectorAudit.where("adapterId")
        .equals("lark-post-dispose")
        .toArray()
      return rows.length >= 1
    })
    handle.dispose()
    const countBefore = (
      await getDb().connectorAudit.where("adapterId").equals("lark-post-dispose").toArray()
    ).length
    cbRef.current?.()
    // Give the (no-op) callback time to NOT do anything — long enough that a
    // real write would have landed if the disposer were broken.
    await new Promise((r) => setTimeout(r, 100))
    const countAfter = (
      await getDb().connectorAudit.where("adapterId").equals("lark-post-dispose").toArray()
    ).length
    expect(countAfter).toBe(countBefore)
  })
})
