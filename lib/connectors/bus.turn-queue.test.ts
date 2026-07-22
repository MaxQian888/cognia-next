/** @jest-environment jsdom */
/**
 * Integration tests for the per-conversation route-handler turn queue.
 *
 * Before this queue existed, `dispatchInboundFull` awaited the ENTIRE model
 * turn, so the adapter's transport for-await loop was blocked for the whole
 * turn. The P0 consequence: when an ask-tier tool suspended the turn on a
 * HITL approval, the user's Allow click (another envelope on the SAME loop)
 * could never be processed until the approval TTL auto-denied — and one slow
 * turn head-of-line-blocked every other conversation on the adapter.
 *
 * Scenarios:
 *   (a) approval callback resolves a turn suspended on the approval registry
 *       (the P0 reproduction).
 *   (b) a slow turn in conversation A does not delay conversation B.
 *   (c) a throwing route handler is audited, dispatch resolves, and the next
 *       event still dispatches (transport-loop survivability).
 *   (d) same-conversation ordering is preserved.
 *   (e) queue overflow remains durable as history-only work with a diagnostic.
 */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import { createAdapterInstance, updateAdapterInstance } from "@/lib/db/adapter-instances"
import { listRecent } from "@/lib/db/connector-audit"
import { getBus, __resetBusForTesting } from "./bus"
import { __resetPruneCounterForTesting } from "./dedup"
import { recordCallbackBinding } from "./adapters/_shared/a2ui-mapper"
import {
  awaitApproval,
  pendingApprovalCount,
  __resetApprovalRegistryForTesting,
} from "./hitl/approval-registry"
import type { NormalizedInboundEvent, PlatformAdapter } from "@/types/connectors"
import type { ConnectorCallbackEvent } from "@/types/connectors/interaction"
import type { TriggerPolicy } from "@/types/connectors/policy"

const AUTO_TRIGGER: TriggerPolicy = {
  rules: [{ kind: "private-default" }, { kind: "self-mention" }],
  blockers: [],
  storeUnmatchedInDraftMode: false,
}

function makeAdapter(id: string): PlatformAdapter {
  return {
    id,
    meta: {
      type: "telegram",
      displayName: `Bot ${id}`,
      version: "1.0.0",
      capabilities: [],
      transportModes: ["stub"],
      configSchema: {},
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockReturnValue({ state: "running" }),
    send: jest.fn().mockResolvedValue({ ok: true }),
  } as unknown as PlatformAdapter
}

function privateEvent(
  adapterId: string,
  messageId: string,
  chatId = "chatA"
): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId,
    selfId: "bot_1",
    messageId,
    conversationRef: { platform: "telegram", adapterId },
    conversationKey: `telegram:${adapterId}:${chatId}`,
    sender: { id: "u_alice", platform: "telegram", adapterId, remoteUserId: "u_alice" },
    channel: { id: `ch_${chatId}`, kind: "private" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  }
}

async function seedAdapter(): Promise<string> {
  const row = await createAdapterInstance({
    type: "telegram",
    displayName: "Queue Bot",
    enabled: true,
    transportMode: "stub",
    settings: {},
    credentialsRef: { keyringService: "test", accounts: [] },
    trigger: AUTO_TRIGGER,
    defaultMode: "auto",
  })
  getBus().registerAdapter(makeAdapter(row.id))
  return row.id
}

/** Deferred helper: an externally-resolvable promise. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  __resetBusForTesting()
  __resetPruneCounterForTesting()
  __resetApprovalRegistryForTesting()
}, 30_000)

describe("ConnectorBus turn queue — HITL approval mid-turn (P0)", () => {
  it("an approval callback is processed WHILE a turn is suspended, and the turn completes", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const conversationKey = `telegram:${adapterId}:chatA`

    // Route handler suspends the turn on the approval registry — exactly what
    // an ask-tier tool permission request does mid-turn.
    const decisions: string[] = []
    bus.routeHandler = async () => {
      const res = await awaitApproval("sess_q", "req_q", { ttlMs: 0 })
      decisions.push(res.decision)
    }

    await recordCallbackBinding({
      adapterId,
      actionId: "tapa:queue",
      surfaceId: "tool_approve:sfc",
      componentId: "allow",
      conversationKey,
      kind: "tool_approve",
      payload: { sessionId: "sess_q", requestId: "req_q", toolName: "Bash", decision: "allow" },
    })

    // The inbound dispatch must RESOLVE while the turn is still suspended —
    // this is the property that frees the transport loop.
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_hitl"))
    expect(pendingApprovalCount()).toBe(1)
    expect(decisions).toEqual([])

    // The Allow click arrives on the (now free) transport loop.
    const callback: ConnectorCallbackEvent = {
      platform: "telegram",
      adapterId,
      selfId: "bot_1",
      triggerId: "tapa:queue",
      surfaceId: "tool_approve:sfc",
      componentId: "allow",
      actionType: "button",
      value: "allow",
      conversationKey,
      user: { id: "u_alice", platform: "telegram", adapterId, remoteUserId: "u_alice" },
      timestamp: Date.now(),
      raw: {},
    }
    await bus.dispatchConnectorCallback(callback)
    await bus.flushInboundTurns()

    expect(decisions).toEqual(["allow"])
    expect(pendingApprovalCount()).toBe(0)
    const audit = await listRecent(adapterId)
    expect(audit.some((r) => r.kind === "tool_approve.granted")).toBe(true)
  })
})

describe("ConnectorBus turn queue — parallelism and ordering", () => {
  it("operator resume does not reclassify an unrelated live turn as recovery-required", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const gate = deferred()
    bus.routeHandler = async () => gate.promise

    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_still_running"))
    const before = await getDb()
      .connectorInboundJobs.filter((row) => row.sourceMessageId === "msg_still_running")
      .first()
    expect(before?.status).toBe("running")

    await expect(bus.resumeDurableInboundJobs()).resolves.toEqual({
      resumed: 0,
      recoveryRequired: 0,
    })
    expect((await getDb().connectorInboundJobs.get(before!.id))?.status).toBe("running")

    gate.resolve()
    await bus.flushInboundTurns()
  })

  it("a slow turn in conversation A does not delay conversation B", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const gateA = deferred()
    const completed: string[] = []
    const bDone = deferred()

    bus.routeHandler = async (event) => {
      if (event.conversationKey.endsWith(":chatA")) await gateA.promise
      completed.push(event.messageId)
      if (event.conversationKey.endsWith(":chatB")) bDone.resolve()
    }

    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_a1", "chatA"))
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_b1", "chatB"))

    // B's turn completes while A is still blocked.
    await bDone.promise
    expect(completed).toEqual(["msg_b1"])

    gateA.resolve()
    await bus.flushInboundTurns()
    expect(completed).toEqual(["msg_b1", "msg_a1"])
  })

  it("preserves same-conversation ordering even when the first turn is slower", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const completed: string[] = []

    bus.routeHandler = async (event) => {
      // First message deliberately slower — FIFO must still hold.
      if (event.messageId === "msg_1") await new Promise((r) => setTimeout(r, 30))
      completed.push(event.messageId)
    }

    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_1"))
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_2"))
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_3"))
    await bus.flushInboundTurns()

    expect(completed).toEqual(["msg_1", "msg_2", "msg_3"])
  })

  it("marks a configured steer follow-up for safe-boundary replay", async () => {
    const adapterId = await seedAdapter()
    await updateAdapterInstance(adapterId, { activeRunDispatchMode: "steer" })
    const bus = getBus()
    const gate = deferred()
    const observed: Array<[string, unknown]> = []

    bus.routeHandler = async (event) => {
      observed.push([event.messageId, event.channelData?.dispatchIntent])
      if (event.messageId === "msg_active") await gate.promise
    }

    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_active"))
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_steer"))
    expect(observed).toEqual([["msg_active", undefined]])

    gate.resolve()
    await bus.flushInboundTurns()
    expect(observed).toEqual([
      ["msg_active", undefined],
      ["msg_steer", "steer-replay"],
    ])
  })

  it("injects a steer into an active safe runtime without enqueueing a second turn", async () => {
    const adapterId = await seedAdapter()
    await updateAdapterInstance(adapterId, { activeRunDispatchMode: "steer" })
    const bus = getBus()
    const gate = deferred()
    const observed: string[] = []
    bus.routeHandler = async (event) => {
      observed.push(event.messageId)
      if (event.messageId === "msg_active") await gate.promise
    }
    bus.liveSteerHandler = jest.fn(async () => ({
      activeRun: true,
      accepted: true,
      executionRunId: "execution:active",
    }))

    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_active"))
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_steer_live"))

    expect(bus.liveSteerHandler).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "msg_steer_live" })
    )
    expect(observed).toEqual(["msg_active"])
    const job = await getDb()
      .connectorInboundJobs.filter((row) => row.sourceMessageId === "msg_steer_live")
      .first()
    expect(job).toEqual(
      expect.objectContaining({ status: "completed", executionRunId: "execution:active" })
    )

    gate.resolve()
    await bus.flushInboundTurns()
  })
})

describe("ConnectorBus turn queue — error containment", () => {
  it("a throwing route handler is audited; dispatch resolves; the next event still dispatches", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const completed: string[] = []
    bus.routeHandler = async (event) => {
      if (event.messageId === "msg_boom") throw new Error("turn exploded")
      completed.push(event.messageId)
    }

    // The transport loop must survive: dispatch resolves normally.
    await expect(
      bus.dispatchInboundFull(privateEvent(adapterId, "msg_boom"))
    ).resolves.toBeUndefined()
    await bus.flushInboundTurns()

    const audit = await listRecent(adapterId)
    const errRow = audit.find(
      (r) => r.kind === "adapter.error" && r.reason === "route_handler_failed"
    )
    expect(errRow).toBeDefined()
    expect(errRow?.message).toContain("turn exploded")

    // Subsequent event on the same conversation still dispatches.
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_after"))
    await bus.flushInboundTurns()
    expect(completed).toEqual(["msg_after"])
  })

  it("an inbound-pipeline exception is contained (audited, never thrown to the transport)", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    // Force a pipeline failure upstream of the route handler by breaking the
    // Step 3 override lookup (a Dexie failure mid-pipeline).
    const event = privateEvent(adapterId, "msg_pipeline_boom")
    const spy = jest.spyOn(getDb().conversationOverrides, "where").mockImplementation(() => {
      throw new Error("dexie exploded")
    })
    try {
      await expect(bus.dispatchInboundFull(event)).resolves.toBeUndefined()
    } finally {
      spy.mockRestore()
    }
    const audit = await listRecent(adapterId)
    expect(
      audit.some((r) => r.kind === "adapter.error" && r.reason === "inbound_pipeline_failed")
    ).toBe(true)
    expect(
      await getDb()
        .connectorInboundJobs.toCollection()
        .filter((job) => job.sourceMessageId === event.messageId)
        .first()
    ).toEqual(expect.objectContaining({ status: "queued" }))
  })
})

describe("ConnectorBus turn queue — overflow backpressure", () => {
  it("keeps 100 turns and marks excess messages history-only with a diagnostic", async () => {
    const adapterId = await seedAdapter()
    const bus = getBus()
    const gate = deferred()
    const handler = jest.fn(async () => {
      await gate.promise
    })
    bus.routeHandler = handler

    // 102 distinct messages on ONE conversation while the handler is wedged:
    // 100 queue (including the running one), 2 remain in durable history only.
    for (let i = 0; i < 102; i++) {
      await bus.dispatchInboundFull(privateEvent(adapterId, `msg_flood_${i}`))
    }

    const audit = await listRecent(adapterId)
    const overflow = audit.filter(
      (r) => r.kind === "adapter.error" && r.reason === "turn_queue_overflow"
    )
    expect(overflow).toHaveLength(2)

    gate.resolve()
    await bus.flushInboundTurns()
    expect(handler).toHaveBeenCalledTimes(100)

    const historyOnly = await getDb()
      .connectorInboundJobs.where("status")
      .equals("history_only")
      .toArray()
    expect(historyOnly).toHaveLength(2)
    expect(historyOnly.every((job) => job.recoveryReason === "pending_limit_exceeded")).toBe(true)

    // The queue map is cleaned up once drained (bounded map).
    await bus.dispatchInboundFull(privateEvent(adapterId, "msg_after_flood"))
    await bus.flushInboundTurns()
    expect(handler).toHaveBeenCalledTimes(101)
  })
})
