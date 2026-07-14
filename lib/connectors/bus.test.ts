/**
 * Tests for ConnectorBus singleton (Task 25).
 * The runtime pipeline (Task 28) is exercised in bus.runtime.test.ts.
 */

import type {
  NormalizedInboundEvent,
  PlatformAdapter,
  OutboundRequest,
  ConnectorCallbackEvent,
} from "@/types/connectors"
import { getBus, __resetBusForTesting } from "./bus"
import { appendAudit } from "./audit"
import { evaluatePolicy } from "./policy-eval"
import type { TriggerPolicy } from "@/types/connectors/policy"

// The callback dispatch path touches Dexie via dedup / audit / binding lookup.
// Stub those three out so the observer wiring can be exercised in isolation —
// the existing registry / sendOutbound / dispatchInbound (Task 25) tests never
// reach these modules, so the mocks leave them untouched.
jest.mock("./dedup", () => ({
  recordAndCheckInbound: jest.fn().mockResolvedValue(true),
  // Read-only probe used by dispatchConnectorCallback's check-then-commit
  // dedup — `false` = "not seen yet" so every test callback dispatches.
  isRecordedInbound: jest.fn().mockResolvedValue(false),
}))
jest.mock("./audit", () => ({
  appendAudit: jest.fn().mockResolvedValue(undefined),
}))
jest.mock("./adapters/_shared/a2ui-mapper", () => ({
  resolveCallbackBinding: jest.fn().mockResolvedValue(undefined),
}))

// ── helpers ──────────────────────────────────────────────────────────────────

function makeAdapter(id: string): PlatformAdapter {
  return {
    id,
    meta: {
      type: "telegram",
      displayName: `Adapter ${id}`,
      version: "1.0.0",
      capabilities: [],
      transportModes: ["stub"],
      configSchema: {},
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockReturnValue({ state: "running" }),
    send: jest.fn().mockResolvedValue({ ok: true, platformMessageId: "pm_1" }),
  } as unknown as PlatformAdapter
}

function makeEvent(adapterId: string, messageId: string): NormalizedInboundEvent {
  return {
    platform: "telegram",
    adapterId,
    selfId: "bot_1",
    messageId,
    conversationRef: { platform: "telegram", adapterId },
    conversationKey: `telegram:${adapterId}:42`,
    sender: {
      id: "u_1",
      platform: "telegram",
      adapterId,
      remoteUserId: "u_1",
    },
    channel: { id: "ch_1", kind: "private" },
    segments: [{ type: "text", text: "hello" }],
    plainText: "hello",
    mentions: { selfMentioned: false, users: [] },
    timestamp: Date.now(),
    raw: {},
  }
}

function makeRequest(): OutboundRequest {
  return {
    conversationRef: { platform: "telegram", adapterId: "a1" },
    segments: [{ type: "text", text: "reply" }],
    metadata: { idempotencyKey: crypto.randomUUID() },
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetBusForTesting()
})

describe("ConnectorBus — adapter registry", () => {
  it("registerAdapter adds the adapter to the registry", () => {
    const bus = getBus()
    const a = makeAdapter("a1")
    bus.registerAdapter(a)
    expect(bus.listAdapters()).toContain(a)
  })

  it("listAdapters returns all registered adapters", () => {
    const bus = getBus()
    const a1 = makeAdapter("a1")
    const a2 = makeAdapter("a2")
    bus.registerAdapter(a1)
    bus.registerAdapter(a2)
    const list = bus.listAdapters()
    expect(list).toHaveLength(2)
    expect(list).toContain(a1)
    expect(list).toContain(a2)
  })

  it("unregisterAdapter removes the adapter", () => {
    const bus = getBus()
    const a = makeAdapter("a1")
    bus.registerAdapter(a)
    bus.unregisterAdapter("a1")
    expect(bus.listAdapters()).toHaveLength(0)
  })

  it("unregisterAdapter on unknown id is a no-op", () => {
    const bus = getBus()
    expect(() => bus.unregisterAdapter("nonexistent")).not.toThrow()
  })
})

describe("ConnectorBus — dispatchInbound", () => {
  it("invokes the registered inbound handler", async () => {
    const bus = getBus()
    const handler = jest.fn().mockResolvedValue(undefined)
    bus.setInboundHandler(handler)
    const event = makeEvent("a1", "m1")
    await bus.dispatchInbound(event)
    expect(handler).toHaveBeenCalledWith(event)
  })

  it("throws when no handler is set", async () => {
    const bus = getBus()
    await expect(bus.dispatchInbound(makeEvent("a1", "m1"))).rejects.toThrow(
      "inbound handler not set"
    )
  })
})

describe("ConnectorBus — system event external flag (Lark external group)", () => {
  function systemEvent(external?: boolean): NormalizedInboundEvent {
    return {
      ...makeEvent("a1", "m_sys"),
      kind: "system",
      systemKind: "member_removed",
      raw: {
        header: { event_type: "im.chat.member.bot.deleted_v1" },
        event: external === undefined ? {} : { external },
      },
    }
  }

  it("surfaces external:true in the member audit when the chat is external", async () => {
    const bus = getBus()
    await bus.dispatchInboundFull(systemEvent(true))
    expect(appendAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "inbound.member_removed",
        fields: expect.objectContaining({ external: true }),
      })
    )
  })

  it("omits external from the audit when the raw envelope has no external flag", async () => {
    const bus = getBus()
    await bus.dispatchInboundFull(systemEvent(undefined))
    const call = (appendAudit as jest.Mock).mock.calls.find(
      (c) => c[0]?.kind === "inbound.member_removed"
    )
    expect(call).toBeDefined()
    expect(call![0].fields).not.toHaveProperty("external")
  })
})

describe("ConnectorBus — sendOutbound", () => {
  it("delegates to the adapter's send method", async () => {
    const bus = getBus()
    const a = makeAdapter("a1")
    bus.registerAdapter(a)
    const req = makeRequest()
    const result = await bus.sendOutbound("a1", req)
    expect(result.ok).toBe(true)
    expect(a.send).toHaveBeenCalledWith(req)
  })

  it("returns adapter_not_found error when adapter is missing", async () => {
    const bus = getBus()
    const result = await bus.sendOutbound("missing", makeRequest())
    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe("adapter_not_found")
  })
})

describe("ConnectorBus — singleton + reset", () => {
  it("getBus returns the same instance on repeated calls", () => {
    const b1 = getBus()
    const b2 = getBus()
    expect(b1).toBe(b2)
  })

  it("__resetBusForTesting creates a fresh instance", () => {
    const b1 = getBus()
    __resetBusForTesting()
    const b2 = getBus()
    expect(b1).not.toBe(b2)
  })
})

describe("ConnectorBus — passive inbound observers", () => {
  beforeEach(() => __resetBusForTesting())

  it("notifies subscribers for every dispatched event and disposes", async () => {
    const bus = getBus()
    bus.setInboundHandler(jest.fn().mockResolvedValue(undefined))
    const seen: string[] = []
    const dispose = bus.subscribeInbound((e) => seen.push(e.messageId))

    await bus.dispatchInbound(makeEvent("a1", "m1"))
    expect(seen).toEqual(["m1"])

    dispose()
    await bus.dispatchInbound(makeEvent("a1", "m2"))
    expect(seen).toEqual(["m1"]) // no longer notified after dispose
  })

  it("a throwing observer never breaks inbound routing", async () => {
    const bus = getBus()
    const handler = jest.fn().mockResolvedValue(undefined)
    bus.setInboundHandler(handler)
    bus.subscribeInbound(() => {
      throw new Error("observer boom")
    })
    // dispatch must still complete + reach the real handler despite the throw.
    await expect(bus.dispatchInbound(makeEvent("a1", "m3"))).resolves.toBeUndefined()
    expect(handler).toHaveBeenCalled()
  })
})

// ── adapter-operation wrappers (edit / delete / typing / upload / history) ─────

describe("ConnectorBus — adapter-operation wrappers", () => {
  it("editOutbound delegates to adapter.edit", async () => {
    const bus = getBus()
    const a = makeAdapter("a1") as PlatformAdapter & { edit: jest.Mock }
    a.edit = jest.fn().mockResolvedValue({ ok: true, platformMessageId: "pm_2" })
    bus.registerAdapter(a)
    const patch = makeRequest()
    const res = await bus.editOutbound("a1", "pm_1", patch)
    expect(res.ok).toBe(true)
    expect(a.edit).toHaveBeenCalledWith("pm_1", patch)
  })

  it("editOutbound reports adapter_not_found / unsupported", async () => {
    const bus = getBus()
    expect((await bus.editOutbound("nope", "m", makeRequest())).error?.code).toBe(
      "adapter_not_found"
    )
    bus.registerAdapter(makeAdapter("a1")) // no edit method
    expect((await bus.editOutbound("a1", "m", makeRequest())).error?.code).toBe("unsupported")
  })

  it("deleteOutbound delegates and reports ok:true", async () => {
    const bus = getBus()
    const a = makeAdapter("a1") as PlatformAdapter & { delete: jest.Mock }
    a.delete = jest.fn().mockResolvedValue(undefined)
    bus.registerAdapter(a)
    const res = await bus.deleteOutbound("a1", "pm_1")
    expect(res.ok).toBe(true)
    expect(a.delete).toHaveBeenCalledWith("pm_1")
  })

  it("deleteOutbound reports adapter_not_found / unsupported", async () => {
    const bus = getBus()
    expect((await bus.deleteOutbound("nope", "m")).error?.code).toBe("adapter_not_found")
    bus.registerAdapter(makeAdapter("a1"))
    expect((await bus.deleteOutbound("a1", "m")).error?.code).toBe("unsupported")
  })

  it("addReactionOutbound delegates and reports ok:true", async () => {
    const bus = getBus()
    const a = makeAdapter("a1") as PlatformAdapter & { addReaction: jest.Mock }
    a.addReaction = jest.fn().mockResolvedValue(undefined)
    bus.registerAdapter(a)
    const res = await bus.addReactionOutbound("a1", "pm_1", "THUMBSUP")
    expect(res.ok).toBe(true)
    expect(a.addReaction).toHaveBeenCalledWith("pm_1", "THUMBSUP")
  })

  it("addReactionOutbound reports adapter_not_found / unsupported", async () => {
    const bus = getBus()
    expect((await bus.addReactionOutbound("nope", "m", "OK")).error?.code).toBe("adapter_not_found")
    bus.registerAdapter(makeAdapter("a1")) // no addReaction method
    expect((await bus.addReactionOutbound("a1", "m", "OK")).error?.code).toBe("unsupported")
  })

  it("addReactionOutbound surfaces the platform reactionId", async () => {
    const bus = getBus()
    const a = makeAdapter("a1") as PlatformAdapter & { addReaction: jest.Mock }
    a.addReaction = jest.fn().mockResolvedValue({ reactionId: "rx_7" })
    bus.registerAdapter(a)
    const res = await bus.addReactionOutbound("a1", "pm_1", "OK")
    expect(res.ok).toBe(true)
    expect((res as { reactionId?: string }).reactionId).toBe("rx_7")
  })

  it("removeReactionOutbound delegates and reports adapter_not_found / unsupported", async () => {
    const bus = getBus()
    const a = makeAdapter("a1") as PlatformAdapter & { removeReaction: jest.Mock }
    a.removeReaction = jest.fn().mockResolvedValue(undefined)
    bus.registerAdapter(a)
    expect((await bus.removeReactionOutbound("a1", "pm_1", "rx_7")).ok).toBe(true)
    expect(a.removeReaction).toHaveBeenCalledWith("pm_1", "rx_7")
    expect((await bus.removeReactionOutbound("nope", "m", "r")).error?.code).toBe(
      "adapter_not_found"
    )
    bus.registerAdapter(makeAdapter("a2"))
    expect((await bus.removeReactionOutbound("a2", "m", "r")).error?.code).toBe("unsupported")
  })

  it("forwardOutbound delegates the adapter result and reports not-found / unsupported", async () => {
    const bus = getBus()
    const a = makeAdapter("a1") as PlatformAdapter & { forwardMessage: jest.Mock }
    a.forwardMessage = jest.fn().mockResolvedValue({ ok: true, platformMessageId: "om_fwd" })
    bus.registerAdapter(a)
    const res = await bus.forwardOutbound("a1", { messageId: "om_1", target: "oc_dest" })
    expect(res.ok).toBe(true)
    expect(res.platformMessageId).toBe("om_fwd")
    expect(a.forwardMessage).toHaveBeenCalledWith({ messageId: "om_1", target: "oc_dest" })
    expect((await bus.forwardOutbound("nope", { messageId: "m", target: "t" })).error?.code).toBe(
      "adapter_not_found"
    )
    bus.registerAdapter(makeAdapter("a2"))
    expect((await bus.forwardOutbound("a2", { messageId: "m", target: "t" })).error?.code).toBe(
      "unsupported"
    )
  })

  it("pinOutbound / unpinOutbound delegate and report not-found / unsupported", async () => {
    const bus = getBus()
    const a = makeAdapter("a1") as PlatformAdapter & {
      pinMessage: jest.Mock
      unpinMessage: jest.Mock
    }
    a.pinMessage = jest.fn().mockResolvedValue(undefined)
    a.unpinMessage = jest.fn().mockResolvedValue(undefined)
    bus.registerAdapter(a)
    expect((await bus.pinOutbound("a1", "k", "pm_1")).ok).toBe(true)
    expect(a.pinMessage).toHaveBeenCalledWith("k", "pm_1")
    expect((await bus.unpinOutbound("a1", "pm_1")).ok).toBe(true)
    expect(a.unpinMessage).toHaveBeenCalledWith("pm_1")
    expect((await bus.pinOutbound("nope", "k", "m")).error?.code).toBe("adapter_not_found")
    bus.registerAdapter(makeAdapter("a2"))
    expect((await bus.pinOutbound("a2", "k", "m")).error?.code).toBe("unsupported")
    expect((await bus.unpinOutbound("a2", "m")).error?.code).toBe("unsupported")
  })

  it("sendUrgentOutbound delegates, maps a throw to platform_error, and reports unsupported", async () => {
    const bus = getBus()
    const a = makeAdapter("a1") as PlatformAdapter & { sendUrgent: jest.Mock }
    a.sendUrgent = jest.fn().mockResolvedValue(undefined)
    bus.registerAdapter(a)
    expect((await bus.sendUrgentOutbound("a1", "pm_1", ["ou_x"], "app")).ok).toBe(true)
    expect(a.sendUrgent).toHaveBeenCalledWith("pm_1", ["ou_x"], "app")
    a.sendUrgent.mockRejectedValueOnce(new Error("no scope"))
    expect((await bus.sendUrgentOutbound("a1", "pm_1", ["ou_x"])).error?.code).toBe(
      "platform_error"
    )
    bus.registerAdapter(makeAdapter("a2"))
    expect((await bus.sendUrgentOutbound("a2", "m", ["x"])).error?.code).toBe("unsupported")
  })

  it("getReadReceiptOutbound delegates and returns null when missing/unsupported", async () => {
    const bus = getBus()
    const receipt = { readers: [{ userId: "ou_x", readAt: 1 }], hasMore: false }
    const a = makeAdapter("a1") as PlatformAdapter & { getReadReceipt: jest.Mock }
    a.getReadReceipt = jest.fn().mockResolvedValue(receipt)
    bus.registerAdapter(a)
    expect(await bus.getReadReceiptOutbound("a1", "pm_1")).toEqual(receipt)
    expect(await bus.getReadReceiptOutbound("missing", "m")).toBeNull()
    bus.registerAdapter(makeAdapter("a2"))
    expect(await bus.getReadReceiptOutbound("a2", "m")).toBeNull()
  })

  it("setTypingOutbound delegates (true) and no-ops (false) when missing/unsupported", async () => {
    const bus = getBus()
    const a = makeAdapter("a1") as PlatformAdapter & { setTyping: jest.Mock }
    a.setTyping = jest.fn().mockResolvedValue(undefined)
    bus.registerAdapter(a)
    expect(await bus.setTypingOutbound("a1", "telegram:a1:42", true)).toBe(true)
    expect(a.setTyping).toHaveBeenCalledWith("telegram:a1:42", true)
    bus.registerAdapter(makeAdapter("a2")) // no setTyping
    expect(await bus.setTypingOutbound("a2", "k", true)).toBe(false)
    expect(await bus.setTypingOutbound("missing", "k", true)).toBe(false)
  })

  it("uploadFileOutbound delegates and returns ref; null when missing/unsupported", async () => {
    const bus = getBus()
    const ref = { localUrl: "file://x", remoteRef: "rr" }
    const a = makeAdapter("a1") as PlatformAdapter & { uploadFile: jest.Mock }
    a.uploadFile = jest.fn().mockResolvedValue(ref)
    bus.registerAdapter(a)
    expect(await bus.uploadFileOutbound("a1", { url: "u" })).toEqual(ref)
    expect(await bus.uploadFileOutbound("missing", { url: "u" })).toBeNull()
    bus.registerAdapter(makeAdapter("a2")) // no uploadFile
    expect(await bus.uploadFileOutbound("a2", { url: "u" })).toBeNull()
  })

  it("streamReplyOutbound delegates (true) and no-ops (false) when missing/unsupported", async () => {
    const bus = getBus()
    const a = makeAdapter("a1") as PlatformAdapter & { streamReply: jest.Mock }
    a.streamReply = jest.fn().mockResolvedValue(undefined)
    bus.registerAdapter(a)
    const req = { conversationRef: { platform: "telegram", adapterId: "a1" }, text: "partial" }
    expect(await bus.streamReplyOutbound("a1", req as never)).toBe(true)
    expect(a.streamReply).toHaveBeenCalledWith(req)
    bus.registerAdapter(makeAdapter("a2")) // no streamReply
    expect(await bus.streamReplyOutbound("a2", req as never)).toBe(false)
    expect(await bus.streamReplyOutbound("missing", req as never)).toBe(false)
  })

  it("getAdapterA2UICapability returns the adapter matrix or null", () => {
    const bus = getBus()
    const matrix = { Button: "native", Card: "simulated" }
    const a = makeAdapter("a1") as PlatformAdapter & { a2uiCapability: jest.Mock }
    a.a2uiCapability = jest.fn().mockReturnValue(matrix)
    bus.registerAdapter(a)
    expect(bus.getAdapterA2UICapability("a1")).toBe(matrix)
    expect(a.a2uiCapability).toHaveBeenCalled()
    expect(bus.getAdapterA2UICapability("missing")).toBeNull()
  })

  it("getAdapterSkillCapabilities returns the declared families, [] when undeclared, null when missing", () => {
    const bus = getBus()
    const caps = [{ family: "lark.calendar", mutations: ["read", "write"] }]
    const a = makeAdapter("a1") as PlatformAdapter & { platformSkillCapabilities: jest.Mock }
    a.platformSkillCapabilities = jest.fn().mockReturnValue(caps)
    bus.registerAdapter(a)
    expect(bus.getAdapterSkillCapabilities("a1")).toBe(caps)
    bus.registerAdapter(makeAdapter("a2")) // no platformSkillCapabilities
    expect(bus.getAdapterSkillCapabilities("a2")).toEqual([])
    expect(bus.getAdapterSkillCapabilities("missing")).toBeNull()
  })

  it("fetchHistoryAll drains the adapter stream", async () => {
    const bus = getBus()
    async function* gen(): AsyncGenerator<NormalizedInboundEvent> {
      yield makeEvent("a1", "h1")
      yield makeEvent("a1", "h2")
      yield makeEvent("a1", "h3")
    }
    const a = makeAdapter("a1") as PlatformAdapter & { fetchHistory: jest.Mock }
    a.fetchHistory = jest.fn().mockReturnValue(gen())
    bus.registerAdapter(a)
    const all = await bus.fetchHistoryAll("a1", "telegram:a1:42", {})
    expect(all.map((e) => e.messageId)).toEqual(["h1", "h2", "h3"])
  })

  it("fetchHistoryAll caps at opts.max even when the adapter over-yields", async () => {
    const bus = getBus()
    async function* gen(): AsyncGenerator<NormalizedInboundEvent> {
      for (let i = 0; i < 10; i++) yield makeEvent("a1", `h${i}`)
    }
    const a = makeAdapter("a1") as PlatformAdapter & { fetchHistory: jest.Mock }
    a.fetchHistory = jest.fn().mockReturnValue(gen())
    bus.registerAdapter(a)
    expect(await bus.fetchHistoryAll("a1", "k", { max: 2 })).toHaveLength(2)
  })

  it("fetchHistoryAll returns [] when missing or unsupported", async () => {
    const bus = getBus()
    expect(await bus.fetchHistoryAll("missing", "k", {})).toEqual([])
    bus.registerAdapter(makeAdapter("a1")) // no fetchHistory
    expect(await bus.fetchHistoryAll("a1", "k", {})).toEqual([])
  })
})

// ── passive callback observers (ctx.connectors.onCallback) ─────────────────────

function makeCallback(over: Partial<ConnectorCallbackEvent> = {}): ConnectorCallbackEvent {
  return {
    platform: "telegram",
    adapterId: "a1",
    selfId: "bot_1",
    triggerId: "trig_1",
    surfaceId: "surf_1",
    actionType: "button",
    value: "ok",
    user: { id: "u_1", platform: "telegram", adapterId: "a1", remoteUserId: "u_1" },
    timestamp: 1_700_000_000_000,
    raw: {},
    ...over,
  }
}

describe("ConnectorBus — passive callback observers", () => {
  it("notifies each resolved callback with the bound conversation key and disposes", async () => {
    const bus = getBus()
    const seen: Array<{ trigger: string; key: string | null }> = []
    const dispose = bus.subscribeCallback((e, key) => seen.push({ trigger: e.triggerId, key }))

    await bus.dispatchConnectorCallback(
      makeCallback({ triggerId: "t1", conversationKey: "telegram:a1:42" })
    )
    expect(seen).toEqual([{ trigger: "t1", key: "telegram:a1:42" }])

    dispose()
    await bus.dispatchConnectorCallback(makeCallback({ triggerId: "t2" }))
    expect(seen).toHaveLength(1) // no longer notified after dispose
  })

  it("does not notify for an unbound callback (no surface)", async () => {
    const bus = getBus()
    const seen: string[] = []
    bus.subscribeCallback((e) => seen.push(e.triggerId))
    // Empty surfaceId + binding lookup mocked to undefined → the dispatch bails
    // at the unbound check before reaching observers.
    await bus.dispatchConnectorCallback(makeCallback({ surfaceId: "", triggerId: "t3" }))
    expect(seen).toEqual([])
  })

  it("a throwing callback observer never breaks callback routing", async () => {
    const bus = getBus()
    bus.subscribeCallback(() => {
      throw new Error("cb observer boom")
    })
    await expect(bus.dispatchConnectorCallback(makeCallback())).resolves.toBeUndefined()
  })
})

describe("ConnectorBus — recordBotReply (cooldown bookkeeping)", () => {
  beforeEach(() => __resetBusForTesting())

  const cooldownEvent = (conversationKey: string) =>
    ({
      conversationKey,
      sender: { id: "u1" },
      channel: { id: "c1" },
      mentions: { selfMentioned: false, users: [] },
      plainText: "hi",
    }) as unknown as NormalizedInboundEvent

  const cooldownPolicy: TriggerPolicy = {
    rules: [],
    blockers: [{ kind: "cooldown-after-bot-reply", secs: 5 }],
    storeUnmatchedInDraftMode: false,
  }

  it("writes the last-reply timestamp the cooldown blocker reads (was never written before)", () => {
    const bus = getBus()
    const ck = "lark:lark-1:oc_chat"
    bus.recordBotReply(ck, 10_000)

    const state = bus.__getPolicyStateForTesting()
    expect(state.recentBotReplyAtByConversation[ck]).toBe(10_000)

    // Within the 5 s window → blocked; after it → allowed.
    expect(evaluatePolicy(cooldownPolicy, cooldownEvent(ck), state, 12_000).blocked).toBe(true)
    expect(evaluatePolicy(cooldownPolicy, cooldownEvent(ck), state, 20_000).blocked).toBe(false)
  })

  it("defaults the timestamp to now when omitted", () => {
    const bus = getBus()
    const before = Date.now()
    bus.recordBotReply("k")
    const at = bus.__getPolicyStateForTesting().recentBotReplyAtByConversation["k"]
    expect(at).toBeGreaterThanOrEqual(before)
  })

  it("prunes entries older than the retention window on write", () => {
    const bus = getBus()
    bus.recordBotReply("old", 0)
    // 20 min later — retention window is 10 min, so `old` is pruned.
    bus.recordBotReply("fresh", 20 * 60_000)
    const map = bus.__getPolicyStateForTesting().recentBotReplyAtByConversation
    expect(map["old"]).toBeUndefined()
    expect(map["fresh"]).toBe(20 * 60_000)
  })
})
