/**
 * Tests for ConnectorBus singleton (Task 25).
 * The runtime pipeline (Task 28) is exercised in bus.runtime.test.ts.
 */

import type { NormalizedInboundEvent, PlatformAdapter, OutboundRequest } from "@/types/connectors"
import { getBus, __resetBusForTesting } from "./bus"

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
