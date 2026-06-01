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

// The callback dispatch path touches Dexie via dedup / audit / binding lookup.
// Stub those three out so the observer wiring can be exercised in isolation —
// the existing registry / sendOutbound / dispatchInbound (Task 25) tests never
// reach these modules, so the mocks leave them untouched.
jest.mock("./dedup", () => ({
  recordAndCheckInbound: jest.fn().mockResolvedValue(true),
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
